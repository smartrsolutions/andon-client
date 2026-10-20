/**
 * What a tile takes, read off the tile itself: its kind, whether it has
 * categories, how many series or lanes it has, and which form its first series
 * uses - a series in the step form (start, stepSec, points) takes no single number,
 * because there is no timestamp to append it at.
 *
 * The runtime half of the Node-RED package's resources/accepts.js: the hint a
 * refused value gets. The editor half (the dialog's list, the example function
 * node) stays in the Node-RED package, which serves it to the browser. A test
 * there holds this hint, in the Node-RED words, to that file's word for word.
 */

import type { Tile } from './document';
import { API_WORDS, type Words } from './words';

export interface Form {
    /** names the wording */
    key: string;
    /** what the wording needs (count, states) */
    params: Record<string, string | number>;
    /** a value to show */
    example: unknown;
    /** further parts of the update the form needs, by name: timestamp, series, lane */
    extra: Record<string, { example: unknown }>;
}

function text(w: Words): Record<string, { payload: string; effect: string }> {
    return {
        text: { payload: 'a text or a number', effect: 'replaces the value' },
        number: { payload: 'a number', effect: 'replaces the value' },
        append: { payload: 'a number', effect: 'is appended to the series, at the time it arrives' },
        appendAt: { payload: 'a number with ' + w.timestamp, effect: 'is appended at that time, in milliseconds or ISO 8601' },
        appendTo: { payload: 'a number with ' + w.series, effect: 'is appended to the series of that name' },
        pairs: { payload: 'an array of [timestamp, value] pairs', effect: 'replaces the series; ' + w.series + ' picks which' },
        samples: { payload: 'an object {series: [{name, samples}]}', effect: 'replaces every series' },
        steps: { payload: 'an object {series: [{name, start, stepSec, points}]}', effect: 'replaces every series: a point every stepSec from start, in UTC' },
        values: { payload: 'an array of numbers, one per category', effect: 'replaces the values; categories: __count__' },
        valuesTo: { payload: 'an array of numbers with ' + w.series, effect: 'replaces the values of the series of that name' },
        categories: { payload: 'an object {categories, series}', effect: 'replaces the categories and their values together' },
        statuses: { payload: 'an object {series: [{name, values, statuses}]}', effect: 'a verdict per bar: ok, warning, critical or null' },
        rows: { payload: 'an array of rows, each an array of cells', effect: 'replaces the rows; columns: __count__' },
        rowStatus: { payload: 'an array of {cells, status}', effect: 'replaces the rows, with a status per row' },
        state: { payload: 'a state ID (__states__)', effect: 'starts a new segment, at the time it arrives' },
        stateAt: { payload: 'a state ID with ' + w.timestamp, effect: 'starts the segment at that time' },
        stateLane: { payload: 'a state ID with ' + w.lane, effect: 'starts a segment in the lane of that name' },
        window: { payload: 'an object {from, to}', effect: 'moves the time axis; what lies before from is trimmed' },
        fields: { payload: 'an object of fields, e.g. {"status": "warning"}', effect: 'sets them; null removes one' },
    };
}

// The forms an error message names: what a value alone can be. Objects and forms
// that need a further part of the update are left to the documentation.
const IN_HINT = new Set(['text', 'number', 'append', 'pairs', 'values', 'rows', 'state']);

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function iso(ms: number): string {
    return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
}

function form(key: string, example: unknown, params?: Form['params'], extra?: Form['extra']): Form {
    return { key, params: params || {}, example, extra: extra || {} };
}

function numberOf(tile: Tile, fallback: number): number {
    return typeof tile.value === 'number' ? tile.value : fallback;
}

function seriesOf(tile: Tile): any[] {
    return Array.isArray(tile.series) ? tile.series.filter((s: any) => s && typeof s.name === 'string') : [];
}

// The last few values a series holds, whatever its form: what the examples are made of.
function valuesOf(series: any, fallback: number): number[] {
    let v: unknown[] = Array.isArray(series.samples) ? series.samples.map((p: any) => p && p[1])
        : Array.isArray(series.points) ? series.points : [];
    v = v.filter((x) => typeof x === 'number').slice(-4);
    return v.length ? (v as number[]) : [fallback, fallback + 1, fallback - 1];
}

// [timestamp, value] pairs one minute apart, the last one now.
function pairsOf(values: number[], now: number): unknown[] {
    const n = values.length - 1;
    return values.map((v, i) => [iso(now - (n - i) * MINUTE), v]);
}

function timeSeriesForms(tile: Tile, now: number): Form[] {
    const all = seriesOf(tile);
    if (!all.length) { return []; }
    const vals = all.map((s) => valuesOf(s, numberOf(tile, 42)));
    const last = vals[0][vals[0].length - 1];
    const out: Form[] = [];

    if (!Array.isArray(all[0].points)) {
        out.push(form('append', last));
        out.push(form('appendAt', last, {}, { timestamp: { example: iso(now) } }));
        if (all.length > 1) {
            out.push(form('appendTo', vals[1][vals[1].length - 1], {}, { series: { example: all[1].name } }));
        }
    }
    out.push(form('pairs', pairsOf(vals[0], now)));
    out.push(form('samples', { series: all.map((s, k) => ({ name: s.name, samples: pairsOf(vals[k], now) })) }));
    // The step form with its last point at now.
    out.push(form('steps', {
        series: all.map((s, k) => {
            const step = s.stepSec > 0 ? s.stepSec : 3600;
            return { name: s.name, start: iso(now - (vals[k].length - 1) * step * 1000), stepSec: step, points: vals[k] };
        }),
    }));
    return out;
}

function categoryForms(tile: Tile, kind: string): Form[] {
    const count = tile.categories.length;
    const all = seriesOf(tile);
    const valuesFor = (s: any): unknown[] =>
        s && Array.isArray(s.values) && s.values.length === count ? s.values : tile.categories.map((_: unknown, i: number) => i + 1);
    const out = [form('values', valuesFor(all[0]), { count })];
    if (all.length > 1) {
        out.push(form('valuesTo', valuesFor(all[1]), {}, { series: { example: all[1].name } }));
    }
    out.push(form('categories', {
        categories: tile.categories,
        series: (all.length ? all : [{ name: 'A' }]).map((s) => ({ name: s.name, values: valuesFor(s) })),
    }));
    // A verdict per bar exists only on a bar with categories and exactly one series.
    if (kind === 'bar' && all.length <= 1) {
        const v = valuesFor(all[0]);
        out.push(form('statuses', { series: [{ name: all.length ? all[0].name : 'A', values: v,
            statuses: v.map((_, i) => i === v.length - 1 ? 'critical' : null) }] }));
    }
    return out;
}

function tableForms(tile: Tile): Form[] {
    const columns = Array.isArray(tile.columns) && tile.columns.length ? tile.columns.length : 1;
    const first = Array.isArray(tile.rows) && tile.rows[0] ? tile.rows[0].cells : null;
    const row = Array.isArray(first) && first.length === columns
        ? first
        : Array.from({ length: columns }, (_, i) => i === 0 ? 'A' : i);
    return [form('rows', [row], { count: columns }), form('rowStatus', [{ cells: row, status: 'warning' }])];
}

function timelineForms(tile: Tile, now: number): Form[] {
    const states = (Array.isArray(tile.states) ? tile.states : []).map((s: any) => s && s.id).filter(Boolean);
    if (!states.length) { return []; }
    const lanes = (Array.isArray(tile.lanes) ? tile.lanes : []).filter((l: any) => l && typeof l.name === 'string');
    const out = [
        form('state', states[0], { states: states.join(', ') }),
        form('stateAt', states[0], {}, { timestamp: { example: iso(now) } }),
    ];
    if (lanes.length > 1) {
        out.push(form('stateLane', states[0], {}, { lane: { example: lanes[1].name } }));
    }
    out.push(form('window', { from: iso(now - 8 * HOUR), to: iso(now) }));
    return out;
}

/** forms returns every form the tile takes, the most common first. */
export function forms(tile: Tile, now?: number): Form[] {
    if (!tile || typeof tile !== 'object') { return []; }
    const at = typeof now === 'number' ? now : Date.now();
    const categories = Array.isArray(tile.categories);
    let out: Form[];
    switch (tile.view) {
        case 'label':
            out = [form('text', typeof tile.value === 'number' || typeof tile.value === 'string' ? tile.value : 'Running')];
            break;
        case 'gauge':
        case 'progress':
            out = [form('number', numberOf(tile, 0))];
            break;
        case 'donut':
            out = [form('number', numberOf(tile, 0))].concat(categories ? categoryForms(tile, 'donut') : []);
            break;
        case 'pie':
            out = categories ? categoryForms(tile, 'pie') : [];
            break;
        case 'bar':
            out = categories ? categoryForms(tile, 'bar') : timeSeriesForms(tile, at);
            break;
        case 'line':
            out = timeSeriesForms(tile, at);
            break;
        case 'table':
            out = tableForms(tile);
            break;
        case 'timeline':
            out = timelineForms(tile, at);
            break;
        default:
            return [];
    }
    if (!out.length) { return []; }
    out.push(form('fields', { status: 'warning' }));
    return out;
}

function fill(s: string, params: Form['params']): string {
    return s.replace(/__(\w+)__/g, (m, name: string) => params[name] === undefined ? m : String(params[name]));
}

/** describe is the English wording of one form: "a number (replaces the value)". */
export function describe(f: Form, words: Words = API_WORDS): string {
    const t = text(words)[f.key];
    return fill(t.payload, f.params) + ' (' + fill(t.effect, f.params) + ')';
}

/**
 * hint is one English sentence for an error message: what a value for the tile
 * can be. A refused value is the moment someone needs it. Objects and forms that
 * need a further part of the update are left out.
 */
export function hint(tile: Tile | undefined, words: Words = API_WORDS): string {
    if (!tile) { return ''; }
    const list = forms(tile).filter((f) => IN_HINT.has(f.key)).map((f) => describe(f, words));
    if (!list.length) { return ''; }
    const kind = tile.view + (Array.isArray(tile.categories) ? ' with categories' : '');
    const last = list.pop();
    return 'A ' + kind + ' takes ' + (list.length ? list.join(', ') + ' or ' : '') + last;
}
