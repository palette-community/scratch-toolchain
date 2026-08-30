/**
 * pre-commit hook main procedure: turn staged `.sb3` files into the palette
 * tree before they reach the object database.
 *
 * Flow: find staged `*.sb3` → read each from the **index** (not the working
 * tree) → unpack to the palette tree at the repo root → `git rm --cached`
 * the sb3 and `git add` the tree. A failure aborts the commit.
 *
 * @module hook
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadSb3, writeSb3 } from './sb3.js';
import { buildTree, readTree, PALETTE_DIR, ROLES_DIR } from './tree.js';
import { sbTextForProject } from './text.js';
import { extractDeps, renderDeps, parseDeps, applyDepsToJson, readDepsFile } from './deps.js';
import { resolveExtensions } from 'extension-git';
import { repackProject } from './repack.js';
import {
  repoRoot,
  stagedFiles,
  stagedBlob,
  rmCached,
  addPaths,
  isFile,
  git,
} from './git.js';

/** Cache dir kept across rebuilds (holds locked extension downloads). */
export const CACHE_DIR = 'cache';

/**
 * Tree rebuild summary for one sb3.
 *
 * @typedef {object} ImportReport
 * @property {string} sb3 - Staged path that was unpacked.
 * @property {number} targets - Number of targets unpacked.
 * @property {number} assetFiles - Number of asset files written.
 * @property {number} textFiles - Number of text files written.
 */

/**
 * Run the pre-commit transformation for the current repo.
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {Promise<ImportReport[]>}
 */
export async function runPreCommit({ cwd } = {}) {
  const root = await repoRoot(cwd);
  const sb3s = await stagedFiles('*.sb3', { cwd });
  const reports = [];

  for (const rel of sb3s) {
    const bytes = await stagedBlob(rel, { cwd });
    const { json, assets } = await loadSb3(bytes);
    const paletteDir = path.join(root, PALETTE_DIR);
    const { resolvedById, warnings } = await resolveExtensions(json, { paletteDir });
    for (const w of warnings) process.stderr.write(`git-palette: warning: ${w}\n`);
    const depsText = renderDeps(extractDeps(json, resolvedById));
    const { targets: sbSnippets, positions } = await sbTextForProject(json, { language: 'en' });
    const files = buildTree(json, assets, {
      name: path.basename(rel).replace(/\.sb3$/i, ''),
      source: rel,
      depsText,
      sbSnippets,
      positions,
    });
    await writeTree(root, files);
    const assetFiles = files.filter(
      (f) => Buffer.isBuffer(f.content) || f.content instanceof Uint8Array,
    ).length;
    const textFiles = files.length - assetFiles;
    reports.push({ sb3: rel, targets: (json.targets || []).length, assetFiles, textFiles });
    process.stderr.write(
      `git-palette: unpacked ${rel}: ${json.targets?.length ?? 0} target(s), ${assetFiles} asset(s), ${textFiles} text file(s)\n`,
    );
  }

  if (sb3s.length) {
    await rmCached(sb3s, { cwd });
    await addPaths([PALETTE_DIR, ROLES_DIR, '.scratchdeps'], { cwd });
    process.stderr.write(
      `git-palette: unpacked ${sb3s.length} .sb3 file(s) into the tree (removed the staged .sb3)\n`,
    );
  } else {
    process.stderr.write('git-palette: no .sb3 staged, skipping unpack\n');
  }
  return reports;
}

/**
 * Atomically replace the palette tree on disk. The generated tree is fully
 * derived from the sb3, so old roles/ and .palette/ contents are rebuilt;
 * `.palette/cache/` (locked extension downloads) is preserved across rebuilds.
 *
 * @param {string} root - Repo root.
 * @param {import('./tree.js').TreeFile[]} files - Files to write.
 * @returns {Promise<void>}
 */
export async function writeTree(root, files) {
  const paletteDir = path.join(root, PALETTE_DIR);
  const cacheDir = path.join(paletteDir, CACHE_DIR);

  // Move the extension cache out of the way (it must survive rebuilds).
  // Paths are kept relative to `root` so they restore into `.palette/cache`,
  // not a stray top-level `cache/` directory.
  let cacheFiles = [];
  try {
    cacheFiles = await readDirRecursive(cacheDir, root);
    await fs.rm(cacheDir, { recursive: true, force: true });
  } catch {
    // No cache yet.
  }

  const rolesDir = path.join(root, ROLES_DIR);
  await fs.rm(rolesDir, { recursive: true, force: true });
  await fs.rm(paletteDir, { recursive: true, force: true });

  await fs.mkdir(paletteDir, { recursive: true });
  for (const file of files) {
    const target = path.join(root, file.rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content);
  }

  // Restore the cache.
  if (cacheFiles.length) {
    await fs.mkdir(cacheDir, { recursive: true });
    for (const f of cacheFiles) {
      await fs.mkdir(path.dirname(path.join(root, f.path)), { recursive: true });
      await fs.writeFile(path.join(root, f.path), f.content);
    }
  }
}

/** @param {string} dir @returns {Promise<{path: string, content: Uint8Array}[]>} */
async function readDirRecursive(dir, base = dir) {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (e.isDirectory()) {
      out.push(...(await readDirRecursive(full, base)));
    } else {
      out.push({ path: rel, content: await fs.readFile(full) });
    }
  }
  return out;
}

/**
 * Pack the palette tree at `root` back into a `.sb3` file. Used by the
 * `export` command and by the reverse (post-checkout/post-merge) hook that
 * regenerates the editor-facing `.sb3` from the committed tree.
 *
 * @param {string} root
 * @param {object} [options]
 * @param {string} [options.out] - Output path (default `<repoName>.sb3`).
 * @returns {Promise<{ outPath: string, warnings: string[] }>}
 */
export async function runExport(root, { out } = {}) {
  const { json, assets, warnings } = await repackProject(root);
  const { entries } = parseDeps(await readDepsFile(root));
  await applyDepsToJson(json, entries, {
    cacheDir: path.join(root, '.palette', CACHE_DIR),
  });
  const outPath = out || `${path.basename(root.replace(/[\\/]+$/, ''))}.sb3`;
  await writeSb3(outPath, json, assets);
  return { outPath, warnings };
}

/**
 * Reverse-sync: after a checkout/merge that changed the tree, regenerate the
 * gitignored `.sb3` so the editor stays in sync with the committed tree.
 * Skipped when there are unresolved merge conflicts (resolve those first).
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {Promise<void>}
 */
export async function runEditorSync({ cwd } = {}) {
  const root = await repoRoot(cwd);
  if (!(await isFile(path.join(root, '.palette', 'project.json')))) return;

  const unresolved = (
    await git(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: root })
  )
    .split('\0')
    .filter(Boolean);
  if (unresolved.length) {
    process.stderr.write(
      'git-palette: skipping editor sync — resolve merge conflicts first\n',
    );
    return;
  }

  let name = 'project';
  try {
    const meta = JSON.parse(
      await fs.readFile(path.join(root, '.palette', 'meta.json'), 'utf8'),
    );
    if (meta.name) name = meta.name;
  } catch {
    /* keep default */
  }

  const { outPath, warnings } = await runExport(root, { out: path.join(root, `${name}.sb3`) });
  for (const w of warnings) process.stderr.write(`git-palette: warning: ${w}\n`);
  process.stderr.write(
    `git-palette: regenerated ${path.relative(root, outPath)} from the tree for the editor\n`,
  );
}