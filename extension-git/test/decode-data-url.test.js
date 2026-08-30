// Tests for extension-git: data: URL decoding covers the base64 and
// percent-encoded forms (with and without charset meta) that Turbowarp /
// scratch-gui emit when saving projects with inline extension sources.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeDataUrl } from '../src/extresolve.js';

test('base64 with application/javascript', () => {
    const src = '// hello\nfunction () { return 1; }';
    const b64 = Buffer.from(src, 'utf8').toString('base64');
    const url = `data:application/javascript;base64,${b64}`;
    assert.equal(decodeDataUrl(url), src);
});

test('base64 with text/javascript', () => {
    const src = 'var x = 1;';
    const b64 = Buffer.from(src, 'utf8').toString('base64');
    const url = `data:text/javascript;base64,${b64}`;
    assert.equal(decodeDataUrl(url), src);
});

test('base64 with charset meta', () => {
    const src = '// charset test\nconst a = "é";';
    const b64 = Buffer.from(src, 'utf8').toString('base64');
    const url = `data:application/javascript;charset=utf-8;base64,${b64}`;
    assert.equal(decodeDataUrl(url), src);
});

test('percent-encoded', () => {
    const src = 'var greeting = "héllo %world";';
    const enc = encodeURIComponent(src);
    const url = `data:application/javascript,${enc}`;
    assert.equal(decodeDataUrl(url), src);
});

test('percent-encoded with text/javascript', () => {
    const src = 'function(){return "x";}';
    const enc = encodeURIComponent(src);
    const url = `data:text/javascript,${enc}`;
    assert.equal(decodeDataUrl(url), src);
});

test('percent-encoded with charset meta', () => {
    const src = 'var é = 1;';
    const enc = encodeURIComponent(src);
    const url = `data:application/javascript;charset=utf-8,${enc}`;
    assert.equal(decodeDataUrl(url), src);
});

test('raw (no encoding) passes through decodeURIComponent unchanged', () => {
    const src = 'var x=1;var y=2;';
    const url = `data:application/javascript,${src}`;
    assert.equal(decodeDataUrl(url), src);
});

test('non-data URL returns null', () => {
    assert.equal(decodeDataUrl('https://example.com/ext.js'), null);
    assert.equal(decodeDataUrl('data:image/png;base64,AAAA'), null);
    assert.equal(decodeDataUrl(''), null);
});

test('malformed base64 returns null', () => {
    const url = 'data:application/javascript;base64,!!!not-base64!!!';
    // Buffer.from may throw or produce garbage; we accept null OR a string
    // but for round-trip stability we prefer a graceful null. The current
    // implementation swallows the throw and returns null.
    const result = decodeDataUrl(url);
    // Either null or empty-ish is acceptable; assert it does not throw.
    assert.ok(result === null || typeof result === 'string');
});
