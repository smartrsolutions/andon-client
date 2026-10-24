'use strict';
// Runs against dist/, the build npm gets: `npm test` builds first.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { seal, parseKey, parseKeyVersion, fingerprint, MAX_ENVELOPE } = require('@smartrsolutions/andon-client/runtime');

const VIEW = 'vw_totavbtprh6rdpgg2m2f6vrwny';
const KEY = crypto.randomBytes(32);

function open(text) {
    const env = JSON.parse(text);
    const raw = Buffer.from(env.ct, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(env.nonce, 'base64'), { authTagLength: 16 });
    d.setAAD(Buffer.from('andon-v1|' + env.view + '|' + env.kv, 'utf8'));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8'));
}

test('seal writes the envelope fields in the order of the format and opens again', () => {
    const doc = { tiles: [{ id: 'a', view: 'label', title: 'A', value: 1 }] };
    const out = seal(doc, { view: VIEW, kv: 2, key: KEY, notify: true });
    assert.deepEqual(Object.keys(JSON.parse(out.text)), ['v', 'view', 'kv', 'nonce', 'ct', 'notify']);
    assert.deepEqual(open(out.text), doc);
    assert.equal(out.bytes, Buffer.byteLength(out.text));
});

test('every envelope gets a nonce of its own', () => {
    const a = JSON.parse(seal({ tiles: [] }, { view: VIEW, kv: 1, key: KEY, notify: false }).text);
    const b = JSON.parse(seal({ tiles: [] }, { view: VIEW, kv: 1, key: KEY, notify: false }).text);
    assert.notEqual(a.nonce, b.nonce);
    assert.equal(Buffer.from(a.nonce, 'base64').length, 12);
});

test('an envelope above the relay limit is refused', () => {
    const big = Buffer.alloc(MAX_ENVELOPE, 'x');
    assert.throws(() => seal(big, { view: VIEW, kv: 1, key: KEY, notify: false }), /KiB/);
});

test('parseKey takes base64url and standard base64, and only 32 bytes', () => {
    const raw = crypto.randomBytes(32);
    assert.deepEqual(parseKey(raw.toString('base64url')), raw);
    assert.deepEqual(parseKey(raw.toString('base64')), raw);
    assert.throws(() => parseKey('abcd'), /expected 32/);
});

test('parseKeyVersion takes integers from 1', () => {
    assert.equal(parseKeyVersion('3'), 3);
    assert.throws(() => parseKeyVersion(0));
    assert.throws(() => parseKeyVersion('1.5'));
});

test('the fingerprint depends on statuses, not on order or values', () => {
    const a = fingerprint({ tiles: [{ id: 'a', status: 'ok' }, { id: 'b' }] });
    assert.equal(a, fingerprint({ tiles: [{ id: 'b', status: null }, { id: 'a', status: 'ok' }] }));
    assert.notEqual(a, fingerprint({ tiles: [{ id: 'a', status: 'warning' }, { id: 'b' }] }));
});

test('the fingerprint sorts by UTF-16 code unit, never by locale', () => {
    const ids = ['b', 'ä', 'B', 'a', 'Z', '_'];
    const tiles = ids.map((id) => ({ id, status: 'ok' }));
    // Code unit order: "B" < "Z" < "_" < "a" < "b" < "ä"; a locale would put "a", "ä" and "b" together.
    const expected = crypto.createHash('sha256').update(['B=ok', 'Z=ok', '_=ok', 'a=ok', 'b=ok', 'ä=ok'].join('\n'), 'utf8').digest('hex');
    assert.equal(fingerprint({ tiles }), expected);
});
