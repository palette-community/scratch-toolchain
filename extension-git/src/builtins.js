/**
 * Built-in extension library loaded from a cloned source repository.
 *
 * Some extensions (notably TurboWarp's `tw`) appear in a project's
 * `project.extensions` as a bare id with **no URL and no embedded source**
 * (they are baked into the editor). The only way to render their blocks is to
 * read their canonical source from a cloned copy of the editor's extension
 * library and register the block definitions.
 *
 * This module reads from the `extensions/turbowarp` git submodule (TurboWarp's
 * `scratch-vm` repo, sparse-checked-out to `src/extensions`), evaluates each
 * built-in extension's `getInfo()` with a tiny CommonJS shim, and registers the
 * result via `registerExtensionInfo`. It is intentionally I/O-light: it only
 * touches files inside the checked-out submodule, never the network.
 *
 * @module builtins
 */
import { promises as fs, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerExtensionInfo } from 'parse-sb3-blocks';

const fsSync = { readFileSync, existsSync, readdirSync };
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUBMODULE_CANDIDATES = [
  // git-palette lives at <repo>/git-palette/src; the submodule is at <repo>/extensions/turbowarp
  path.resolve(__dirname, '..', '..', 'extensions', 'turbowarp'),
  path.resolve(process.cwd(), 'extensions', 'turbowarp'),
];

/** @returns {string|null} checked-out submodule root, or null when absent. */
export function findTurbowarpLib() {
  for (const dir of SUBMODULE_CANDIDATES) {
    try {
      if (fsSync.existsSync(path.join(dir, 'src', 'extensions'))) {
        return dir;
      }
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Register every built-in extension found under the submodule's
 * `src/extensions/<dir>/index.js`. Each is evaluated in isolation; failures are
 * swallowed (one bad extension must not sink the rest).
 *
 * @returns {string[]} extension ids that were successfully registered.
 */
export function registerTurbowarpBuiltins() {
  const repo = findTurbowarpLib();
  if (!repo) return [];
  const extDir = path.join(repo, 'src', 'extensions');
  const registered = [];
  let entries;
  try {
    entries = fsSync.readdirSync(extDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const indexFile = path.join(extDir, entry.name, 'index.js');
    if (!fsSync.existsSync(indexFile)) continue;
    try {
      const mod = withNoopTimers(() => loadExtension(indexFile, repo));
      const info = withNoopTimers(() => extractInfo(mod));
      if (!info || !info.id || !Array.isArray(info.blocks)) continue;
      registerExtensionInfo(info, { url: `builtin:turbowarp/${info.id}` });
      registered.push(info.id);
    } catch (e) {
      // best-effort: skip extensions whose source can't be evaluated standalone
      continue;
    }
  }
  return registered;
}

/**
 * Run `fn` with the global timer functions temporarily swapped for no-ops.
 * Extension sources are evaluated only to read their static `getInfo()`
 * descriptor; any `setTimeout`/`setInterval` they schedule at load time must
 * NOT be left dangling in the host event loop (that would keep this one-shot
 * CLI from exiting). Timers are restored afterwards.
 */
function withNoopTimers(fn) {
  const saved = {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    setImmediate: globalThis.setImmediate,
    clearTimeout: globalThis.clearTimeout,
    clearInterval: globalThis.clearInterval,
  };
  globalThis.setTimeout = (() => 0);
  globalThis.setInterval = (() => 0);
  globalThis.setImmediate = (() => 0);
  globalThis.clearTimeout = (() => {});
  globalThis.clearInterval = (() => {});
  try {
    return fn();
  } finally {
    Object.assign(globalThis, saved);
  }
}

/** @param {string} file @param {string} repo @returns {any} module.exports */
function loadExtension(file, repo) {
  const code = fsSync.readFileSync(file, 'utf8');
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  const fn = new Function('require', 'module', 'exports', code);
  const req = (reqPath) => {
    if (reqPath === 'format-message') {
      return (o) => (typeof o === 'string' ? o : o && o.default !== undefined ? o.default : o);
    }
    if (/cast(\.js)?$/.test(reqPath)) return {};
    const resolved = reqPath.startsWith('.')
      ? path.resolve(path.dirname(file), reqPath)
      : path.resolve(repo, 'src', reqPath);
    const f = /\.js$/.test(resolved) ? resolved : `${resolved}.js`;
    return loadFile(f, repo);
  };
  fn(req, module, module.exports);
  return module.exports;
}

const fileCache = new Map();
function loadFile(absPath, repo) {
  if (fileCache.has(absPath)) return fileCache.get(absPath);
  const code = fsSync.readFileSync(absPath, 'utf8');
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  const fn = new Function('require', 'module', 'exports', code);
  fn(req2(repo, absPath), module, module.exports);
  fileCache.set(absPath, module.exports);
  return module.exports;
}
function req2(repo, fromFile) {
  return (reqPath) => {
    if (reqPath === 'format-message') {
      return (o) => (typeof o === 'string' ? o : o && o.default !== undefined ? o.default : o);
    }
    if (/cast(\.js)?$/.test(reqPath)) return {};
    const resolved = reqPath.startsWith('.')
      ? path.resolve(path.dirname(fromFile), reqPath)
      : path.resolve(repo, 'src', reqPath);
    const f = /\.js$/.test(resolved) ? resolved : `${resolved}.js`;
    return loadFile(f, repo);
  };
}

/** @param {any} mod @returns {object|null} a getInfo descriptor */
function extractInfo(mod) {
  if (!mod) return null;
  try {
    if (typeof mod === 'function') {
      const inst = new mod({});
      return inst && inst.getInfo ? inst.getInfo() : null;
    }
    if (mod && typeof mod.getInfo === 'function') return mod.getInfo();
    if (mod && mod.id && Array.isArray(mod.blocks)) return mod;
  } catch {
    return null;
  }
  return null;
}
