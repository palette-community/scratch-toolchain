/**
 * Repack the palette tree back into a `.sb3` by treating each target's `.sb`
 * scratchblocks text as the authoritative source of its block structure, while
 * `project.json` stays authoritative for everything else (targets, variables,
 * lists, broadcasts, monitors, comments schema, extension declarations).
 *
 * The forward (unpack) side already preserves two pieces of metadata needed for
 * a lossless round-trip:
 *   - `.palette/block-positions.json` — per-target top-level (x, y), in the same
 *     order the text is emitted (scripts first, then orphans);
 *   - the extensions registered in `.palette/cache/` (re-registered offline here).
 *
 * Vanilla blocks are supported 100%. Extension blocks are only included when
 * they parse (i.e. the extension was registered, so its opcode template is
 * known); blocks that cannot be resolved are simply dropped, matching the
 * "best-effort for extensions" rule.
 *
 * @module repack
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { parseScratchblocks, toSB3 } from 'parse-sb3-blocks';
import { registerCachedExtensions, registerTurbowarpBuiltins } from 'extension-git';
import {
  readTree,
  assignTargetDirs,
  PALETTE_DIR,
  ROLES_DIR,
  POSITIONS_FILE,
} from './tree.js';

/**
 * Rebuild one target's `blocks` (and `comments`) from its `.sb` text.
 *
 * @param {string} sbText - scratchblocks text for the target.
 * @param {Array<[number, number]>} positions - top-level (x, y) in text order.
 * @param {{ variables?: object, lists?: object }} varMaps - name->id maps so
 *   reversed variable/list references keep the original pointer form.
 * @returns {{ blocks: object, comments: object, topCount: number }}
 */
/**
 * Produce the original block traversal order (depth-first: self -> inputs'
 * child blocks -> next) over the top-level blocks of a target. This mirrors the
 * order the forward renderer emits text, so the reverse path can zip each
 * rebuilt block back onto its original and reuse the original id / form.
 *
 * @param {object} blocks - Original target.blocks map.
 * @returns {Array<object>} Original block objects in traversal order.
 */
export function linearizeOrder(blocks) {
  const order = [];
  const seen = new Set();
  const top = Object.keys(blocks || {}).filter(
    (id) => blocks[id] && blocks[id].topLevel && !blocks[id].parent,
  );
  const visit = (id) => {
    if (!id || seen.has(id) || !blocks[id]) return;
    seen.add(id);
    order.push({ id, block: blocks[id] });
    const b = blocks[id];
    for (const k of Object.keys(b.inputs || {})) {
      const v = b.inputs[k];
      if (Array.isArray(v)) {
        const val = v[1];
        if (typeof val === 'string' && blocks[val]) visit(val);
      }
    }
    if (b.next) visit(b.next);
  };
  for (const id of top) visit(id);
  return order;
}

export function repackTargetBlocks(sbText, positions = [], varMaps = {}, originalBlocks = {}) {
  const scripts = parseScratchblocks(sbText, { locale: 'en' });
  const opts = {
    variables: varMaps.variables || {},
    lists: varMaps.lists || {},
    broadcasts: varMaps.broadcasts || {},
    originalOrder: linearizeOrder(originalBlocks),
  };
  let result = toSB3(scripts, opts);
  // Safety: if the reverse parse dropped blocks (e.g. an extension opcode that
  // could not be registered), the original-order cursor would desync and assign
  // wrong ids/forms. Fall back to a structure-only rebuild (fresh ids) which is
  // always a valid, faithful sb3.
  const origTop = Object.keys(originalBlocks || {}).filter(
    (id) => originalBlocks[id] && originalBlocks[id].topLevel && !originalBlocks[id].parent,
  ).length;
  const rebTop = Object.keys(result.blocks).filter(
    (id) => result.blocks[id].topLevel && !result.blocks[id].parent,
  ).length;
  if (origTop > 0 && rebTop !== origTop) {
    result = toSB3(scripts, {
      variables: opts.variables,
      lists: opts.lists,
      broadcasts: opts.broadcasts,
    });
  }
  const { blocks, comments } = result;
  const topIds = Object.keys(blocks).filter((id) => blocks[id].topLevel);
  const n = Math.min(topIds.length, positions.length);
  for (let i = 0; i < topIds.length; i++) {
    const p = i < positions.length ? positions[i] : [0, 0];
    blocks[topIds[i]].x = Number(p[0]) || 0;
    blocks[topIds[i]].y = Number(p[1]) || 0;
  }
  if (topIds.length !== positions.length) {
    // Mismatch can happen when some blocks failed to parse; positions may be
    // slightly off for the tail but the structure is still recovered.
    // (kept as a soft signal only)
  }
  return { blocks, comments, topCount: topIds.length };
}

/**
 * Read the palette tree and rebuild every target's blocks from its `.sb` text.
 * Falls back to the `project.json` blocks for any target that lacks a `.sb`
 * text or a positions file (so older trees still pack).
 *
 * @param {string} root - Repo root holding `.palette/` and `roles/`.
 * @returns {Promise<{ json: object, assets: Map<string, Uint8Array>, warnings: string[] }>}
 */
export async function repackProject(root) {
  const { json, assets, warnings } = await readTree(root);

  // Register extensions offline so reverse parsing can resolve extension
  // opcodes (same set used during unpack).
  try {
    await registerCachedExtensions(path.join(root, PALETTE_DIR));
  } catch {
    /* no cache; extension blocks will be best-effort */
  }
  try {
    registerTurbowarpBuiltins();
  } catch {
    /* builtins unavailable */
  }

  let positions = {};
  try {
    positions = JSON.parse(
      await fs.readFile(path.join(root, PALETTE_DIR, POSITIONS_FILE), 'utf8'),
    );
  } catch {
    // No positions file: keep original blocks (older tree).
    return { json, assets, warnings };
  }

  const dirs = assignTargetDirs(json);
  const stage = (json.targets || []).find((t) => t.isStage);
  for (const target of json.targets || []) {
    const dir = dirs.get(target);
    const sbPath = path.join(root, ROLES_DIR, dir, `${dir}.sb`);
    let sbText;
    try {
      sbText = await fs.readFile(sbPath, 'utf8');
    } catch {
      warnings.push(
        `role "${target.name}": no .sb text found; kept original blocks`,
      );
      continue;
    }
    if (!sbText.trim()) {
      warnings.push(`role "${target.name}": empty .sb text; kept original blocks`);
      continue;
    }
    const pos = positions[target.name] || [];
    const varMaps = buildVarMaps(json, target, stage);
    try {
      // Pass the target's original blocks so repackTargetBlocks can restore the
      // original block ids and field/pointer forms via cursor alignment. It
      // falls back to a structure-only rebuild automatically if blocks were
      // dropped (e.g. an unregistered extension), so this is always safe.
      const { blocks, comments } = repackTargetBlocks(sbText, pos, varMaps, target.blocks);
      target.blocks = blocks;
      target.comments = comments;
    } catch (e) {
      warnings.push(
        `role "${target.name}": repack failed (${e.message}); kept original blocks`,
      );
    }
  }

  return { json, assets, warnings };
}

/**
 * Build name->id maps for variables and lists, merging the owning target with
 * the Stage (Stage variables are visible to every sprite; the target's own
 * definitions win on name collisions).
 *
 * @param {object} json - Full project json.
 * @param {object} target - The target being repacked.
 * @param {object} [stage] - The Stage target, if any.
 * @returns {{ variables: object, lists: object }}
 */
export function buildVarMaps(json, target, stage) {
    const maps = { variables: {}, lists: {}, broadcasts: {} };
    const add = (t) => {
        for (const id of Object.keys(t.variables || {})) {
            const v = t.variables[id];
            if (!v) continue;
            const name = Array.isArray(v) ? v[0] : v.name;
            if (name) maps.variables[name] = id;
        }
        for (const id of Object.keys(t.lists || {})) {
            const l = t.lists[id];
            if (!l) continue;
            const name = Array.isArray(l) ? l[0] : l.name;
            if (name) maps.lists[name] = id;
        }
    };
    // Broadcasts are global (stage-owned); merge into the broadcast name->id map.
    for (const id of Object.keys(json.broadcasts || {})) {
        const name = json.broadcasts[id];
        if (name) maps.broadcasts[name] = id;
    }
    if (stage) add(stage);
    add(target);
    return maps;
}
