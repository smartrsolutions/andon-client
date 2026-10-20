'use strict';
/**
 * The semantic rules against the configurator's: the same verdict, and a warning
 * wherever the configurator warns. Each case changes one thing in the sample
 * document.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { validate } = require('@smartrsolutions/andon-client/runtime');
const { template } = require('../testdata/fixtures');

const tile = (doc, id) => doc.tiles.find((t) => t.id === id);
const messages = (issues) => issues.map((i) => i.path + ' ' + i.message);

function variant(change) {
    const doc = template();
    change(doc);
    return validate(doc);
}

test('the sample document has no errors and no warnings', () => {
    const r = validate(template());
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
});

test('samples out of order are a warning, as in the configurator, not an error', () => {
    const r = variant((d) => { tile(d, 't_takt').series[0].samples.reverse(); });
    assert.deepEqual(r.errors, []);
    assert.match(messages(r.warnings).join('\n'), /timestamps not ascending/);
});

test('segments out of order are an error', () => {
    const r = variant((d) => { tile(d, 't_history').lanes[0].segments.reverse(); });
    assert.match(messages(r.errors).join('\n'), /segments must be ascending/);
});

test('each warning of the configurator is raised', () => {
    const cases = [
        [(d) => { tile(d, 't_oee').target = 120; }, /target lies outside range/],
        [(d) => { tile(d, 't_oee').bands[2].to = 90; }, /last band ends before range.max/],
        [(d) => { tile(d, 't_oee').status = 'ok'; }, /"ok", but the value sits in the "warning" band/],
        [(d) => { delete tile(d, 't_oee').titleShort; tile(d, 't_oee').title = 'Gesamtanlageneffektivität'; }, /title is cut in small widgets/],
        [(d) => { const t = tile(d, 't_defects'); t.categories = 'abcdefghi'.split(''); t.series[0].values = t.categories.map(() => 1); }, /more than 8 categories/],
        [(d) => { tile(d, 't_scrap_station').series[0].statuses.pop(); }, /statuses but .* values/],
        [(d) => { const s = tile(d, 't_scrap_station').series[0]; s.statuses = s.values.map(() => 'ok'); }, /every bar ok/],
        [(d) => { tile(d, 't_stations').rows[0].cells.pop(); }, /cells but .* columns/],
        [(d) => { tile(d, 't_line').subtext = 'seit 3 Minuten ago'; }, /time of day rather than duration/],
        [(d) => { d.staleAfterSec = 10; }, /very small/],
        [(d) => { const t = tile(d, 't_history'); t.from = t.lanes[0].segments[1][0]; }, /starts before from/],
    ];
    for (const [change, expected] of cases) {
        const r = variant(change);
        assert.deepEqual(r.errors, [], String(expected));
        assert.match(messages(r.warnings).join('\n'), expected);
    }
});

test('a document too large to seal is an error, also where the configurator still passes it', () => {
    // About 215 KiB of plaintext: under the configurator's 95 % of 256 KiB, but
    // sealed (base64 adds a third) far over what the relay takes.
    const doc = template();
    const stamp = (i) => new Date(Date.parse('2026-09-22T00:00:00Z') + i * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    tile(doc, 't_line').subtext = 'x'.repeat(80);
    doc.tiles = doc.tiles.concat(Array.from({ length: 6 }, (_, k) => ({
        id: 't_pad' + k, view: 'line', title: 'Pad ' + k, value: 1,
        series: [{ name: 'Pad', samples: Array.from({ length: 1100 }, (_, i) => [stamp(i), 32.1]) }],
    })));
    const bytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
    assert.ok(bytes > 262144 * 0.72 && bytes < 262144 * 0.95, bytes + ' bytes');
    const r = validate(doc);
    assert.match(messages(r.errors).join('\n'), /sealed it would pass the 256 KiB limit/);
});

test('a broken series names its own fault, not the other form it does not use', () => {
    // A series has samples or start/stepSec/points. Ajv reports both forms, and
    // a status line showing the first three said "missing samples" about a step
    // series whose start was Date.toString().
    const steps = variant((d) => {
        tile(d, 't_takt').series = [{ name: 'Ist', start: 'Sat Oct 03 2026 00:00:00 GMT+0200', stepSec: 3600, points: [1, 2] }];
    });
    assert.deepEqual(messages(steps.errors), [
        '/tiles/5/series/0/start timestamp must end in Z (UTC), no offset',
        '/tiles/5/series/0/start invalid date-time',
    ]);
    const samples = variant((d) => { tile(d, 't_takt').series = [{ name: 'Ist', samples: [['gestern', 1]] }]; });
    assert.doesNotMatch(messages(samples.errors).join('\n'), /start|stepSec|points/);
    assert.match(messages(samples.errors).join('\n'), /samples\/0\/0 invalid date-time/);
    // Neither form recognisable: both stay, so the message still names what is missing.
    const neither = variant((d) => { tile(d, 't_takt').series = [{ name: 'Ist' }]; });
    assert.match(messages(neither.errors).join('\n'), /missing required field samples[\s\S]*missing required field start/);
});
