/**
 * `.scratchdeps` — extension dependency declarations with version locking.
 *
 * Extensions are treated as dependency packages:
 * - built-in Scratch extensions (`pen`, `text2speech`, ...) are declared with
 *   the `builtin` spec and need no js;
 * - custom (TurboWarp-style) extensions point at a js file or js URL; a
 *   `sha256` line locks the content.
 *
 * Format (line based, `#` comments):
 *
 * ```ini
 * pen: builtin
 * myext: https://ext.turbowarp.org/foo.js
 *   sha256: ab12…
 * ```
 *
 * @module deps
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Header written when a project declares no extensions. */
export const DEPS_HEADER = `# dependency declarations (extension version locking)\n# built-in extensions (bundled with Scratch, no js needed) use the field as-is; custom extensions point at a js file or URL.\n`;

/**
 * One parsed extension entry.
 *
 * @typedef {object} DepEntry
 * @property {string} id - Extension id.
 * @property {string} spec - `builtin`, a local path, or a URL.
 * @property {string} [sha256] - Content lock (hex) for custom extensions.
 */

/**
 * Parse `.scratchdeps` text.
 *
 * @param {string} text
 * @param {string[]} [commentLines] - Comment lines to keep when re-rendering.
 * @returns {{ entries: DepEntry[], comments: string[] }}
 */
export function parseDeps(text, commentLines = []) {
  const entries = [];
  const comments = commentLines;
  let last = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      comments.push(trimmed);
      continue;
    }
    // sha256 continuation belongs to the previous custom entry.
    const sha = /^sha256:\s*([0-9a-fA-F]{40,})\s*$/.exec(trimmed);
    if (sha && last && last.spec !== 'builtin') {
      last.sha256 = sha[1].toLowerCase();
      continue;
    }
    const m = /^([^\s:=]+)\s*:\s*(\S.*)$/.exec(trimmed);
    if (!m) continue; // tolerate junk lines
    const entry = { id: m[1], spec: m[2].trim() };
    entries.push(entry);
    last = entry;
  }
  return { entries, comments };
}

/**
 * Render entries (and kept comments) back to `.scratchdeps` text.
 *
 * @param {DepEntry[]} entries
 * @param {string[]} [comments]
 * @returns {string}
 */
export function renderDeps(entries, comments = []) {
  const lines = [...comments];
  for (const e of entries) {
    lines.push(`${e.id}: ${e.spec}`);
    if (e.sha256) lines.push(`  sha256: ${e.sha256}`);
  }
  return (lines.join('\n') || DEPS_HEADER.trimEnd()) + '\n';
}

/**
 * Extract extension entries from a project.json.
 *
 * Per the sb3 format reference (docs/reference/sb3-file-format.md §3.7):
 * built-in extensions appear as bare ID strings; TurboWarp custom extensions
 * may appear either as a plain URL string or as an
 * `{extensionId, js, type: 'extension'}` object. The source form is kept so
 * re-packing stays lossless.
 *
 * @param {object} json
 * @returns {DepEntry[]}
 */
export function extractDeps(json) {
  const entries = [];
  for (const ext of (json && json.extensions) || []) {
    if (typeof ext === 'string') {
      if (/^https?:\/\//i.test(ext)) {
        // TurboWarp style: extension loaded straight from a URL string.
        entries.push({ id: urlBasename(ext), spec: ext, form: 'string' });
      } else {
        entries.push({ id: ext, spec: 'builtin', form: 'builtin' });
      }
    } else if (ext && typeof ext === 'object' && ext.extensionId) {
      entries.push({
        id: ext.extensionId,
        spec: typeof ext.js === 'string' ? ext.js : 'builtin',
        form: 'object',
      });
    }
  }
  return entries;
}

/** @param {string} url @returns {string} `.../example.js` → `example`. */
function urlBasename(url) {
  const base = url.split(/[\\/]/).pop() || 'extension';
  return base.replace(/\.js$/i, '') || 'extension';
}

/**
 * Rebuild `json.extensions` from dep entries, embedding locally cached js
 * files so projects rebuild offline. The original source form is preserved:
 * URL strings stay URL strings, objects stay objects, built-ins stay bare
 * strings.
 *
 * @param {object} json - Will be mutated (extensions replaced).
 * @param {DepEntry[]} entries
 * @param {object} [options]
 * @param {string} [options.cacheDir] - `.palette/cache` dir to look for
 *   `<id>.js` downloads.
 * @returns {Promise<void>}
 */
export async function applyDepsToJson(json, entries, { cacheDir } = {}) {
  json.extensions = [];
  for (const e of entries) {
    if (!e) continue;
    const form = e.form || (e.spec === 'builtin' ? 'builtin' : 'object');
    if (form === 'builtin') {
      json.extensions.push(e.id);
      continue;
    }
    const cached = path.join(cacheDir || '', `${e.id}.js`);
    if (cacheDir && (await awaitFileExists(cached))) {
      json.extensions.push({
        extensionId: e.id,
        js: `${e.id}.js`,
        type: 'extension',
      });
    } else if (form === 'string') {
      // TurboWarp URL-string form: keep the raw URL untouched.
      json.extensions.push(e.spec);
    } else {
      const ext = { extensionId: e.id, js: e.spec, type: 'extension' };
      if (e.sha256) ext.version = e.sha256;
      json.extensions.push(ext);
    }
  }
}

/** @param {string} p @returns {Promise<boolean>} */
async function awaitFileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lock an entry: compute sha256 of a local file, or fetch a URL (best effort,
 * with a timeout) and cache it under `cacheDir/<id>.js`.
 *
 * @param {DepEntry} entry
 * @param {string} [cacheDir] - Directory for fetched js files.
 * @param {object} [options]
 * @param {number} [options.timeoutMs=10000]
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function lockEntry(entry, cacheDir, { timeoutMs = 10000 } = {}) {
  const spec = entry.spec;
  const isUrl = /^https?:\/\//i.test(spec);
  let bytes;
  try {
    if (isUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(spec, { signal: controller.signal });
        if (!res.ok) {
          return {
            ok: false,
            message: `${entry.id}: fetch failed (HTTP ${res.status})`,
          };
        }
        bytes = Buffer.from(await res.arrayBuffer());
      } finally {
        clearTimeout(timer);
      }
    } else {
      bytes = await fs.readFile(spec);
    }
  } catch (err) {
    return { ok: false, message: `${entry.id}: ${err.message}` };
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  entry.sha256 = digest;
  if (isUrl && cacheDir) {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, `${entry.id}.js`), bytes);
  }
  return { ok: true, message: `${entry.id}: locked (sha256 ${digest.slice(0, 12)}…)` };
}

/**
 * Read the `.scratchdeps` file at a tree root. Returns `''` when absent.
 *
 * @param {string} root
 * @returns {Promise<string>}
 */
export async function readDepsFile(root) {
  try {
    return await fs.readFile(path.join(root, '.scratchdeps'), 'utf8');
  } catch {
    return '';
  }
}