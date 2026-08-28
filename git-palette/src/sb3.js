/**
 * Reading and writing `.sb3` zip files.
 *
 * An sb3 is a zip holding a single-line `project.json` plus the costume/sound
 * assets it references (named `<md5>.<ext>`). This layer just handles the zip
 * container; structural mapping to the palette tree lives in {@link module:tree}.
 *
 * @module sb3
 */
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
// @turbowarp/jszip ships CJS; load it through require so this stays ESM.
const JSZip = require('@turbowarp/jszip');

/**
 * A project read from an sb3.
 *
 * @typedef {object} LoadedProject
 * @property {object} json - Parsed `project.json`.
 * @property {Map<string, Uint8Array>} assets - Asset bytes keyed by zip entry name.
 */

/**
 * Read an `.sb3` file into its parsed JSON and asset bytes.
 *
 * @param {string} file - Path to the `.sb3` file.
 * @returns {Promise<LoadedProject>}
 */
export async function readSb3(file) {
  return loadSb3(await fs.readFile(file));
}

/**
 * Parse `.sb3` bytes into project JSON and asset bytes.
 *
 * @param {Uint8Array | Buffer | ArrayBuffer} data - The sb3 zip bytes.
 * @returns {Promise<LoadedProject>}
 */
export async function loadSb3(data) {
  const zip = await JSZip.loadAsync(data);
  const projectFile = zip.file('project.json');
  if (!projectFile)
    throw new Error('Not a valid sb3: project.json is missing.');
  const json = JSON.parse(await projectFile.async('string'));

  const assets = new Map();
  const reads = [];
  zip.forEach((entryPath, entry) => {
    if (entry.dir || entryPath === 'project.json') return;
    reads.push(
      entry.async('uint8array').then((bytes) => assets.set(entryPath, bytes)),
    );
  });
  await Promise.all(reads);

  return { json, assets };
}

/**
 * Consolidate a project.json and asset bytes into `.sb3` zip bytes.
 *
 * @param {object} json - Parsed project.json.
 * @param {Map<string, Uint8Array>} assets - Asset bytes keyed by zip entry name.
 * @param {object} [options]
 * @param {number} [options.compressionLevel=6] - DEFLATE level, 1–9.
 * @returns {Promise<Uint8Array>}
 */
export async function writeSb3Data(
  json,
  assets,
  { compressionLevel = 6 } = {},
) {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(json));
  for (const [name, bytes] of assets) zip.file(name, bytes);
  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: compressionLevel },
  });
}

/**
 * Write a project.json + assets map to an `.sb3` file.
 *
 * @param {string} outFile - Destination `.sb3` path.
 * @param {object} json - Parsed project.json.
 * @param {Map<string, Uint8Array>} assets - Asset bytes keyed by zip entry name.
 * @param {object} [options]
 * @param {number} [options.compressionLevel=6] - DEFLATE level, 1–9.
 * @returns {Promise<void>}
 */
export async function writeSb3(outFile, json, assets, options = {}) {
  const bytes = await writeSb3Data(json, assets, options);
  await fs.mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
  await fs.writeFile(outFile, bytes);
}