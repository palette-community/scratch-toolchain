/**
 * The palette tree: the on-disk, git-stored representation of a project.
 *
 * Mapping rules (see PLAN.md §2):
 *
 * - `.palette/project.json` — authoritative data, pretty-printed, key order
 *   preserved from the source so diffs stay tight.
 * - `roles/<name>/{<name>.sb, costumes/*, sounds/*}` — one folder per target;
 *   the stage always lives in `roles/stage/`.
 * - Assets use **readable names** (`costume.name` + the md5ext suffix), with
 *   `-2/-3` disambiguation on collisions; `.palette/assets.json` maps every
 *   `md5ext` back to its tree file so export stays lossless.
 *
 * @module tree
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { snippetsToText } from './text.js';

/** Top-level directory holding all targets. */
export const ROLES_DIR = 'roles';
/** Palette metadata directory. */
export const PALETTE_DIR = '.palette';
/** Stage target folder name. */
export const STAGE_NAME = 'stage';
export const COSTUME_DIR = 'costumes';
export const SOUND_DIR = 'sounds';

export const TYPE_FILE = 'type.json';
export const META_FILE = 'meta.json';
export const PROJECT_FILE = 'project.json';
export const ASSET_MAP_FILE = 'assets.json';
export const POSITIONS_FILE = 'block-positions.json';
export const DEPS_FILE = '.scratchdeps';

/**
 * One generated tree file.
 *
 * @typedef {object} TreeFile
 * @property {string} rel - Path relative to the repo root (uses `/`).
 * @property {string | Uint8Array} content - Text content or asset bytes.
 */

/**
 * Build the full palette tree for a project. Every file the tree needs is
 * returned here; callers write them to disk (repo root) or a temp dir.
 *
 * @param {object} json - Parsed project.json.
 * @param {Map<string, Uint8Array>} assets - sb3 assets keyed by md5ext.
 * @param {object} [options]
 * @param {string} [options.name] - Project name (for meta.json).
 * @param {string} [options.source] - Origin of the sb3 (for meta.json).
 * @param {string} [options.depsText] - Pre-rendered `.scratchdeps` content.
 * @param {string} [options.language='en'] - Block language for .sb files.
 * @param {object} [options.sbSnippets] - Pre-rendered per-target scratchblocks
 *   snippets from `sbTextForProject(json, { language })`; keyed by target name.
 * @param {object} [options.positions] - Per-target top-level block (x,y) for
 *   lossless repack; keyed by target name → `[[x, y], ...]` in text order.
 * @returns {TreeFile[]}
 */
export function buildTree(
  json,
  assets,
  { name = 'untitled', source = '', depsText = '', language = 'en', sbSnippets, positions } = {},
) {
  const files = [];
  const assetMap = {};

  files.push({
    rel: fileInPalette(TYPE_FILE),
    content: JSON.stringify({ type: 'project' }) + '\n',
  });
  files.push({
    rel: fileInPalette(META_FILE),
    content:
      JSON.stringify(
        {
          name,
          source,
          importedAt: new Date().toISOString(),
          tool: 'git-palette',
        },
        null,
        2,
      ) + '\n',
  });
  files.push({
    rel: fileInPalette(PROJECT_FILE),
    content: prettyJson(json),
  });

  // Assign folder names for every target (stage first, then layer order).
  const dirs = assignTargetDirs(json);

  const usedNames = new Set(); // `${targetDir}/${kind}/${name}` — per folder.
  for (const target of (json && json.targets) || []) {
    const dir = dirs.get(target);
    files.push({
      rel: [ROLES_DIR, dir, `${dir}.sb`].join('/'),
      content: snippetsToText(sbSnippets?.[target.name]),
    });

    for (const asset of target.costumes || []) {
      const entry = addAsset(
        assetMap,
        usedNames,
        dir,
        'costume',
        asset.md5ext,
        asset.name,
        assets.get(asset.md5ext),
      );
      if (entry)
        files.push({
          rel: entry.rel,
          content: entry.bytes,
        });
    }
    for (const asset of target.sounds || []) {
      const entry = addAsset(
        assetMap,
        usedNames,
        dir,
        'sound',
        asset.md5ext,
        asset.name,
        assets.get(asset.md5ext),
      );
      if (entry)
        files.push({
          rel: entry.rel,
          content: entry.bytes,
        });
    }
  }

  files.push({
    rel: fileInPalette(ASSET_MAP_FILE),
    content: prettyJson(assetMap),
  });
  if (positions) {
    files.push({
      rel: fileInPalette(POSITIONS_FILE),
      content: prettyJson(positions),
    });
  }
  if (depsText) files.push({ rel: DEPS_FILE, content: depsText });

  return files;
}

/**
 * Read the palette tree back into {json, assets} ready for zipping into an
 * sb3. Validates that every referenced asset exists and that its content
 * still matches the md5ext (content-addressing guarantee).
 *
 * @param {string} treeRoot - Directory holding `.palette/` and `roles/`.
 * @param {object} [options]
 * @param {boolean} [options.requireDeps=true] - Require `.scratchdeps` when
 *   the project declares extensions.
 * @returns {Promise<{ json: object, assets: Map<string, Uint8Array>, warnings: string[] }>}
 */
export async function readTree(treeRoot, { requireDeps = true } = {}) {
  const warnings = [];
  const jsonPath = path.join(treeRoot, PALETTE_DIR, PROJECT_FILE);
  const mapPath = path.join(treeRoot, PALETTE_DIR, ASSET_MAP_FILE);

  let jsonText;
  let mapText;
  try {
    [jsonText, mapText] = await Promise.all([
      fs.readFile(jsonPath, 'utf8'),
      fs.readFile(mapPath, 'utf8'),
    ]);
  } catch (err) {
    throw new Error(
      `Not a palette tree: missing ${mapPath} or ${jsonPath} (${err.message})`,
    );
  }
  const json = JSON.parse(jsonText);
  const assetMap = JSON.parse(mapText);

  const assets = new Map();
  for (const target of json.targets || []) {
    for (const asset of target.costumes || []) {
      await loadAsset(target, asset, 'costume', assetMap, treeRoot, assets, warnings);
    }
    for (const asset of target.sounds || []) {
      await loadAsset(target, asset, 'sound', assetMap, treeRoot, assets, warnings);
    }
  }

  // Warn about tree files that nothing references (things the pack omits).
  const referenced = new Set(
    Object.values(assetMap).map((e) => pathKey(e)),
  );
  warnings.push(
    ...(await collectUnreferenced(treeRoot, referenced)),
  );

  return { json, assets, warnings };
}

/* ----------------------------------------------------------------- helpers */

/**
 * Resolve and load a single asset entry from the tree.
 *
 * @param {object} target
 * @param {object} asset - A costume/sound entry (has name + md5ext).
 * @param {'costume' | 'sound'} kind
 * @param {object} assetMap
 * @param {string} treeRoot
 * @param {Map<string, Uint8Array>} assets
 * @param {string[]} warnings
 */
async function loadAsset(
  target,
  asset,
  kind,
  assetMap,
  treeRoot,
  assets,
  warnings,
) {
  const { md5ext, name } = asset;
  if (!md5ext) {
    warnings.push(
      `role "${target.name}": asset "${name}" has no md5ext — skipped`,
    );
    return;
  }
  const entry = assetMap[md5ext];
  if (!entry) {
    throw new Error(
      `Asset ${md5ext} ("${name}" in ${kind} of ${target.name}) is not in ` +
        `${PALETTE_DIR}/${ASSET_MAP_FILE}. Did someone edit the tree by hand? ` +
        `Re-import the project to rebuild the mapping.`,
    );
  }
  const rel = pathKey(entry);
  const filePath = path.join(treeRoot, rel);
  let bytes;
  try {
    bytes = await fs.readFile(filePath);
  } catch {
    throw new Error(
      `Missing asset file for ${md5ext}: ${ROLES_DIR}/${rel}. ` +
        `Pack the project again after re-importing.`,
    );
  }
  const digest = createHash('md5').update(bytes).digest('hex');
  const expected = md5ext.split('.')[0];
  if (expected && expected.length === 32 && digest !== expected) {
    throw new Error(
      `Content mismatch for ${rel}: file md5 ${digest} ≠ ${expected} ` +
        `(md5ext of "${name}"). The asset was modified; re-import to fix.`,
    );
  }
  assets.set(md5ext, bytes);
}

/** @param {object} assetMapEntry @returns {string} */
function pathKey(assetMapEntry) {
  return `${ROLES_DIR}/${assetMapEntry.target}/${kindDir(assetMapEntry.kind)}/${assetMapEntry.name}`;
}

function kindDir(kind) {
  return kind === 'sound' ? SOUND_DIR : COSTUME_DIR;
}

/**
 * Scan the tree for asset files that are not referenced by assetMap and flag
 * them (they will not be packed).
 *
 * @param {string} treeRoot
 * @param {Set<string>} referenced - Relative paths registered in assetMap.
 * @returns {Promise<string[]>}
 */
async function collectUnreferenced(treeRoot, referenced) {
  const warnings = [];
  const roles = path.join(treeRoot, ROLES_DIR);
  let dirs = [];
  try {
    dirs = await fs.readdir(roles, { withFileTypes: true });
  } catch {
    return warnings;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    for (const kind of [COSTUME_DIR, SOUND_DIR]) {
      const kindPath = path.join(roles, dir.name, kind);
      let names = [];
      try {
        names = await fs.readdir(kindPath);
      } catch {
        continue;
      }
      for (const n of names) {
        const rel = `${ROLES_DIR}/${dir.name}/${kind}/${n}`;
        if (!referenced.has(rel)) {
          warnings.push(`unreferenced tree file (not packed): ${rel}`);
        }
      }
    }
  }
  return warnings;
}

/**
 * Deterministically assign each target a folder name: the stage is `stage`,
 * sprites use their sanitised name, and collisions (a sprite literally named
 * "stage", or duplicate sprite names) get `-2`, `-3`...
 *
 * @param {object} json
 * @returns {Map<object, string>}
 */
export function assignTargetDirs(json) {
  const dirs = new Map();
  const used = new Set();
  for (const target of (json && json.targets) || []) {
    const base = target.isStage ? STAGE_NAME : sanitizeName(target.name);
    let dir = base;
    let i = 2;
    while (used.has(dir)) dir = `${base}-${i++}`;
    used.add(dir);
    dirs.set(target, dir);
  }
  return dirs;
}

/**
 * Add one asset to the tree: pick a collision-free readable filename, register
 * it in assetMap, and return the file to write.
 *
 * @param {object} assetMap - Being built.
 * @param {Set<string>} usedNames - `${targetDir}/${kind}/${name}` keys.
 * @param {string} targetDir
 * @param {'costume' | 'sound'} kind
 * @param {string} md5ext
 * @param {string} rawName - The `name` field from project.json.
 * @param {Uint8Array | undefined} bytes
 * @returns {{ rel: string, bytes: Uint8Array } | null}
 */
function addAsset(assetMap, usedNames, targetDir, kind, md5ext, rawName, bytes) {
  if (!md5ext) return null;
  if (!bytes)
    throw new Error(
      `sb3 is missing asset ${md5ext} (${rawName}) referenced by project.json`,
    );

  const ext = md5ext.split('.').slice(1).join('.') || 'bin';
  let stem = sanitizeName(String(rawName ?? 'asset'));
  if (stem.toLowerCase().endsWith('.' + ext.toLowerCase())) {
    stem = stem.slice(0, -(ext.length + 1));
  }
  if (!stem) stem = 'asset';

  let name = `${stem}.${ext}`;
  let n = 2;
  while (usedNames.has(`${targetDir}/${kind}/${name}`)) {
    name = `${stem}-${n++}.${ext}`;
  }
  usedNames.add(`${targetDir}/${kind}/${name}`);
  assetMap[md5ext] = { target: targetDir, kind, name };
  return { rel: [ROLES_DIR, targetDir, kindDir(kind), name].join('/'), bytes };
}

/**
 * Make a name safe for use as a directory or file name.
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitizeName(name) {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .trim();
  return cleaned || 'unnamed';
}

/** @param {object} json @returns {string} stable 2-space pretty JSON. */
export function prettyJson(json) {
  return JSON.stringify(json, null, 2) + '\n';
}

/** @param {string} file @returns {string} `.palette/file` path. */
function fileInPalette(file) {
  return `${PALETTE_DIR}/${file}`;
}