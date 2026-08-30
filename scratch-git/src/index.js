#!/usr/bin/env node
/**
 * git-palette — a Scratch collaboration workflow tool, exposed to git as `git palette`.
 *
 * Core idea: the git object store keeps only the expanded tree of a `.sb3`
 * (`.palette/` + `roles/`); the `.sb3` itself is unpacked and consumed by the
 * pre-commit hook at commit time, acting as "currency between the editor and the repo".
 *
 * @module index
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { Command } from 'commander';
import { readSb3, writeSb3 } from './sb3.js';
import { buildTree, readTree } from './tree.js';
import { writeTree, CACHE_DIR, runExport, runEditorSync } from './hook.js';
import { sbTextForProject, snippetsToText } from './text.js';
import {
  extractDeps,
  renderDeps,
  parseDeps,
  applyDepsToJson,
  lockEntry,
  readDepsFile,
} from './deps.js';
import { parseExtension, serializeSnapshot } from 'scratch-sandbox';
import { resolveExtensions, registerCachedExtensions } from 'extension-git';
import {
  repoRoot,
  setConfig,
  ensureLine,
  stripSb3Ext,
  stripTrailingSlash,
  git,
  addPaths,
  isFile,
} from './git.js';

const PROGRAM_NAME = 'git-palette';
const VERSION = '0.1.0';
const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS_DIR = path.join(PKG_ROOT, 'hooks');
const DEPS_FILE = '.scratchdeps';

const program = new Command();

program
  .name(PROGRAM_NAME)
  .description(
    'Unpack a .sb3 project into a collab-friendly git tree (.palette/ + roles/); a hook converts it automatically on commit.',
  )
  .version(VERSION);

program
  .command('install')
  .description('Install the pre-commit hook and configure .gitignore (/scratch4js/, *.sb3)')
  .action(async (opts) => {
    await setConfig('core.hooksPath', HOOKS_DIR);
    const ignore = path.join(await repoRoot(), '.gitignore');
    const lines = ['/scratch4js/', '*.sb3', 'node_modules/'];
    const wrote = [];
    for (const line of lines) {
      if (await ensureLine(ignore, line)) wrote.push(line);
    }
    process.stderr.write(
      `git-palette: installed hook → ${HOOKS_DIR}\n` +
        (wrote.length
          ? `git-palette: added to ${ignore}:\n${wrote.map((l) => `  ${l}`).join('\n')}\n`
          : `git-palette: ${ignore} already up to date\n`) +
        `Now 'git add -f game.sb3 && git commit' auto-unpacks the sb3 into the tree.\n` +
        `(*.sb3 is gitignored; stage it explicitly with -f when importing.)\n`,
    );
  });

program
  .command('init')
  .description('Scaffold a palette repo in the current directory (.palette/, README.md, .scratchdeps)')
  .argument('[name]', 'project name (defaults to the repo directory name)')
  .action(async (name, opts) => {
    const root = await repoRoot();
    const metaName = name || path.basename(root);
    const files = [
      {
        rel: '.palette/type.json',
        content: JSON.stringify({ type: 'project' }) + '\n',
      },
      {
        rel: '.palette/meta.json',
        content:
          JSON.stringify(
            { name: metaName, importedAt: new Date().toISOString(), tool: PROGRAM_NAME },
            null,
            2,
          ) + '\n',
      },
      {
        rel: DEPS_FILE,
        content: `# dependency declarations (extension version locking)\n# managed via 'git palette deps'\n`,
      },
      {
        rel: 'README.md',
        content: `# ${metaName}\n\nA Scratch project managed by git-palette.\n\n- Import a project with 'git palette import <file.sb3>'.\n- Export an sb3 for the editor with 'git palette export'.\n`,
      },
    ];
    await writeTree(root, files);
    const ignore = path.join(root, '.gitignore');
    const addedIgnore = [];
    for (const line of ['*.sb3', '/scratch4js/', 'node_modules/']) {
      if (await ensureLine(ignore, line)) addedIgnore.push(line);
    }
    process.stderr.write(
      `git-palette: initialized palette tree at ${root}/\n` +
        (addedIgnore.length
          ? `git-palette: .gitignore: ${addedIgnore.join(', ')}\n`
          : '') +
        `  Next: git palette import <file.sb3>\n`,
    );
  });

program
  .command('import')
  .description('Unpack a .sb3 into the palette tree (the hook, done manually without committing)')
  .argument('<file.sb3>', 'the sb3 file to import')
  .option('--root <dir>', 'target repo root (defaults to the current git repo root)')
  .action(async (file, opts) => {
    const root = opts.root || (await repoRoot());
    const { json, assets } = await readSb3(file);
    const paletteDir = path.join(root, '.palette');
    const { resolvedById, warnings } = await resolveExtensions(json, { paletteDir });
    for (const w of warnings) process.stderr.write(`git-palette: warning: ${w}\n`);
    const { targets: sbSnippets, positions } = await sbTextForProject(json, { language: 'en' });
    const files = buildTree(json, assets, {
      name: stripSb3Ext(path.basename(file)),
      source: file,
      depsText,
      sbSnippets,
      positions,
    });
    await writeTree(root, files);
    const assetsDone = files.filter((f) => f.content instanceof Uint8Array).length;
    process.stderr.write(
      `git-palette: imported ${file} → ${root}/ (${json.targets.length} target(s), ` +
        `${assetsDone} asset(s))\n` +
        `You can now git add these files and commit.\n`,
    );
  });

program
  .command('export')
  .description('Pack the palette tree back into a .sb3 (project.json is authoritative + assets + extension injection)')
  .option('-o, --out <file.sb3>', 'output path (defaults to <project name>.sb3)')
  .option('--root <dir>', 'tree directory (defaults to the current git repo root)')
  .action(async (opts) => {
    const root = opts.root || (await repoRoot());
    const { outPath, warnings } = await runExport(root, { out: opts.out });
    for (const w of warnings) process.stderr.write(`git-palette: warning: ${w}\n`);
    process.stderr.write(
      `git-palette: exported ${outPath} (extensions injected from .scratchdeps)\n`,
    );
  });

program
  .command('deps')
  .description('Manage extension dependencies (.scratchdeps)')
  .argument('<list|lock>', 'list: show; lock: compute/lock sha256 and cache the js')
  .option('--root <dir>', 'tree directory (defaults to the current git repo root)')
  .action(async (action, opts) => {
    const root = opts.root || (await repoRoot());
    const text = await readDepsFile(root);
    const { entries, comments } = parseDeps(text);

    if (action === 'list') {
      const lines = entries.map((e) => {
        const lock = e.sha256 ? ` sha256:${e.sha256.slice(0, 12)}…` : '';
        return `  ${e.id}: ${e.spec}${lock}`;
      });
      process.stderr.write(
        `git-palette: ${entries.length} extension(s)\n${lines.join('\n') || '  (none)'}\n`,
      );
      return;
    }

    const cacheDir = path.join(root, '.palette', CACHE_DIR);
    const results = [];
    for (const e of entries) {
      if (e.spec === 'builtin') continue;
      results.push(await lockEntry(e, cacheDir));
    }
    if (!entries.some((e) => e.spec !== 'builtin')) {
      process.stderr.write(`git-palette: no custom extensions to lock.\n`);
      return;
    }
    const depsPath = path.join(root, DEPS_FILE);
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = path;
    await mkdir(dirname(depsPath), { recursive: true });
    await writeFile(depsPath, renderDeps(entries, comments));
    for (const r of results) process.stderr.write(`git-palette: ${r.message}\n`);
    process.stderr.write(`git-palette: updated ${depsPath}\n`);
  });

program
  .command('extmeta')
  .description('Parse extension JS (scratch-sandbox) into a .palette/extensions/<id>.json block-metadata snapshot')
  .option('--root <dir>', 'tree directory (defaults to the current git repo root)')
  .action(async (opts) => {
    const root = opts.root || (await repoRoot());
    const { entries } = parseDeps(await readDepsFile(root));
    const cacheDir = path.join(root, '.palette', CACHE_DIR);
    const extDir = path.join(root, '.palette', 'extensions');
    const { mkdir, readFile, writeFile } = await import('node:fs/promises');
    await mkdir(extDir, { recursive: true });
    const results = [];
    for (const e of entries) {
      if (e.spec === 'builtin') {
        results.push(`${e.id}: builtin — skipped`);
        continue;
      }
      const jsPath = path.join(cacheDir, `${e.id}.js`);
      let source;
      try {
        source = await readFile(jsPath, 'utf8');
      } catch {
        results.push(`${e.id}: no cached js (run 'git palette deps lock' first)`);
        continue;
      }
      const result = await parseExtension(source, {
        url: e.spec,
        cacheDir,
        unsandboxed: true,
      });
      if (!result.ok) {
        results.push(
          `${e.id}: parse failed — ${result.errors.map((x) => x.message).join('; ')}`,
        );
        continue;
      }
      await writeFile(path.join(extDir, `${e.id}.json`), serializeSnapshot(result));
      results.push(`${e.id}: ${result.blockInfo.length} blocks → extensions/${e.id}.json`);
    }
    for (const r of results) process.stderr.write(`git-palette: ${r}\n`);
  });

/* ------------------------------------------------------------------ git flow */

/**
 * List working-tree `.sb3` files that git ignores (the editor-facing files).
 *
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function ignoredSb3s(root) {
  const out = await git(
    ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', '*.sb3'],
    { cwd: root },
  ).catch(() => '');
  return String(out)
    .split('\0')
    .filter(Boolean);
}

/**
 * Compare one working-tree `.sb3` against the committed palette tree and report
 * which files would differ.
 *
 * @param {string} root
 * @param {string} sb3
 */
async function statusOne(root, sb3) {
  const { json, assets } = await readSb3(sb3);
  await registerCachedExtensions(path.join(root, '.palette'));
  const { targets: snippets, positions } = await sbTextForProject(json, { language: 'en' });
  const files = buildTree(json, assets, {
    name: stripSb3Ext(path.basename(sb3)),
    source: sb3,
    depsText: renderDeps(extractDeps(json)),
    sbSnippets: snippets,
    positions,
  });
  const hasTree = await isFile(path.join(root, '.palette', 'project.json'));
  if (!hasTree) {
    process.stderr.write(`git-palette: ${sb3}: not imported yet (no tree in the repo)\n`);
    return;
  }
  const hasHead = await git(['rev-parse', '--verify', 'HEAD'], { cwd: root }).then(
    () => true,
    () => false,
  );
  if (!hasHead) {
    process.stderr.write(`git-palette: ${sb3}: tree not committed yet (run 'git palette commit')\n`);
    return;
  }
  const diffs = [];
  for (const f of files) {
    if (f.rel === '.palette/meta.json') continue; // advisory, non-deterministic timestamp
    let head;
    try {
      head = await git(['show', `HEAD:${f.rel}`], {
        cwd: root,
        encoding: 'buffer',
      });
    } catch {
      head = null;
    }
    const same =
      head != null &&
      (typeof f.content === 'string'
        ? head.toString('utf8') === f.content
        : head.equals(Buffer.from(f.content)));
    if (!same) diffs.push(f.rel);
  }
  if (!diffs.length)
    process.stderr.write(`git-palette: ${sb3}: in sync with the committed tree\n`);
  else
    process.stderr.write(
      `git-palette: ${sb3}: ${diffs.length} file(s) differ from the committed tree:\n  ` +
        diffs.slice(0, 30).join('\n  ') +
        '\n',
    );
}

/**
 * Render a `.sb3`'s scripts to a temp dir of `<target>.sb` text files, for
 * `git diff --no-index` comparison.
 *
 * @param {string} sb3
 * @returns {Promise<string>}
 */
async function renderSb3ToTemp(sb3) {
  const { json } = await readSb3(sb3);
  const root = await repoRoot();
  await registerCachedExtensions(path.join(root, '.palette'));
  const snippets = await sbTextForProject(json, { language: 'en' });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palette-diff-'));
  for (const [name, snip] of Object.entries(snippets)) {
    await fs.writeFile(path.join(dir, `${name}.sb`), snippetsToText(snip));
  }
  return dir;
}

program
  .command('commit')
  .description('Stage a .sb3 and commit (the pre-commit hook auto-unpacks it into the tree)')
  .argument('[sb3...]', 'the .sb3 to commit (gitignored, so it must be force-staged)')
  .option('-m, --message <msg>', 'commit message')
  .option('--root <dir>', 'repo root')
  .action(async (sb3s, opts) => {
    const root = opts.root || (await repoRoot());
    if (sb3s && sb3s.length) {
      await git(['add', '-f', '--', ...sb3s], { cwd: root });
    } else {
      await git(['add', '-f', '--', '*.sb3'], { cwd: root }).catch(() => {});
    }
    const args = ['commit'];
    if (opts.message) args.push('-m', opts.message);
    await git(args, { cwd: root });
    process.stderr.write('git-palette: committed (hook unpacked the .sb3 into the tree)\n');
  });

program
  .command('status')
  .description('Check whether the working-tree .sb3 is in sync with the committed tree')
  .option('--root <dir>')
  .action(async (opts) => {
    const root = opts.root || (await repoRoot());
    const sb3s = await ignoredSb3s(root);
    if (!sb3s.length) {
      process.stderr.write('git-palette: no working-tree .sb3 found\n');
      return;
    }
    for (const sb3 of sb3s) await statusOne(root, sb3);
  });

program
  .command('editor-sync')
  .description('Regenerate the editor-facing .sb3 from the tree after checkout/merge (called by post-checkout/post-merge)')
  .option('--root <dir>')
  .action(async (opts) => {
    await runEditorSync({ cwd: opts.root });
  });

program
  .command('diff')
  .description('Compare the scratchblocks text of two .sb3 files; with no args, show the working-tree diff of the tree')
  .argument('[a]', 'first .sb3')
  .argument('[b]', 'second .sb3')
  .option('--root <dir>')
  .action(async (a, b, opts) => {
    const root = opts.root || (await repoRoot());
    const { execFile } = await import('node:child_process');
    if (a && b) {
      const da = await renderSb3ToTemp(a);
      const db = await renderSb3ToTemp(b);
      await new Promise((res) => {
        execFile(
          'git',
          ['diff', '--no-index', '--', da, db],
          { maxBuffer: 64 * 1024 * 1024 },
          (err, stdout) => {
            process.stdout.write(stdout);
            res();
          },
        );
      });
    } else {
      // git diff exits 1 when there are differences; always print stdout.
      await new Promise((res) => {
        execFile(
          'git',
          ['diff', '--', 'roles/', '.palette/project.json', '.palette/assets.json', '.scratchdeps'],
          { cwd: root, maxBuffer: 64 * 1024 * 1024 },
          (err, stdout) => {
            process.stdout.write(stdout);
            res();
          },
        );
      });
    }
  });

program
  .command('conflicts')
  .description('List unresolved merge conflicts in the palette tree (categorized as text/binary)')
  .option('--root <dir>')
  .action(async (opts) => {
    const root = opts.root || (await repoRoot());
    const out = await git(['diff', '--name-only', '--diff-filter=U', '-z'], {
      cwd: root,
    });
    const files = String(out)
      .split('\0')
      .filter(Boolean)
      .filter((p) => /^(roles\/|\.palette\/|\.scratchdeps)/.test(p));
    if (!files.length) {
      process.stderr.write('git-palette: no unresolved palette conflicts\n');
      return;
    }
    for (const f of files) {
      const bin = /\.(svg|png|jpe?g|bmp|gif|wav|mp3)$/i.test(f);
      process.stderr.write(`git-palette: ${bin ? 'binary ' : 'text   '}${f}\n`);
    }
    process.stderr.write(
      'Hint: resolve text conflicts by editing directly; binary conflicts with "git palette resolve --ours|--theirs <file>"\n',
    );
  });

program
  .command('resolve')
  .description('Resolve a binary asset conflict: check out ours/theirs and git add')
  .argument('<file>', 'conflicting file path')
  .option('--ours', 'keep the current branch version')
  .option('--theirs', 'keep the merged-in version')
  .option('--root <dir>')
  .action(async (file, opts) => {
    const root = opts.root || (await repoRoot());
    const side = opts.theirs ? '--theirs' : '--ours';
    await git(['checkout', side, '--', file], { cwd: root });
    await git(['add', '--', file], { cwd: root });
    process.stderr.write(
      `git-palette: resolved ${file} using ${opts.theirs ? 'theirs' : 'ours'} and staged it\n`,
    );
  });

/* ------------------------------------------------------------------ helpers */

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`git-palette: ${err.message}\n`);
  process.exit(1);
});