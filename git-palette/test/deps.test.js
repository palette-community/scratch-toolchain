import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDeps,
  renderDeps,
  extractDeps,
  applyDepsToJson,
  lockEntry,
} from '../src/deps.js';

test('parseDeps: builtin + custom with sha256 continuation', () => {
  const text = `# dependency declarations
pen: builtin
myext: https://ext.turbowarp.org/foo.js
  sha256: ${'a'.repeat(64)}
text2speech: builtin
`;
  const { entries, comments } = parseDeps(text);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { id: 'pen', spec: 'builtin' });
  assert.equal(entries[1].id, 'myext');
  assert.equal(entries[1].sha256, 'a'.repeat(64));
  assert.deepEqual(comments, ['# dependency declarations']);
});

test('parseDeps: renders back losslessly', () => {
  const text = `pen: builtin\nmyext: https://x/y.js\n  sha256: ${'b'.repeat(64)}\n`;
  const { entries, comments } = parseDeps(text);
  const out = renderDeps(entries, comments);
  assert.equal(out, text);
});

test('extractDeps: strings are builtin, URL strings and objects carry js', () => {
  const json = {
    extensions: [
      'pen',
      'https://extensions.turbowarp.org/example.js',
      { extensionId: 'myext', js: 'https://ext.turbowarp.org/foo.js', type: 'extension' },
    ],
  };
  const entries = extractDeps(json);
  assert.deepEqual(entries, [
    { id: 'pen', spec: 'builtin', form: 'builtin', kind: 'builtin' },
    { id: 'example', spec: 'https://extensions.turbowarp.org/example.js', form: 'string', kind: 'url' },
    { id: 'myext', spec: 'https://ext.turbowarp.org/foo.js', form: 'object', kind: 'url' },
  ]);
});

test('applyDepsToJson: rebuilds extensions losslessly (URL-string form kept)', async () => {
  const json = { extensions: [] };
  const entries = [
    { id: 'pen', spec: 'builtin', form: 'builtin' },
    { id: 'example', spec: 'https://extensions.turbowarp.org/example.js', form: 'string' },
    { id: 'myext', spec: 'https://ext.turbowarp.org/foo.js', form: 'object', sha256: 'c'.repeat(64) },
  ];
  // cache missing → URL string stays a string; object stays an object.
  await applyDepsToJson(json, entries, { cacheDir: '/nonexistent' });
  assert.deepEqual(json.extensions, [
    'pen',
    'https://extensions.turbowarp.org/example.js',
    { extensionId: 'myext', js: 'https://ext.turbowarp.org/foo.js', type: 'extension', version: 'c'.repeat(64) },
  ]);
});

test('applyDepsToJson: embeds cached js into extension objects', async () => {
  const { promises: fs } = await import('node:fs');
  const { mkdtemp, writeFile } = fs;
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'git-palette-cache-'));
  await writeFile(join(dir, 'example.js'), '// ext');
  const json = { extensions: [] };
  await applyDepsToJson(
    json,
    [{ id: 'example', spec: 'https://extensions.turbowarp.org/example.js', form: 'string' }],
    { cacheDir: dir }
  );
  assert.deepEqual(json.extensions, [
    { extensionId: 'example', js: 'example.js', type: 'extension' },
  ]);
});

test('lockEntry: hashes local files', async () => {
  const { promises: fs } = await import('node:fs');
  const { mkdtemp, writeFile } = fs;
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'git-palette-deps-'));
  const file = join(dir, 'ext.js');
  await writeFile(file, 'console.log(1)');
  const entry = { id: 'local', spec: file };
  const { ok, message } = await lockEntry(entry);
  assert.equal(ok, true);
  assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  assert.match(message, /locked/);
});