'use strict';
// AndonView, the public face: against a stand-in fetch and a clock the test moves.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { AndonView, InputError, ValidationError } = require('@smartrsolutions/andon-client');
const { template } = require('../testdata/fixtures');

const VIEW = 'vw_totavbtprh6rdpgg2m2f6vrwny';
const SECRET = 'ws_' + 'a'.repeat(43);
const KEY = crypto.randomBytes(32);
const START = Date.parse('2026-09-22T18:40:00Z');

function fakeClock() {
    let now = START;
    let seq = 0;
    const timers = new Map();
    return {
        now: () => now,
        setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
        clearTimeout: (id) => { timers.delete(id); },
        async advance(ms) {
            const until = now + ms;
            for (;;) {
                const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
                if (!next || next[1].at > until) { break; }
                timers.delete(next[0]);
                now = next[1].at;
                next[1].fn();
                await new Promise((r) => setImmediate(r));
            }
            now = until;
        },
        pending: () => timers.size,
    };
}

function open(text) {
    const env = JSON.parse(text);
    const raw = Buffer.from(env.ct, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(env.nonce, 'base64'), { authTagLength: 16 });
    d.setAAD(Buffer.from('andon-v1|' + env.view + '|' + env.kv, 'utf8'));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return { env, doc: JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8')) };
}

/** relay records every request and answers from `answers`, 204 once they run out. */
function relay(answers = []) {
    const requests = [];
    const fetch = async (url, init) => {
        requests.push({ url, init, ...open(init.body) });
        const status = answers.length ? answers.shift() : 204;
        return { status, text: async () => (status === 204 ? '' : '{"error":"e' + status + '"}'), headers: { get: () => null } };
    };
    return { fetch, requests };
}

function view(extra = {}) {
    const clock = fakeClock();
    const r = relay(extra.answers);
    const errors = [];
    const v = new AndonView(Object.assign({
        view: VIEW, writeSecret: SECRET, contentKey: KEY.toString('base64url'),
        template: template(), fetch: r.fetch, clock, onError: (e) => errors.push(e),
    }, extra));
    return { v, clock, requests: r.requests, errors };
}

const tileOf = (doc, id) => doc.tiles.find((t) => t.id === id);

test('a value goes out at once, sealed, to the relay, the secret in the header only', async () => {
    const { v, clock, requests } = view({ relayUrl: 'http://relay.test/' });
    v.set('t_oee', 81);
    await clock.advance(0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'http://relay.test/v1/views/' + VIEW + '/envelope');
    assert.equal(requests[0].init.method, 'PUT');
    assert.equal(requests[0].init.headers.authorization, 'Bearer ' + SECRET);
    assert.ok(!requests[0].init.body.includes(SECRET));
    assert.equal(tileOf(requests[0].doc, 't_oee').value, 81);
    await v.close();
});

test('the public relay is the default', async () => {
    const { v, clock, requests } = view();
    v.set('t_oee', 81);
    await clock.advance(0);
    assert.match(requests[0].url, /^https:\/\/relay\.andon\.app\/v1\/views\//);
    await v.close();
});

test('several values at once, and options for a series', async () => {
    const { v, clock, requests } = view();
    v.set({ t_oee: 82, t_shift: 600 });
    v.set('t_takt', 31.5, { at: new Date(START - 60000) });
    await clock.advance(0);
    const doc = requests[0].doc;
    assert.equal(tileOf(doc, 't_oee').value, 82);
    assert.equal(tileOf(doc, 't_shift').value, 600);
    assert.deepEqual(tileOf(doc, 't_takt').series[0].samples, [['2026-09-22T18:39:00Z', 31.5]]);
    await v.close();
});

test('a refusal names the API, not a Node-RED message', () => {
    const { v } = view();
    assert.throws(() => v.set('t_takt', 1, { at: 'gestern' }), (e) => e instanceof InputError &&
        /^options\.at is neither milliseconds nor an ISO timestamp: gestern\. /.test(e.message) &&
        /options\.series picks which\)$/.test(e.message) && !/msg\./.test(e.message));
    assert.throws(() => v.set('t_oee', null), { message: /^tile "t_oee": the value is empty\. / });
    assert.throws(() => v.set('t_nope', 1), /the view has no tile "t_nope"/);
    assert.throws(() => v.set({}), /the value names no tile/);
    assert.throws(() => v.set('t_takt', { series: [{ name: 'Ist', start: 'x', stepSec: 60, points: [1] }] }), ValidationError);
    assert.equal(tileOf(v.document, 't_oee').value, 79.3, 'the view stays as it was');
});

test('without a template the first value is a whole document', async () => {
    const { v, clock, requests } = view({ template: undefined });
    assert.equal(v.document, null);
    assert.throws(() => v.set('t_oee', 1), /there is no template yet: pass one as the template option/);
    v.replace(template());
    await clock.advance(0);
    assert.equal(requests.length, 1);
    assert.throws(() => v.set(template()), /replace\(\) takes a whole view document/);
    await v.close();
});

test('the template can be JSON text, and an invalid one is refused at once', () => {
    const { v } = view({ template: JSON.stringify(template()) });
    assert.equal(v.document.tiles.length, template().tiles.length);
    const broken = template();
    broken.tiles[0].view = 'nope';
    assert.throws(() => view({ template: broken }), { message: /^the template is invalid: / });
    assert.throws(() => view({ template: '{' }), /not a JSON document/);
});

test('the keys are checked when the view is made, and named without their value', () => {
    assert.throws(() => view({ view: 'nope' }), /view ID/);
    assert.throws(() => view({ writeSecret: 'ws_short' }), (e) => /write secret/.test(e.message) && !e.message.includes('ws_short'));
    assert.throws(() => view({ contentKey: 'abcd' }), /expected 32/);
    assert.throws(() => view({ keyVersion: 0 }), /key version/);
});

test('changes inside the interval become one upload; flush sends at once', async () => {
    const { v, clock, requests } = view();
    v.set('t_oee', 81);
    await clock.advance(0);
    v.set('t_oee', 82);
    v.set('t_oee', 83);
    await clock.advance(5000);
    assert.equal(requests.length, 1);
    const res = await v.flush();
    assert.equal(res.status, 204);
    assert.equal(requests.length, 2);
    assert.equal(tileOf(requests[1].doc, 't_oee').value, 83);
    assert.equal(await v.flush(), undefined, 'nothing pending');
    await v.close();
});

test('close sends what is pending and stops every timer', async () => {
    const { v, clock, requests } = view();
    v.set('t_oee', 81);
    await clock.advance(0);
    v.set('t_oee', 82);
    await v.close();
    assert.equal(requests.length, 2);
    assert.equal(clock.pending(), 0);
    assert.throws(() => v.set('t_oee', 1), /closed/);
    await clock.advance(600000);
    assert.equal(requests.length, 2);
});

test('close with flush false drops what is pending', async () => {
    const { v, clock, requests } = view();
    v.set('t_oee', 81);
    await clock.advance(0);
    v.set('t_oee', 82);
    await v.close({ flush: false });
    assert.equal(requests.length, 1);
    assert.equal(clock.pending(), 0);
});

test('a failed upload reaches onError, with when the next try is', async () => {
    const { v, clock, errors } = view({ answers: [503, 401] });
    v.set('t_oee', 81);
    await clock.advance(0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].status, 503);
    assert.equal(errors[0].retryInSec, 30);
    await clock.advance(30000);
    assert.equal(errors[1].status, 401);
    assert.equal(errors[1].retryInSec, undefined, 'a 401 waits for the next value');
    assert.match(errors[1].message, /use the current \.env of the view/);
    await v.close({ flush: false });
});

test('onSent gets the report, without envelope or secret', async () => {
    const reports = [];
    const { v, clock } = view({ onSent: (r) => reports.push(r) });
    v.set('t_oee', 81);
    await clock.advance(0);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].status, 204);
    assert.equal(reports[0].notify, true);
    assert.ok(!JSON.stringify(reports[0]).includes(SECRET));
    await v.close();
});

test('fromEnv reads the names of the .env from the configurator', async () => {
    const r = relay();
    const clock = fakeClock();
    const env = {
        ANDON_CLOUD_VIEW: VIEW, ANDON_CLOUD_WRITE_SECRET: SECRET, ANDON_CLOUD_CONTENT_KEY: KEY.toString('base64url'),
        ANDON_CLOUD_KEY_VERSION: '2', ANDON_CLOUD_URL: 'http://own.test/',
    };
    const v = AndonView.fromEnv({ prefix: 'ANDON_CLOUD_', env, template: template(), fetch: r.fetch, clock });
    v.set('t_oee', 81);
    await clock.advance(0);
    assert.equal(r.requests[0].env.kv, 2);
    assert.match(r.requests[0].url, /^http:\/\/own\.test\/v1\//);
    await v.close();
});

test('fromEnv names a variable nobody set', () => {
    assert.throws(() => AndonView.fromEnv({ env: { ANDON_VIEW: VIEW } }), { message: 'ANDON_WRITE_SECRET is not set' });
    assert.throws(() => AndonView.fromEnv({ prefix: 'andon', env: {} }), /upper case/);
});
