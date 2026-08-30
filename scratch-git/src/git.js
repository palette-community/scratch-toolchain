/**
 * Thin wrappers over the `git` CLI used by the hook and the installer.
 * Kept dependency-free (just `child_process`).
 *
 * Adapted from git-sb3's `git.js` (MPL-2.0).
 *
 * @module git
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Run `git` and resolve with stdout. Rejects on non-zero exit.
 *
 * @param {string[]} args - Arguments passed to `git`.
 * @param {object} [options]
 * @param {'utf8' | 'buffer'} [options.encoding='utf8']
 * @param {string} [options.cwd]
 * @returns {Promise<string | Buffer>}
 */
export function git(args, { encoding = 'utf8', cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { encoding, cwd, maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          err.message = `git ${args.join(' ')} failed: ${stderr || err.message}`;
          reject(err);
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/** @returns {Promise<string>} The repository root directory. */
export async function repoRoot(cwd) {
  return (await git(['rev-parse', '--show-toplevel'], { cwd }))
    .trim()
    .replace(/\r/g, '');
}

/**
 * Read a staged file's bytes from the index (`:<path>` revision).
 *
 * @param {string} filePath - Repo-relative path.
 * @param {string} [cwd]
 * @returns {Promise<Buffer>}
 */
export async function stagedBlob(filePath, { cwd } = {}) {
  return /** @type {Buffer} */ (
    await git(['cat-file', '-p', `:${filePath}`], { encoding: 'buffer', cwd })
  );
}

/**
 * List paths staged for commit, NUL-delimited for safety with weird names.
 *
 * @param {string} pathspec - e.g. `'*.sb3'`.
 * @param {string} [cwd]
 * @returns {Promise<string[]>}
 */
export async function stagedFiles(pathspec, { cwd } = {}) {
  const out = await git(
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z', '--', pathspec],
    { cwd },
  );
  const s = String(out);
  if (!s) return [];
  return s.split('\0').filter(Boolean);
}

/** @returns {Promise<string[]>} Paths with changes staged (all). */
export async function allStagedFiles({ cwd } = {}) {
  const out = await git(
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
    { cwd },
  );
  const s = String(out);
  if (!s) return [];
  return s.split('\0').filter(Boolean);
}

/** @returns {Promise<string[]>} Paths staged in the `roles`/`.palette` trees. */
export async function stagedTreeFiles({ cwd } = {}) {
  const out = await git(
    [
      'diff',
      '--cached',
      '--name-only',
      '--diff-filter=ACMR',
      '-z',
      '--',
      '.palette/',
      'roles/',
      '.scratchdeps',
    ],
    { cwd },
  );
  const s = String(out);
  if (!s) return [];
  return s.split('\0').filter(Boolean);
}

/**
 * Ensure a config value is set (repo-local unless global).
 *
 * @param {string} key
 * @param {string} value
 * @param {object} [options]
 * @param {boolean} [options.global=false]
 * @returns {Promise<void>}
 */
export async function setConfig(key, value, { global = false } = {}) {
  await git(['config', ...(global ? ['--global'] : []), key, value]);
}

/** @param {string} key @returns {Promise<string | undefined>} */
export async function getConfig(key, { global = false } = {}) {
  try {
    return String(
      await git(['config', ...(global ? ['--global'] : []), '--get', key]),
    ).trim();
  } catch {
    return undefined;
  }
}

/**
 * Ensure a line exists in a file (e.g. `.gitignore`), creating it if needed.
 * Returns whether the file was modified.
 *
 * @param {string} filePath
 * @param {string} line
 * @returns {Promise<boolean>}
 */
export async function ensureLine(filePath, line) {
  let current = '';
  try {
    current = await fs.readFile(filePath, 'utf8');
  } catch {
    // File doesn't exist yet; we'll create it.
  }
  const lines = current.split('\n').map((l) => l.trim());
  if (lines.includes(line.trim())) return false;
  const next =
    current && !current.endsWith('\n')
      ? current + '\n' + line + '\n'
      : current + line + '\n';
  await fs.writeFile(filePath, next);
  return true;
}

/**
 * Recursively stage a set of repo-relative paths.
 *
 * @param {string[]} paths - Repo-relative paths to `git add`.
 * @param {string} [cwd]
 * @returns {Promise<void>}
 */
export async function addPaths(paths, { cwd } = {}) {
  if (!paths.length) return;
  await git(['add', '--', ...paths], { cwd });
}

/**
 * Remove paths from the index (keeping working-tree files).
 *
 * @param {string[]} paths
 * @param {string} [cwd]
 * @returns {Promise<void>}
 */
export async function rmCached(paths, { cwd } = {}) {
  if (!paths.length) return;
  await git(['rm', '--cached', '--quiet', '--', ...paths], { cwd });
}

/** @param {string} p @returns {Promise<boolean>} */
export async function isFile(p) {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** @param {string} file @returns {string} `file` with a trailing `.sb3` removed. */
export function stripSb3Ext(file) {
  return file.replace(/\.sb3$/i, '') || file;
}

/** @param {string} dir @returns {string} */
export function stripTrailingSlash(dir) {
  return dir.replace(/[\\/]+$/, '');
}

/** @param {string} p @returns {string} POSIX-style relative path. */
export function toPosix(p) {
  return p.split(path.sep).join('/');
}