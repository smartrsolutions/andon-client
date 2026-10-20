'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { ViewRuntime, ValidationError, InputError } = require('@smartrsolutions/andon-client/runtime');
const { template } = require('../testdata/fixtures');

const VIEW = 'vw_totavbtprh6rdpgg2m2f6vrwny';
const KEY = crypto.randomBytes(32);
const START = Date.parse('2026-09-22T18:40:00Z');

/** fakeClock runs timers when the test moves time, never on its own. */
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

/** open decrypts what was uploaded, so the tests look at the document itself. */
function open(text) {
    const env = JSON.parse(text);
    const raw = Buffer.from(env.ct, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(env.nonce, 'base64'), { authTagLength: 16 });
    d.setAAD(Buffer.from('andon-v1|' + env.view + '|' + env.kv, 'utf8'));
    d.setAuthTag(raw.subarray(raw.length - 16));
    const doc = JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8'));
    return { env, doc };
}

function runtime(extra = {}) {
    const clock = fakeClock();
    const uploads = [];
    const events = [];
    const answers = extra.answers || [];
    const rt = new ViewRuntime(Object.assign({
        view: VIEW, kv: 1, key: KEY, notify: 'auto',
        intervalSec: 30, staleAfterSec: 120,
        window: { points: 60, ageSec: 0 }, derive: new Set(),
        template: template(), clock,
        put: async (text) => { uploads.push({ at: clock.now(), ...open(text) }); return answers.shift() || { outcome: 'ok', status: 204 }; },
        onEvent: (e) => events.push(e),
    }, extra));
    return { rt, clock, uploads, events };
}

const tileOf = (doc, id) => doc.tiles.find((t) => t.id === id);

test('the first change goes out at once, sealed for this view', async () => {
    const { rt, clock, uploads } = runtime();
    rt.receive({ topic: 't_oee', payload: 81 }, 'n1');
    await clock.advance(0);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].env.view, VIEW);
    assert.equal(tileOf(uploads[0].doc, 't_oee').value, 81);
    assert.equal(uploads[0].doc.generatedAt, '2026-09-22T18:40:00Z');
    assert.equal(uploads[0].doc.staleAfterSec, 120);
});

test('changes inside the interval become one upload with the latest state', async () => {
    const { rt, clock, uploads } = runtime();
    rt.receive({ topic: 't_oee', payload: 81 });
    await clock.advance(0);
    for (let i = 0; i < 10; i++) {
        rt.receive({ topic: 't_shift', payload: 600 + i });
        await clock.advance(1000);
    }
    assert.equal(uploads.length, 1);
    await clock.advance(20000);
    assert.equal(uploads.length, 2);
    assert.equal(uploads[1].at - uploads[0].at, 30000);
    assert.equal(tileOf(uploads[1].doc, 't_shift').value, 609);
});

test('an interval below the relay throttle is raised to 10 s', () => {
    const { rt } = runtime({ intervalSec: 2 });
    assert.equal(rt.intervalSec, 10);
});

test('the heartbeat goes out only while values keep arriving', async () => {
    const { rt, clock, uploads } = runtime();
    rt.receive({ topic: 't_oee', payload: 81 });
    await clock.advance(0);
    // The same value again: no change, but proof the source is alive.
    rt.receive({ topic: 't_oee', payload: 81 });
    await clock.advance(59000);
    assert.equal(uploads.length, 1, 'no upload for a repeated value before staleAfterSec / 2');
    await clock.advance(1000);
    assert.equal(uploads.length, 2, 'heartbeat at staleAfterSec / 2');
    await clock.advance(600000);
    assert.equal(uploads.length, 2, 'silence stays silent: the app has to see the view go stale');
});

test('notify is true only when the status fingerprint changes', async () => {
    const { rt, clock, uploads } = runtime();
    rt.receive({ topic: 't_oee', payload: 81 });
    await clock.advance(0);
    rt.receive({ topic: 't_oee', payload: 82 });
    await clock.advance(30000);
    rt.receive({ topic: 't_oee', payload: { status: 'critical' } });
    await clock.advance(30000);
    assert.deepEqual(uploads.map((u) => u.env.notify), [true, false, true]);
});

test('notify always and never override the fingerprint', async () => {
    for (const [mode, expected] of [['always', true], ['never', false]]) {
        const { rt, clock, uploads } = runtime({ notify: mode });
        rt.receive({ topic: 't_oee', payload: 81 });
        await clock.advance(0);
        rt.receive({ topic: 't_oee', payload: 82 });
        await clock.advance(30000);
        assert.deepEqual(uploads.map((u) => u.env.notify), [expected, expected], mode);
    }
});

test('a failed upload keeps the fingerprint, so the retry still wakes the devices', async () => {
    const { rt, clock, uploads } = runtime({ answers: [{ outcome: 'retry', status: 503, message: 'x' }] });
    rt.receive({ topic: 't_oee', payload: 81 });
    await clock.advance(0);
    await clock.advance(30000);
    assert.equal(uploads.length, 2);
    assert.deepEqual(uploads.map((u) => u.env.notify), [true, true]);
});

test('429 waits for Retry-After and then sends the latest state', async () => {
    const { rt, clock, uploads, events } = runtime({ answers: [{ outcome: 'throttled', status: 429, retryAfterSec: 7, message: 'throttled' }] });
    rt.receive({ topic: 't_oee', payload: 81 });
    await clock.advance(0);
    rt.receive({ topic: 't_oee', payload: 83 });
    await clock.advance(6000);
    assert.equal(uploads.length, 1);
    await clock.advance(1000);
    assert.equal(uploads.length, 2);
    assert.equal(tileOf(uploads[1].doc, 't_oee').value, 83);
    assert.ok(events.some((e) => e.type === 'throttled'));
});

test('a network error backs off, doubling up to five minutes', async () => {
    const answers = Array.from({ length: 6 }, () => ({ outcome: 'retry', status: 0, message: 'down' }));
    const { rt, clock, uploads } = runtime({ answers });
    rt.receive({ topic: 't_oee', payload: 81 });
    await clock.advance(0);
    await clock.advance(30000 + 60000 + 120000 + 240000 + 300000);
    const gaps = uploads.slice(1).map((u, i) => (u.at - uploads[i].at) / 1000);
    assert.deepEqual(gaps, [30, 60, 120, 240, 300]);
});

test('401 stops the uploads until the next message', async () => {
    const { rt, clock, uploads, events } = runtime({ answers: [{ outcome: 'fatal', status: 401, code: 'unauthorized', message: 'the relay rejected the write secret' }] });
    rt.receive({ topic: 't_oee', payload: 81 }, 'n1');
    await clock.advance(0);
    await clock.advance(600000);
    assert.equal(uploads.length, 1);
    const err = events.find((e) => e.type === 'error');
    assert.match(err.message, /write secret/);
    assert.deepEqual(err.sources, ['n1']);
    rt.receive({ topic: 't_oee', payload: 82 });
    await clock.advance(0);
    assert.equal(uploads.length, 2);
});

test('an invalid value is refused and the document stays as it was', async () => {
    const { rt, clock, uploads } = runtime();
    // A progress without range fails the schema, whatever the value.
    assert.throws(() => rt.receive({ topic: 't_shift', payload: { range: null } }), ValidationError);
    assert.throws(() => rt.receive({ topic: 't_oee', payload: 'hoch' }), InputError);
    await clock.advance(60000);
    assert.equal(uploads.length, 0);
    rt.receive({ topic: 't_oee', payload: 81 });
    await clock.advance(0);
    assert.ok(tileOf(uploads[0].doc, 't_shift').range, 'the refused change never reached the document');
});

test('a document the schema refuses names the fault and what the broken tile takes', () => {
    const { rt } = runtime();
    // What a first user wrote: a step series with a start from Date.toString().
    const series = [{ name: 'Ist', start: 'Sat Oct 03 2026 00:39:48 GMT+0200', stepSec: 3600, points: [1, 2] }];
    assert.throws(() => rt.receive({ topic: 't_takt', payload: { series } }), (e) => e instanceof ValidationError &&
        /^tile "t_takt" \/series\/0\/start: timestamp must end in Z/.test(e.message) &&
        /\. A line takes a number \(is appended to the series/.test(e.message) &&
        !/missing required field samples/.test(e.message));
});

test('the sent event names the nodes that contributed and carries no secret', async () => {
    const { rt, clock, events } = runtime({ writeSecret: 'ws_' + 'a'.repeat(43) });
    rt.receive({ topic: 't_oee', payload: 81 }, 'n1');
    rt.receive({ topic: 't_shift', payload: 600 }, 'n2');
    await clock.advance(0);
    const sent = events.find((e) => e.type === 'sent');
    assert.deepEqual(sent.sources.sort(), ['n1', 'n2']);
    assert.doesNotMatch(JSON.stringify(sent.report), /ws_|ct|nonce/);
});

test('close stops every timer', async () => {
    const { rt, clock, uploads } = runtime();
    rt.receive({ topic: 't_oee', payload: 81 });
    rt.close();
    await clock.advance(60000);
    assert.equal(uploads.length, 0);
    assert.equal(clock.pending(), 0);
});

test('the first real value replaces the template points of a series, later ones append', async () => {
    const { rt, clock, uploads } = runtime();
    // Earlier than the template's last sample: fine, the template history is not real.
    rt.receive({ topic: 't_takt', payload: 31.5, timestamp: '2026-09-22T18:00:00Z' });
    rt.receive({ topic: 't_takt', payload: 31.7 });
    await clock.advance(0);
    const samples = tileOf(uploads[0].doc, 't_takt').series[0].samples;
    assert.deepEqual(samples, [['2026-09-22T18:00:00Z', 31.5], ['2026-09-22T18:40:00Z', 31.7]]);
});

test('the first real state replaces the template segments of a lane', async () => {
    const { rt, clock, uploads } = runtime();
    rt.receive({ topic: 't_history', payload: 'run' });
    await clock.advance(0);
    const lane = tileOf(uploads[0].doc, 't_history').lanes[0];
    assert.deepEqual(lane.segments, [['2026-09-22T18:40:00Z', 'run']]);
});

test('a refused value does not count as real data', async () => {
    const { rt, clock, uploads } = runtime();
    assert.throws(() => rt.receive({ topic: 't_takt', payload: 'x' }), InputError);
    rt.receive({ topic: 't_oee', payload: 81 });
    await clock.advance(0);
    assert.ok(tileOf(uploads[0].doc, 't_takt').series[0].samples.length > 1, 'template points still there');
});

// The state a restart restores (nodes/andon-view.js keeps it in the node context as
// { stamp, doc, fingerprint, live }). A persistent context store writes it as JSON,
// and a store written by one version is read by the next: these tests pin that
// shape and what a runtime does with it.
async function savedState(messages) {
    const { rt, clock, events } = runtime();
    messages.forEach((m) => rt.receive(m));
    await clock.advance(0);
    const sent = events.filter((e) => e.type === 'sent').pop();
    return JSON.parse(JSON.stringify({ doc: sent.doc, fingerprint: sent.fingerprint, live: sent.live }));
}

test('the sent event carries the state a restart restores, and it survives JSON', async () => {
    const saved = await savedState([{ topic: 't_takt', payload: 31.5 }]);
    assert.deepEqual(Object.keys(saved).sort(), ['doc', 'fingerprint', 'live']);
    assert.ok(Array.isArray(saved.doc.tiles));
    assert.match(saved.fingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual(saved.live, ['t_takt|series|' + tileOf(saved.doc, 't_takt').series[0].name]);
});

test('a restored state goes on where it stopped', async () => {
    const saved = await savedState([{ topic: 't_takt', payload: 31.5 }]);
    const { rt, clock, uploads } = runtime({ restored: saved });
    await clock.advance(1000);
    rt.receive({ topic: 't_takt', payload: 31.7 });
    rt.receive({ topic: 't_history', payload: 'run' });
    await clock.advance(0);
    const samples = tileOf(uploads[0].doc, 't_takt').series[0].samples;
    assert.deepEqual(samples.slice(-2), [['2026-09-22T18:40:00Z', 31.5], ['2026-09-22T18:40:01Z', 31.7]], 'appended, not replaced');
    assert.deepEqual(tileOf(uploads[0].doc, 't_history').lanes[0].segments, [['2026-09-22T18:40:01Z', 'run']],
        'a lane the restored state never touched still starts over from the template');
    assert.equal(uploads[0].env.notify, false, 'the statuses are the ones last sent: nothing to wake');
});

test('a restored state from a whole document counts everything as real', async () => {
    const doc = template();
    const saved = await savedState([{ payload: doc }]);
    assert.equal(saved.live, null);
    const { rt, clock, uploads } = runtime({ restored: saved });
    const before = tileOf(saved.doc, 't_takt').series[0].samples.length;
    rt.receive({ topic: 't_takt', payload: 31.7 });
    await clock.advance(0);
    assert.equal(tileOf(uploads[0].doc, 't_takt').series[0].samples.length, Math.min(before + 1, 60));
});
