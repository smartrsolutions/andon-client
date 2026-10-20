'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { apply, finish, InputError, statusFromBands } = require('@smartrsolutions/andon-client/runtime');
const { validate } = require('@smartrsolutions/andon-client/runtime');
const { template } = require('../testdata/fixtures');

const NOW = Date.parse('2026-09-22T18:40:00Z');
const opts = (extra) => Object.assign({ now: NOW, window: { points: 60, ageSec: 0 } }, extra);
const tile = (doc, id) => doc.tiles.find((t) => t.id === id);

test('a number for a gauge replaces its value and leaves every other tile alone', () => {
    const doc = template();
    const { doc: next, changed } = apply(doc, { topic: 't_oee', payload: 81.2 }, opts());
    assert.deepEqual(changed, ['t_oee']);
    assert.equal(tile(next, 't_oee').value, 81.2);
    assert.equal(tile(doc, 't_oee').value, 79.3, 'the input document is not touched');
    assert.deepEqual(next.tiles.filter((t) => t.id !== 't_oee'), doc.tiles.filter((t) => t.id !== 't_oee'));
});

test('numeric text from MQTT becomes a number', () => {
    const { doc } = apply(template(), { topic: 't_oee', payload: ' 81.5 ' }, opts());
    assert.equal(tile(doc, 't_oee').value, 81.5);
});

test('text for a gauge is refused and names the tile', () => {
    assert.throws(() => apply(template(), { topic: 't_oee', payload: 'hoch' }, opts()), (e) => e instanceof InputError && /t_oee/.test(e.message));
});

test('a label keeps the type of its template value', () => {
    const doc = template();
    assert.equal(tile(apply(doc, { topic: 't_line', payload: 'Störung' }, opts()).doc, 't_line').value, 'Störung');
    assert.equal(tile(apply(doc, { topic: 't_order', payload: '1800' }, opts()).doc, 't_order').value, 1800);
});

test('a number for a line is appended as a sample and becomes its value', () => {
    const doc = template();
    const before = tile(doc, 't_takt').series[0].samples.length;
    const { doc: next } = apply(doc, { topic: 't_takt', payload: 31.9 }, opts());
    const s = tile(next, 't_takt').series[0].samples;
    assert.equal(s.length, before + 1);
    assert.deepEqual(s[s.length - 1], ['2026-09-22T18:40:00Z', 31.9]);
    assert.equal(tile(next, 't_takt').value, 31.9);
});

test('an array for a line replaces the series with its [timestamp, value] pairs', () => {
    const samples = [['2026-09-22T18:00:00Z', 30.1], ['2026-09-22T18:30:00Z', 31.4]];
    const { doc } = apply(template(), { topic: 't_takt', payload: samples }, opts());
    assert.deepEqual(tile(doc, 't_takt').series[0].samples, samples);
    assert.deepEqual(validate(doc).errors, []);
});

test('an array of pairs replaces a step series too, and later numbers append to it', () => {
    const pairs = [['2026-09-22T18:00:00Z', 120], ['2026-09-22T18:30:00Z', 130]];
    const { doc } = apply(template(), { topic: 't_pieces_hour', payload: pairs, series: 'Target' }, opts());
    assert.deepEqual(tile(doc, 't_pieces_hour').series[1], { name: 'Target', samples: pairs });
    assert.deepEqual(validate(doc).errors, []);

    // live as the runtime keeps it: a series the array filled is data, not template.
    const first = apply(template(), { topic: 't_takt', payload: pairs }, opts({ live: new Set() }));
    const live = new Set(first.touched);
    const { doc: next } = apply(first.doc, { topic: 't_takt', payload: 140 }, opts({ live }));
    assert.equal(tile(next, 't_takt').series[0].samples.length, 3);
    assert.equal(tile(next, 't_takt').value, 140);
});

test('the window keeps a series at its last n points', () => {
    const { doc } = apply(template(), { topic: 't_takt', payload: 31.9 }, opts({ window: { points: 5, ageSec: 0 } }));
    const s = tile(doc, 't_takt').series[0].samples;
    assert.equal(s.length, 5);
    assert.deepEqual(s[4], ['2026-09-22T18:40:00Z', 31.9]);
});

test('the window drops samples older than ageSec', () => {
    const { doc } = apply(template(), { topic: 't_takt', payload: 31.9 }, opts({ window: { points: 0, ageSec: 600 } }));
    const s = tile(doc, 't_takt').series[0].samples;
    assert.ok(s.every((p) => Date.parse(p[0]) >= NOW - 600000));
});

test('msg.timestamp sets the sample time, and an older one is refused', () => {
    const { doc } = apply(template(), { topic: 't_takt', payload: 31, timestamp: '2026-09-22T18:35:12.700Z' }, opts());
    const s = tile(doc, 't_takt').series[0].samples;
    assert.equal(s[s.length - 1][0], '2026-09-22T18:35:12Z');
    assert.throws(() => apply(doc, { topic: 't_takt', payload: 30, timestamp: '2026-09-22T18:00:00Z' }, opts()), /older than the last sample/);
});

test('msg.series picks a series by name', () => {
    assert.throws(() => apply(template(), { topic: 't_takt', payload: 1, series: 'Soll' }, opts()), /no series "Soll"/);
});

test('an array replaces the values of a bar over categories', () => {
    const doc = template();
    const t = tile(doc, 't_scrap_station');
    const values = t.categories.map((_, i) => i);
    const { doc: next } = apply(doc, { topic: 't_scrap_station', payload: values }, opts());
    assert.deepEqual(tile(next, 't_scrap_station').series[0].values, values);
});

test('an object sets fields, null removes one, id and view are refused', () => {
    const doc = template();
    const { doc: next } = apply(doc, { topic: 't_oee', payload: { value: 70, status: 'critical', subtext: null } }, opts());
    const t = tile(next, 't_oee');
    assert.equal(t.value, 70);
    assert.equal(t.status, 'critical');
    assert.equal('subtext' in t, false);
    assert.throws(() => apply(doc, { topic: 't_oee', payload: { view: 'label' } }, opts()), /comes from the template/);
});

test('a payload without topic updates several tiles at once', () => {
    const { doc, changed } = apply(template(), { payload: { t_oee: 80, t_shift: 600 } }, opts());
    assert.deepEqual(changed, ['t_oee', 't_shift']);
    assert.equal(tile(doc, 't_shift').value, 600);
});

test('a whole view document replaces the state', () => {
    const replacement = template();
    replacement.name = 'Andere';
    const { doc, replaced } = apply(template(), { payload: replacement }, opts());
    assert.equal(replaced, true);
    assert.equal(doc.name, 'Andere');
});

test('an unknown tile names the ones there are', () => {
    assert.throws(() => apply(template(), { topic: 't_nope', payload: 1 }, opts()), /no tile "t_nope"; it has "t_line"/);
});

test('the same value again is no change', () => {
    const doc = template();
    const { doc: next, changed } = apply(doc, { topic: 't_oee', payload: 79.3 }, opts());
    assert.deepEqual(changed, []);
    assert.equal(next, doc);
});

test('a state ID appends a timeline segment, the same state again appends nothing', () => {
    const doc = template();
    const t = tile(doc, 't_history');
    const lane = t.lanes[0];
    const other = t.states.find((s) => s.id !== lane.segments[lane.segments.length - 1][1]).id;
    const { doc: next } = apply(doc, { topic: 't_history', payload: other }, opts());
    const segs = tile(next, 't_history').lanes[0].segments;
    assert.deepEqual(segs[segs.length - 1], ['2026-09-22T18:40:00Z', other]);
    assert.deepEqual(apply(next, { topic: 't_history', payload: other }, opts({ now: NOW + 60000 })).changed, []);
    assert.throws(() => apply(doc, { topic: 't_history', payload: 'party' }, opts()), /no state "party"/);
});

test('moving from forward trims a lane to the state running at from', () => {
    const doc = template();
    const t = tile(doc, 't_history');
    const segs = t.lanes[0].segments;
    const cut = Date.parse(segs[1][0]) + 1000;
    const from = new Date(cut).toISOString().replace(/\.\d+Z$/, 'Z');
    const { doc: next } = apply(doc, { topic: 't_history', payload: { from } }, opts());
    // Setting from trims at once, so no segment starts before it in between.
    const after = tile(next, 't_history').lanes[0].segments;
    assert.equal(after[0][0], from);
    assert.equal(after[0][1], segs[1][1]);
    assert.equal(after.length, segs.length - 1);
    const check = validate(finish(next, { now: NOW, staleAfterSec: 90 }));
    assert.doesNotMatch(check.warnings.map((w) => w.message).join('\n'), /starts before from/);
});

test('status from bands is opt-in and an explicit status wins', () => {
    const doc = template();
    assert.equal(tile(apply(doc, { topic: 't_oee', payload: 50 }, opts()).doc, 't_oee').status, 'warning', 'off: the template status stays');
    const derive = new Set(['t_oee']);
    assert.equal(tile(apply(doc, { topic: 't_oee', payload: 50 }, opts({ derive })).doc, 't_oee').status, 'critical');
    assert.equal(tile(apply(doc, { topic: 't_oee', payload: 90 }, opts({ derive })).doc, 't_oee').status, 'ok');
    assert.equal(tile(apply(doc, { topic: 't_oee', payload: { value: 50, status: 'ok' } }, opts({ derive })).doc, 't_oee').status, 'ok');
    assert.equal(statusFromBands({ value: 200, bands: [{ to: 10, status: 'ok' }, { to: 20, status: 'critical' }] }), 'critical');
});

test('every update above still yields a valid document', () => {
    const msgs = [
        { topic: 't_oee', payload: 81 },
        { topic: 't_takt', payload: 31.9 },
        { topic: 't_line', payload: 'Störung' },
        { payload: { t_shift: 600, t_order: 1800 } },
    ];
    let doc = template();
    for (const m of msgs) { doc = apply(doc, m, opts()).doc; }
    assert.deepEqual(validate(finish(doc, { now: NOW, staleAfterSec: 90 })).errors, []);
});

test('finish sets generatedAt in whole seconds and staleAfterSec', () => {
    const out = finish(template(), { now: NOW + 999, staleAfterSec: 90 });
    assert.equal(out.generatedAt, '2026-09-22T18:40:00Z');
    assert.equal(out.staleAfterSec, 90);
});
