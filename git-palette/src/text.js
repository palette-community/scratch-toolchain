/**
 * Rendering each target's blocks as a `.sb` text file: nothing but the
 * blocks, in scratchblocks form. We delegate the whole conversion to
 * `parse-sb3-blocks`, which also auto-loads extension blocks (via
 * scratch-sandbox) so custom extensions render correctly instead of falling
 * back to hex placeholders.
 *
 * Adapted from git-sb3's `textconv.js` (MPL-2.0); now extension-aware.
 *
 * @module text
 */
import { projectToSnippets } from 'parse-sb3-blocks';

/**
 * Render a full project's blocks into per-target scratchblocks snippets.
 *
 * `projectToSnippets` splits every target into `scripts` (connected stacks)
 * and `orphans` (floating top-level blocks), and loads any JS extensions
 * declared in `project.extensions` so extension opcodes get real labels.
 *
 * @param {object} json - Parsed project.json.
 * @param {object} [options]
 * @param {string} [options.language='en'] - Block language for labels.
 * @returns {Promise<object>} `{ [targetName]: { isStage, scripts, orphans } }`.
 */
export async function sbTextForProject(json, { language = 'en' } = {}) {
  try {
    // projectToSnippets mutates the input (it annotates blocks with `id`),
    // so render from a clone to keep the authoritative json untouched.
    const { targets } = await projectToSnippets(structuredClone(json), {
      locale: language,
    });
    return targets;
  } catch (err) {
    // A parser/extension hiccup must never sink the whole unpack; callers
    // fall back to empty .sb files for the affected targets.
    process.stderr.write(`git-palette: warning: .sb rendering failed: ${err.message}\n`);
    return {};
  }
}

/**
 * Flatten one target's snippet map into the `.sb` file content (blocks only).
 *
 * @param {{ scripts?: string[], orphans?: string[] } | undefined} snippet
 * @returns {string}
 */
export function snippetsToText(snippet) {
  const parts = [...(snippet?.scripts ?? []), ...(snippet?.orphans ?? [])];
  return parts.length ? parts.join('\n\n') + '\n' : '';
}
