import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeSb3Data, loadSb3 } from '../src/sb3.js';
import { readTree } from '../src/tree.js';

const require = createRequire(import.meta.url);
const JSZip = require('@turbowarp/jszip');

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`$ ${cmd} ${args.join(' ')}\n${stderr || err.message}`));
      else resolve(String(stdout));
    });
  });
}

/** Content byte set `n`; md5ext matches its real content hash. */
const bytes = (n) => new Uint8Array([n, n, n]);
const md5ext = (b, ext) => createHash('md5').update(b).digest('hex') + '.' + ext;

const BACKDROP = md5ext(bytes(1), 'svg');
const COSTUME = md5ext(bytes(2), 'svg');
const HAT = md5ext(bytes(5), 'svg');
const JUMP = md5ext(bytes(4), 'wav');

/** A project with a stage, a sprite with a costume + sound, and an extension. */
function projectJson() {
  return {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        costumes: [
          {
            assetId: 'a1',
            name: 'backdrop1',
            bitmapResolution: 1,
            md5ext: BACKDROP,
            dataFormat: 'svg',
            rotationCenterX: 240,
            rotationCenterY: 180,
          },
        ],
        sounds: [],
        layerOrder: 0,
      },
      {
        isStage: false,
        name: 'Cat',
        variables: { 'v:cat:score': ['score', 3] },
        lists: {},
        broadcasts: {},
        blocks: {
          hat: {
            opcode: 'event_whenflagclicked',
            next: 'mv',
            parent: null,
            inputs: {},
            fields: {},
            shadow: false,
            topLevel: true,
            x: 0,
            y: 0,
          },
          mv: {
            opcode: 'motion_movesteps',
            next: null,
            parent: 'hat',
            inputs: { STEPS: [1, [4, '10']] },
            fields: {},
            shadow: false,
            topLevel: false,
          },
        },
        costumes: [
          {
            assetId: 'c1',
            name: 'costume1',
            bitmapResolution: 1,
            md5ext: COSTUME,
            dataFormat: 'svg',
            rotationCenterX: 48,
            rotationCenterY: 50,
          },
        ],
        sounds: [
          {
            assetId: 's1',
            name: 'jump',
            md5ext: JUMP,
            dataFormat: 'wav',
            rate: 44100,
            sampleCount: 100,
          },
        ],
        layerOrder: 1,
      },
    ],
    monitors: [],
    extensions: ['pen'],
    meta: { semver: '3.0.0', vm: '0.2.0', agent: 'git-palette-e2e' },
  };
}

const assets = new Map([
  [BACKDROP, bytes(1)],
  [COSTUME, bytes(2)],
  [JUMP, bytes(4)],
]);

test('e2e: committing an sb3 stores the palette tree, not the zip', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'git-palette-e2e-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });

  // install wires core.hooksPath → real hooks dir + writes .gitignore.
  await run('node', [path.join(PKG_ROOT, 'src/index.js'), 'install'], { cwd: repo });
  await run('git', ['add', '.gitignore'], { cwd: repo });
  await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'chore'], { cwd: repo });

  const sb3Bytes = await writeSb3Data(projectJson(), assets);
  const sb3Path = path.join(repo, 'game.sb3');
  await fs.writeFile(sb3Path, sb3Bytes);

  await run('git', ['add', '-f', 'game.sb3'], { cwd: repo });
  await run(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'import'],
    { cwd: repo },
  );

  // The committed tree: no .sb3, palette tree present.
  const files = (await run('git', ['-c', 'core.quotePath=false', 'ls-files'], { cwd: repo }))
    .split('\n')
    .filter(Boolean)
    .sort();
  assert.ok(!files.includes('game.sb3'), '.sb3 must not be committed');
  assert.ok(files.includes('.palette/project.json'));
  assert.ok(files.includes('.palette/assets.json'));
  assert.ok(files.includes('.palette/type.json'));
  assert.ok(files.includes('roles/stage/stage.sb'));
  assert.ok(files.includes('roles/stage/costumes/backdrop1.svg'));
  assert.ok(files.includes('roles/Cat/Cat.sb'));
  assert.ok(files.includes('roles/Cat/costumes/costume1.svg'));
  assert.ok(files.includes('roles/Cat/sounds/jump.wav'));
  assert.ok(files.includes('.scratchdeps'));

  // The .sb files are readable scratchblocks text in git.
  const sbText = await run('git', ['-c', 'core.quotePath=false', 'show', 'HEAD:roles/Cat/Cat.sb'], { cwd: repo });
  assert.match(sbText, /^when @greenFlag clicked$/m);
  assert.match(sbText, /^move \(10\) steps$/m);
  assert.ok(!sbText.includes('#'), '.sb must be blocks only');

  // The tree exports back to an equivalent sb3 (json + asset bytes).
  const { json, assets: treeAssets } = await readTree(repo);
  const back = await writeSb3Data(json, treeAssets);
  const { json: reJson, assets: reAssets } = await loadSb3(back);
  assert.deepEqual(reJson, projectJson());
  assert.deepEqual(
    [...reAssets.get(JUMP)],
    [4, 4, 4],
  );

  // Second commit with no changes: nothing to do, still clean tree.
  const status = await run('git', ['status', '--porcelain'], { cwd: repo });
  assert.equal(status.trim(), '');
});

test('e2e: a second import replaces the tree (edited project)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'git-palette-e2e2-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await run('node', [path.join(PKG_ROOT, 'src/index.js'), 'install'], { cwd: repo });

  const orig = projectJson();
  await fs.writeFile(path.join(repo, 'game.sb3'), await writeSb3Data(orig, assets));
  await run('git', ['add', '-f', 'game.sb3'], { cwd: repo });
  await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'v1'], { cwd: repo });

  // Edit: new steps value, costume replaced by a new one.
  const v2 = structuredClone(orig);
  v2.targets[1].blocks.mv.inputs.STEPS = [1, [4, '25']];
  v2.targets[1].costumes = [
    {
      assetId: 'c2',
      name: 'hat',
      bitmapResolution: 1,
      md5ext: HAT,
      dataFormat: 'svg',
      rotationCenterX: 48,
      rotationCenterY: 50,
    },
  ];
  const v2Assets = new Map(assets);
  v2Assets.set(HAT, bytes(5));

  await fs.writeFile(path.join(repo, 'game.sb3'), await writeSb3Data(v2, v2Assets));
  await run('git', ['add', '-f', 'game.sb3'], { cwd: repo });
  await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'v2'], { cwd: repo });

  const files = (await run('git', ['-c', 'core.quotePath=false', 'ls-files'], { cwd: repo })).split('\n').filter(Boolean);
  // Stale asset dropped, new one added.
  assert.ok(!files.includes('roles/Cat/costumes/costume1.svg'));
  assert.ok(files.includes('roles/Cat/costumes/hat.svg'));
  assert.ok(
    (await run('git', ['-c', 'core.quotePath=false', 'show', 'HEAD:roles/Cat/Cat.sb'], { cwd: repo })).includes(
      'move (25) steps',
    ),
  );
});

test('loadSb3: rejects a zip without project.json', async () => {
  const zip = new JSZip();
  zip.file('x.txt', 'nope');
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  await assert.rejects(() => loadSb3(bytes), /project\.json is missing/);
});

/** Like run() but returns stderr (where git-palette writes user messages). */
function runErr(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`$ ${cmd} ${args.join(' ')}\n${stderr || err.message}`));
      else resolve(stderr ? String(stderr) : String(stdout));
    });
  });
}

/** Build a committed palette repo from projectJson() (mirrors the e2e setup). */
async function committedRepo() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'git-palette-flow-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await run('node', [path.join(PKG_ROOT, 'src/index.js'), 'install'], { cwd: repo });
  await run('git', ['add', '.gitignore'], { cwd: repo });
  await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'chore'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'game.sb3'), await writeSb3Data(projectJson(), assets));
  await run('git', ['add', '-f', 'game.sb3'], { cwd: repo });
  await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'import'], { cwd: repo });
  return repo;
}

test('git-flow: export packs the committed tree back into an equivalent sb3', async () => {
  const repo = await committedRepo();
  const out = path.join(repo, 'regen.sb3');
  await run('node', [path.join(PKG_ROOT, 'src/index.js'), 'export', '--out', out], { cwd: repo });
  const { json } = await loadSb3(await fs.readFile(out));
  assert.deepEqual(json, projectJson());
});

test('git-flow: status reports sync for a clean committed tree', async () => {
  const repo = await committedRepo();
  const out = await runErr('node', [path.join(PKG_ROOT, 'src/index.js'), 'status'], { cwd: repo });
  assert.match(out, /in sync with the committed tree/);
});

test('git-flow: status flags a divergent working .sb3', async () => {
  const repo = await committedRepo();
  // Edit the source .sb3 (the gitignored editor file) and re-derive a tree.
  const edited = structuredClone(projectJson());
  edited.targets[1].blocks.mv.inputs.STEPS = [1, [4, '99']];
  await fs.writeFile(path.join(repo, 'game.sb3'), await writeSb3Data(edited, assets));
  const out = await runErr('node', [path.join(PKG_ROOT, 'src/index.js'), 'status'], { cwd: repo });
  assert.match(out, /differ from the committed tree/);
  assert.match(out, /roles\/Cat\/Cat\.sb/);
});

test('git-flow: editor-sync regenerates the gitignored .sb3', async () => {
  const repo = await committedRepo();
  await fs.rm(path.join(repo, 'game.sb3'));
  await run('node', [path.join(PKG_ROOT, 'src/index.js'), 'editor-sync'], { cwd: repo });
  const regen = path.join(repo, 'game.sb3');
  assert.ok(await isFileSafe(regen), '.sb3 must be regenerated by editor-sync');
  const { json } = await loadSb3(await fs.readFile(regen));
  assert.deepEqual(json, projectJson());
});

test('git-flow: conflicts lists a text conflict and resolve clears it', async () => {
  const repo = await committedRepo();
  await run('git', ['checkout', '-q', '-b', 'A'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'roles/stage/stage.sb'), 'when green flag clicked\nsay [A-branch]\n');
  await run('git', ['add', '-A'], { cwd: repo });
  await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'A'], { cwd: repo });
  await run('git', ['checkout', '-q', 'main'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'roles/stage/stage.sb'), 'when green flag clicked\nsay [main-branch]\n');
  await run('git', ['add', '-A'], { cwd: repo });
  await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'main'], { cwd: repo });
  await run('git', ['merge', '--no-edit', 'A'], { cwd: repo }).catch(() => {});

  const listed = await runErr('node', [path.join(PKG_ROOT, 'src/index.js'), 'conflicts'], { cwd: repo });
  assert.match(listed, /roles\/stage\/stage\.sb/);
  assert.match(listed, /text/);

  await run('node', [path.join(PKG_ROOT, 'src/index.js'), 'resolve', 'roles/stage/stage.sb', '--ours'], { cwd: repo });
  const after = await runErr('node', [path.join(PKG_ROOT, 'src/index.js'), 'conflicts'], { cwd: repo });
  assert.match(after, /no unresolved/);
});

async function isFileSafe(p) {
  try {
    const s = await fs.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

test('git-flow: diff prints the tree text delta between working tree and HEAD', async () => {
  const repo = await committedRepo();
  await fs.writeFile(path.join(repo, 'roles/Cat/Cat.sb'), 'when green flag clicked\nmove (77) steps\n');
  const out = await run(
    'node',
    [path.join(PKG_ROOT, 'src/index.js'), 'diff'],
    { cwd: repo },
  ).catch((e) => e.message);
  // run() rejects on non-zero (git diff exits 1 with changes); the message
  // embeds stdout after the command line.
  assert.match(out, /move \(77\) steps/);
  assert.match(out, /roles\//);
});