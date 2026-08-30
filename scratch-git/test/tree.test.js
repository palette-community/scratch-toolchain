import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadSb3, writeSb3Data } from '../src/sb3.js';
import { buildTree, readTree, ROLES_DIR, PALETTE_DIR } from '../src/tree.js';
import { sbTextForProject, snippetsToText } from '../src/text.js';

const require = createRequire(import.meta.url);
const JSZip = require('@turbowarp/jszip');

/** Content byte set `n`; md5ext matches its real content hash. */
const bytes = (n) => new Uint8Array([n, n, n]);
const md5ext = (b, ext) => createHash('md5').update(b).digest('hex') + '.' + ext;

const BACKDROP = md5ext(bytes(1), 'svg');
const COSTUME = md5ext(bytes(2), 'svg');
const COSTUME2 = md5ext(bytes(3), 'svg');
const JUMP = md5ext(bytes(4), 'wav');

/** Build a project.json with a stage + one scripted sprite. */
function sampleProject({ dupCostumes = false } = {}) {
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
        variables: { 'v:cat:score': ['score', 0] },
        lists: {},
        broadcasts: { 'b:jump': ['jump'] },
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
        costumes: dupCostumes
          ? [
              {
                assetId: 'c1',
                name: 'costume1',
                bitmapResolution: 1,
                md5ext: COSTUME,
                dataFormat: 'svg',
                rotationCenterX: 48,
                rotationCenterY: 50,
              },
              {
                assetId: 'c2',
                name: 'costume1',
                bitmapResolution: 1,
                md5ext: COSTUME2,
                dataFormat: 'svg',
                rotationCenterX: 48,
                rotationCenterY: 50,
              },
            ]
          : [
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
            sampleCount: 200,
          },
        ],
        layerOrder: 1,
      },
    ],
    monitors: [],
    extensions: ['pen'],
    meta: { semver: '3.0.0', vm: '0.2.0', agent: 'git-palette-test' },
  };
}

function sampleAssets() {
  return new Map([
    [BACKDROP, bytes(1)],
    [COSTUME, bytes(2)],
    [COSTUME2, bytes(3)],
    [JUMP, bytes(4)],
  ]);
}

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'git-palette-test-'));
}

/** Write files (from buildTree) into a directory. */
async function writeFiles(dir, files) {
  for (const f of files) {
    const target = path.join(dir, f.rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, f.content);
  }
}

test('buildTree: tree layout matches the palette contract', () => {
  const files = buildTree(sampleProject(), sampleAssets(), { depsText: 'pen: builtin\n' });
  const rels = files.map((f) => f.rel).sort();
  assert.ok(rels.includes(`${PALETTE_DIR}/type.json`));
  assert.ok(rels.includes(`${PALETTE_DIR}/project.json`));
  assert.ok(rels.includes(`${PALETTE_DIR}/assets.json`));
  assert.ok(rels.includes(`${ROLES_DIR}/stage/stage.sb`));
  assert.ok(rels.includes(`${ROLES_DIR}/stage/costumes/backdrop1.svg`));
  assert.ok(rels.includes(`${ROLES_DIR}/Cat/Cat.sb`));
  assert.ok(rels.includes(`${ROLES_DIR}/Cat/costumes/costume1.svg`));
  assert.ok(rels.includes(`${ROLES_DIR}/Cat/sounds/jump.wav`));
  assert.ok(rels.includes('.scratchdeps'));
});

test('buildTree: duplicate costume names get -2 disambiguation', () => {
  const files = buildTree(
    sampleProject({ dupCostumes: true }),
    sampleAssets(),
  );
  const names = files
    .filter((f) => f.rel.startsWith(`${ROLES_DIR}/Cat/costumes/`))
    .map((f) => f.rel);
  assert.deepEqual(names.sort(), [
    `${ROLES_DIR}/Cat/costumes/costume1-2.svg`,
    `${ROLES_DIR}/Cat/costumes/costume1.svg`,
  ]);
});

test('buildTree: stage assets live under costumes (not backdrops)', () => {
  const files = buildTree(sampleProject(), sampleAssets());
  assert.ok(files.some((f) => f.rel === `${ROLES_DIR}/stage/costumes/backdrop1.svg`));
  assert.ok(!files.some((f) => /[一-鿿]/.test(f.rel)));
});

test('sb text: scripts only — no headings, stable order', async () => {
  const project = sampleProject();
  const snippets = await sbTextForProject(project, { language: 'en' });
  const text = snippetsToText(snippets.Cat);
  assert.equal(text.includes('#'), false, '.sb must not contain headings');
  assert.equal(text.includes('variables'), false, '.sb must not contain sections');
  assert.match(text, /^when @greenFlag clicked\nmove \(10\) steps\n$/);
});

test('roundtrip: tree → sb3 → tree preserves JSON and assets', async () => {
  const dir = await tmpDir();
  const json = sampleProject();
  const assets = sampleAssets();
  const files = buildTree(json, assets, { depsText: 'pen: builtin\n' });
  await writeFiles(dir, files);

  const { json: treeJson, assets: treeAssets, warnings } = await readTree(dir);
  assert.equal(warnings.length, 0);

  // tree is a valid sb3 source: rezip it.
  const zipBytes = await writeSb3Data(treeJson, treeAssets);
  const { json: reJson, assets: reAssets } = await loadSb3(zipBytes);

  assert.equal(reJson.targets.length, 2);
  assert.equal(reJson.targets[1].blocks.mv.inputs.STEPS[1][1], '10');
  assert.deepEqual([...reAssets.get(COSTUME)], [2, 2, 2]);
  assert.deepEqual([...reAssets.get(JUMP)], [4, 4, 4]);
});

test('roundtrip: project.json keeps order; extensions survive', async () => {
  const dir = await tmpDir();
  const files = buildTree(sampleProject(), sampleAssets());
  await writeFiles(dir, files);
  const raw = await fs.readFile(path.join(dir, '.palette/project.json'), 'utf8');
  assert.ok(
    raw.indexOf('"isStage"') < raw.indexOf('"name"'),
    'key order of first target preserved',
  );

  const { json } = await readTree(dir);
  assert.deepEqual(json.extensions, ['pen']);
});

test('readTree: content mismatch (md5 check) is rejected', async () => {
  const dir = await tmpDir();
  await writeFiles(dir, buildTree(sampleProject(), sampleAssets()));
  const tampered = path.join(
    dir,
    ROLES_DIR,
    'Cat',
    'costumes',
    'costume1.svg',
  );
  await fs.writeFile(tampered, new Uint8Array([9, 9, 9]));
  await assert.rejects(() => readTree(dir), /Content mismatch/);
});

test('readTree: missing referenced asset is rejected', async () => {
  const dir = await tmpDir();
  await writeFiles(dir, buildTree(sampleProject(), sampleAssets()));
  await fs.rm(path.join(dir, ROLES_DIR, 'Cat', 'sounds', 'jump.wav'));
  await assert.rejects(() => readTree(dir), /Missing asset file/);
});

test('readTree: warns on unreferenced tree files', async () => {
  const dir = await tmpDir();
  await writeFiles(dir, buildTree(sampleProject(), sampleAssets()));
  await fs.writeFile(
    path.join(dir, ROLES_DIR, 'Cat', 'costumes', 'stray.png'),
    'x',
  );
  const { warnings } = await readTree(dir);
  assert.ok(warnings.some((w) => w.includes('stray.png')));
});