/**
 * Extension discovery + resolution for git-palette.
 *
 * TurboWarp (and compatible editors) record, for every project, the *source*
 * of each extension in a structured way — NOT scattered as free strings inside
 * blocks:
 *
 *  - `project.extensionURLs` is an object mapping each extension id to its JS
 *    source location. The value is one of:
 *      1. an `https://…js` URL (downloaded), or
 *      2. a `data:` URL carrying the source inline — either
 *         `data:…;base64,<base64>` (decoded) or
 *         `data:…,<percent-encoded>` (URL-decoded). No download needed.
 *  - `project.extensions` lists bare ids for BOTH built-in and custom
 *    extensions. An id present there but absent from `extensionURLs` is a
 *    built-in (or otherwise unresolved) extension we cannot render — it keeps
 *    its `builtin` classification.
 *
 * We read strictly from `project.extensionURLs` (the real project format), so
 * asset/icon URLs that happen to live in block inputs are never mistaken for
 * extension sources.
 *
 * `parse-sb3-blocks` is an I/O-free parser: it only turns an already-fetched JS
 * source into block definitions (`registerExtensionFromSource`). This module is
 * the CALLER that reads `extensionURLs`, obtains the source (download or decode
 * the `data:` URL), and feeds it to the parser. Discovered sources are cached
 * under `.palette/cache/<id>.js` and their parsed `getInfo()` under
 * `.palette/extensions/<id>.json` so the tree is reproducible offline.
 *
 * @module extresolve
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { registerExtensionFromSource } from 'parse-sb3-blocks';
import { registerTurbowarpBuiltins } from './builtins.js';

/**
 * Decode a `data:` URL that embeds extension JS source.
 *
 * Supports both `data:…;base64,<base64>` and `data:…,<percent-encoded>` forms.
 * Returns the decoded JS source, or `null` if the URL is not a decodable
 * `data:` URL.
 *
 * @param {string} url
 * @returns {string|null}
 */
export function decodeDataUrl(url) {
  const m = url.match(/^data:(?:application|text)\/javascript(?:;([^,]*))?,(.*)$/s);
  if (!m) return null;
  const meta = m[1] || '';
  const payload = m[2];
  try {
    if (/base64/i.test(meta)) return Buffer.from(payload, 'base64').toString('utf8');
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

/**
 * Fetch a URL's text with a timeout. Returns `null` on any failure.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<string|null>}
 */
async function fetchText(url, timeoutMs) {
  const fetchImpl =
    typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
  if (!fetchImpl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Discover, read, and register a project's custom extensions from its
 * structured `extensionURLs`, then cache their sources + parsed getInfo for
 * offline reproducibility.
 *
 * Must run BEFORE `sbTextForProject` so the parser knows the custom block
 * definitions when rendering `.sb` text.
 *
 * @param {object} json - Parsed `project.json`.
 * @param {object} [options]
 * @param {string} [options.paletteDir] - `.palette` dir; when given, sources are
 *   cached to `<paletteDir>/cache/<id>.js` and getInfo to
 *   `<paletteDir>/extensions/<id>.json`.
 * @param {number} [options.timeoutMs=10000] - Per-URL fetch timeout.
 * @returns {Promise<{ resolvedById: Map<string, { id: string, kind: 'url'|'source', url?: string }>, warnings: string[] }>}
 */
export async function resolveExtensions(json, { paletteDir, timeoutMs = 10000 } = {}) {
  const resolvedById = new Map();
  const warnings = [];
  const cacheDir = paletteDir ? path.join(paletteDir, 'cache') : null;
  const extDir = paletteDir ? path.join(paletteDir, 'extensions') : null;
  if (cacheDir) await fs.mkdir(cacheDir, { recursive: true });
  if (extDir) await fs.mkdir(extDir, { recursive: true });

  /**
   * Parse + register one source, caching it. Skips invalid sources silently
   * (with a warning) so one bad candidate never sinks the import.
   *
   * @param {string} source
   * @param {'url'|'source'} kind
   * @param {string} [url]
   */
  const tryRegister = async (source, kind, url) => {
    const idHint = kind === 'source' ? url : url;
    let result;
    try {
      result = await registerExtensionFromSource(source, { url: idHint, unsandboxed: true });
    } catch (e) {
      warnings.push(`extension (${idHint}): ${e.message}`);
      return;
    }
    if (!result || !result.ok || !(result.info && (result.info.extensionId || result.info.id))) {
      warnings.push(`extension (${idHint}): source is not a valid Scratch extension`);
      return;
    }
    const id = result.info.extensionId || result.info.id;
    if (resolvedById.has(id)) return; // first wins
    resolvedById.set(id, { id, kind, url });
    if (cacheDir) {
      await fs.writeFile(path.join(cacheDir, `${id}.js`), source);
      await fs.writeFile(
        path.join(extDir, `${id}.json`),
        JSON.stringify(result.info, null, 2),
      );
    }
  };

  const extensionURLs =
    json && json.extensionURLs && typeof json.extensionURLs === 'object'
      ? json.extensionURLs
      : {};

  for (const [id, url] of Object.entries(extensionURLs)) {
    if (typeof url !== 'string' || !url) continue;
    if (/^https?:\/\//i.test(url)) {
      const source = await fetchText(url, timeoutMs);
      if (source == null) {
        warnings.push(`could not fetch extension ${id} (${url})`);
        continue;
      }
      await tryRegister(source, 'url', url);
    } else if (/^data:/i.test(url)) {
      const source = decodeDataUrl(url);
      if (source == null) {
        warnings.push(`could not decode embedded extension ${id}`);
        continue;
      }
      await tryRegister(source, 'source', url);
    } else {
      warnings.push(`unrecognized extension URL form for ${id}: ${String(url).slice(0, 60)}`);
    }
  }

  // Built-in extensions with no URL/source in the project (e.g. TurboWarp's
  // `tw`) are resolved from the cloned extension library submodule. Their block
  // definitions are registered globally; record them so deps/scratchdeps sees
  // them too.
  try {
    const registered = registerTurbowarpBuiltins();
    for (const id of registered) {
      if (!resolvedById.has(id)) resolvedById.set(id, { id, kind: 'builtin' });
    }
  } catch (e) {
    warnings.push(`builtin library: ${e.message}`);
  }

  return { resolvedById, warnings };
}

/**
 * Re-register custom extensions from a previously cached `.palette/cache`
 * directory (offline; no network). Used by status/diff so they render with real
 * categories without re-downloading.
 *
 * @param {string} paletteDir
 * @returns {Promise<string[]>} ids that were re-registered.
 */
export async function registerCachedExtensions(paletteDir) {
  const cacheDir = path.join(paletteDir, 'cache');
  let files = [];
  try {
    files = await fs.readdir(cacheDir);
  } catch {
    return [];
  }
  const registered = [];
  for (const f of files) {
    if (!f.endsWith('.js')) continue;
    const id = f.slice(0, -3);
    try {
      const source = await fs.readFile(path.join(cacheDir, f), 'utf8');
      const r = await registerExtensionFromSource(source, {
        url: `cached:${id}`,
        unsandboxed: true,
      });
      if (r && r.ok) registered.push(id);
    } catch {
      /* ignore a broken cache entry */
    }
  }
  return registered;
}
