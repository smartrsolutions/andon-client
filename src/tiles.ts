/**
 * What an update does to the view document: pure functions, no I/O in here.
 *
 * The document is the state. The template from the configurator is the first
 * state; every update changes one or more tiles of it, and what a value means
 * follows from the tile's kind:
 *
 *   label, gauge, progress, donut   a scalar replaces `value`
 *   line, bar without categories    a number is appended to a time series
 *   bar with categories, pie, donut an array replaces the series' `values`
 *   table                           an array replaces `rows`
 *   timeline                        a state ID appends a segment to a lane
 *   every kind                      an object sets the fields it names; null removes one
 *
 * Nothing here decides whether the result is a valid document: that is the
 * validator's job, and the caller rolls the change back when it says no.
 */

import { hint } from './accepts';
import type { Tile, ViewDocument } from './document';
import { API_WORDS, type Words } from './words';

/** How much of a time series is kept: the newest `points`, and none older than `ageSec` (0: no limit). */
export interface SeriesWindow {
    points: number;
    ageSec: number;
}

export const DEFAULT_WINDOW: Readonly<SeriesWindow> = Object.freeze({ points: 60, ageSec: 0 });
export const MAX_SEGMENTS = 200; // the most a lane may carry in a view document

/** A value that does not fit its tile, or an update that names no tile. */
export class InputError extends Error {}

/**
 * One update, in the shape of a Node-RED message:
 *
 *   topic = tile ID, payload = value or fields    one tile
 *   payload = { tileId: value, ... }              several tiles
 *   payload = a whole view document (has tiles)   replaces the state
 */
export interface Update {
    topic?: unknown;
    payload: unknown;
    /** a sample's or a segment's time: milliseconds, a Date or ISO 8601 */
    timestamp?: unknown;
    /** the series a value belongs to, by name; the first one without */
    series?: unknown;
    /** the timeline lane a state belongs to, by name; the first one without */
    lane?: unknown;
}

export interface ApplyOptions {
    now: number;
    window?: SeriesWindow | undefined;
    /** the tiles whose status follows from their bands */
    derive?: ReadonlySet<string> | undefined;
    /** the series and lanes that already hold real data; without it everything counts as real */
    live?: ReadonlySet<string> | undefined;
    words?: Words | undefined;
}

export interface ApplyResult {
    doc: ViewDocument;
    /** the IDs of the tiles that changed */
    changed: string[];
    /** the whole document was replaced */
    replaced: boolean;
    /** the series and lanes that hold real data from now on */
    touched: string[];
}

interface Context {
    now: number;
    window?: SeriesWindow | undefined;
    derive?: ReadonlySet<string> | undefined;
    live?: ReadonlySet<string> | undefined;
    touched: string[];
    timestamp: unknown;
    series: unknown;
    lane: unknown;
    words: Words;
}

/** iso renders a timestamp as a view document demands: UTC, whole seconds, trailing Z. */
export function iso(ms: number): string {
    return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
}

function timestampOf(value: unknown, now: number, words: Words): number {
    if (value === undefined || value === null || value === '') { return now; }
    const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value as string);
    if (!Number.isFinite(ms)) { throw new InputError(words.timestamp + ' is neither milliseconds nor an ISO timestamp: ' + String(value)); }
    return ms;
}

const NUMERIC_KINDS = new Set(['gauge', 'progress', 'line', 'donut']);
const NUMERIC = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/;

/** number takes numbers and numeric strings: MQTT and most PLCs deliver text. */
function number(value: unknown, what: string): number {
    if (typeof value === 'number' && Number.isFinite(value)) { return value; }
    if (typeof value === 'string' && NUMERIC.test(value)) { return Number(value); }
    throw new InputError(what + ' needs a number, got ' + JSON.stringify(value));
}

function clone<T>(value: T): T {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * statusFromBands is the opt-in judgement "status from bands": the band the
 * value falls into. Below range.min counts as the first band, above the last band
 * as the last one. The app never does this itself: a status is the producer's
 * judgement.
 */
export function statusFromBands(tile: Tile): string | undefined {
    if (!Array.isArray(tile.bands) || !tile.bands.length || typeof tile.value !== 'number') { return undefined; }
    for (const band of tile.bands) {
        if (tile.value <= band.to) { return band.status; }
    }
    return tile.bands[tile.bands.length - 1].status;
}

function pickSeries(tile: Tile, name: unknown): any {
    if (!Array.isArray(tile.series) || !tile.series.length) {
        throw new InputError('tile "' + tile.id + '" has no series in the template');
    }
    if (name === undefined || name === null || name === '') { return tile.series[0]; }
    const found = tile.series.find((s: any) => s.name === name);
    if (!found) {
        throw new InputError('tile "' + tile.id + '" has no series "' + String(name) + '"; it has ' +
            tile.series.map((s: any) => '"' + s.name + '"').join(', '));
    }
    return found;
}

/**
 * fromTemplate says whether a series or lane still holds the template's points.
 * Those are start values drawn in the configurator, not measurements: the first
 * real value replaces them rather than being appended to made-up history. The
 * caller passes ctx.live (what already holds real data) and records ctx.touched
 * once the change is accepted; without ctx.live everything counts as real.
 */
function fromTemplate(ctx: Context, key: string): boolean {
    const seen = ctx.touched.includes(key);
    if (!seen) { ctx.touched.push(key); }
    return !!ctx.live && !ctx.live.has(key) && !seen;
}

/**
 * markReal records that a series or lane holds real data now, so the next value
 * appended to it keeps it: a whole series sent as an array or an object is a
 * measurement, not the template's start values.
 */
function markReal(ctx: Context, key: string): void {
    if (!ctx.touched.includes(key)) { ctx.touched.push(key); }
}

function appendSample(tile: Tile, value: number, ctx: Context): void {
    const series = pickSeries(tile, ctx.series);
    if (series.points || series.values) {
        throw new InputError('tile "' + tile.id + '": appending needs a series with samples; "' + series.name +
            '" uses ' + (series.points ? 'stepSec and points' : 'values'));
    }
    if (fromTemplate(ctx, tile.id + '|series|' + series.name)) { series.samples = []; }
    const samples: [string, number][] = Array.isArray(series.samples) ? series.samples : (series.samples = []);
    const at = timestampOf(ctx.timestamp, ctx.now, ctx.words);
    const stamp = iso(at);
    const last = samples[samples.length - 1];
    if (last && Date.parse(last[0]) > Date.parse(stamp)) {
        throw new InputError('tile "' + tile.id + '": ' + stamp + ' is older than the last sample ' + last[0]);
    }
    if (last && last[0] === stamp) {
        last[1] = value; // two values within one second: the later one wins
    } else {
        samples.push([stamp, value]);
    }
    const window = ctx.window || DEFAULT_WINDOW;
    if (window.ageSec > 0) {
        const oldest = at - window.ageSec * 1000;
        while (samples.length > 1 && Date.parse(samples[0][0]) < oldest) { samples.shift(); }
    }
    if (window.points > 0 && samples.length > window.points) {
        samples.splice(0, samples.length - window.points);
    }
    if (tile.view === 'line') { tile.value = value; }
}

function appendSegment(tile: Tile, stateId: string, ctx: Context): boolean {
    const states = Array.isArray(tile.states) ? tile.states : [];
    if (!states.some((s: any) => s.id === stateId)) {
        throw new InputError('tile "' + tile.id + '" has no state "' + stateId + '"; it has ' +
            states.map((s: any) => '"' + s.id + '"').join(', '));
    }
    const lanes = Array.isArray(tile.lanes) ? tile.lanes : [];
    const lane = ctx.lane === undefined || ctx.lane === null || ctx.lane === ''
        ? lanes[0]
        : lanes.find((l: any) => l.name === ctx.lane);
    if (!lane) {
        throw new InputError('tile "' + tile.id + '" has no lane' + (ctx.lane ? ' "' + String(ctx.lane) + '"' : '') +
            (lanes.length ? '; it has ' + lanes.map((l: any) => '"' + l.name + '"').join(', ') : ''));
    }
    if (fromTemplate(ctx, tile.id + '|lane|' + lane.name)) { lane.segments = []; }
    const segments: [string, string][] = Array.isArray(lane.segments) ? lane.segments : (lane.segments = []);
    const last = segments[segments.length - 1];
    if (last && last[1] === stateId) { return false; } // the state goes on; nothing to record
    const stamp = iso(timestampOf(ctx.timestamp, ctx.now, ctx.words));
    if (last && Date.parse(last[0]) > Date.parse(stamp)) {
        throw new InputError('tile "' + tile.id + '": ' + stamp + ' is older than the last segment ' + last[0]);
    }
    if (last && last[0] === stamp) {
        last[1] = stateId;
    } else {
        segments.push([stamp, stateId]);
    }
    trimSegments(tile, segments);
    return true;
}

/**
 * trimSegments keeps a lane inside the tile: at most 200 segments, and nothing
 * that starts before `from` except the one state that was running at `from`,
 * which then starts there. So moving `from` forward is all a rolling timeline needs.
 */
function trimSegments(tile: Tile, segments: [string, string][]): void {
    const from = Date.parse(tile.from);
    if (Number.isFinite(from)) {
        let firstInside = segments.findIndex((s) => Date.parse(s[0]) >= from);
        if (firstInside === -1) { firstInside = segments.length; }
        if (firstInside > 0) {
            const running = segments[firstInside - 1];
            segments.splice(0, firstInside - 1);
            // tile.from verbatim, not iso(from): a `from` with milliseconds is
            // valid, and rounding it down would start the segment before it.
            if (Date.parse(running[0]) < from) { running[0] = tile.from; }
            if (segments[1] && segments[1][0] === running[0]) { segments.shift(); }
        }
    }
    if (segments.length > MAX_SEGMENTS) { segments.splice(0, segments.length - MAX_SEGMENTS); }
}

function setFields(tile: Tile, fields: Record<string, unknown>): boolean {
    for (const key of Object.keys(fields)) {
        if (key === 'id' || key === 'view') {
            throw new InputError('tile "' + tile.id + '": "' + key + '" comes from the template and cannot be changed by a message');
        }
        if (fields[key] === null) {
            delete tile[key];
        } else {
            tile[key] = clone(fields[key]);
        }
    }
    if (typeof tile.value === 'string' && NUMERIC_KINDS.has(tile.view)) {
        tile.value = number(tile.value, 'tile "' + tile.id + '", value');
    }
    // A new `from` trims every lane at once, not only at the next state change: a
    // rolling timeline moves `from` on every tick, and in between the segments would
    // start before it.
    if (tile.view === 'timeline' && Object.prototype.hasOwnProperty.call(fields, 'from') && Array.isArray(tile.lanes)) {
        tile.lanes.forEach((lane: any) => { if (lane && Array.isArray(lane.segments)) { trimSegments(tile, lane.segments); } });
    }
    return Object.prototype.hasOwnProperty.call(fields, 'status');
}

/**
 * updateTile returns the changed copy of one tile, or the tile itself when the
 * update changed nothing. It throws InputError when the value does not fit the tile.
 */
function updateTile(tile: Tile, payload: unknown, ctx: Context): Tile {
    const next = clone(tile);
    const kind = next.view;
    const categories = Array.isArray(next.categories);
    let statusGiven = false;
    let changed = true;

    if (payload === null || payload === undefined) {
        throw new InputError('tile "' + tile.id + '": ' + ctx.words.payload + ' is empty');
    } else if (Array.isArray(payload)) {
        if ((kind === 'bar' && categories) || kind === 'pie' || kind === 'donut') {
            pickSeries(next, ctx.series).values = payload.map((v, i) => v === null ? null : number(v, 'tile "' + tile.id + '", value ' + (i + 1)));
        } else if (kind === 'table') {
            next.rows = payload.map((row) => Array.isArray(row) ? { cells: clone(row) } : clone(row));
        } else if (kind === 'line' || kind === 'bar') {
            // The series in whatever form it had becomes one of samples: an array of
            // pairs replaces a step series too, rather than sitting next to its points.
            const series = pickSeries(next, ctx.series);
            next.series[next.series.indexOf(series)] = { name: series.name, samples: clone(payload) };
            markReal(ctx, tile.id + '|series|' + series.name);
            const last = payload[payload.length - 1];
            if (kind === 'line' && Array.isArray(last) && typeof last[1] === 'number') { next.value = last[1]; }
        } else {
            throw new InputError('tile "' + tile.id + '" takes no array');
        }
    } else if (typeof payload === 'object') {
        const fields = payload as Record<string, unknown>;
        statusGiven = setFields(next, fields);
        (Array.isArray(fields.series) ? fields.series : []).forEach((s: any) => { if (s && s.name) { markReal(ctx, tile.id + '|series|' + s.name); } });
        (Array.isArray(fields.lanes) ? fields.lanes : []).forEach((l: any) => { if (l && l.name) { markReal(ctx, tile.id + '|lane|' + l.name); } });
    } else if (kind === 'label') {
        // A label keeps the type its template gave it: "79.3" from MQTT stays a
        // number when the template has a number, and "Läuft" stays a text.
        const numeric = typeof payload === 'number' || (typeof tile.value === 'number' && NUMERIC.test(String(payload)));
        next.value = numeric ? number(payload, 'tile "' + tile.id + '"') : String(payload);
    } else if (kind === 'gauge' || kind === 'progress' || kind === 'donut') {
        next.value = number(payload, 'tile "' + tile.id + '"');
    } else if (kind === 'line' || (kind === 'bar' && !categories)) {
        appendSample(next, number(payload, 'tile "' + tile.id + '"'), ctx);
    } else if (kind === 'timeline') {
        changed = appendSegment(next, String(payload), ctx);
    } else {
        throw new InputError('tile "' + tile.id + '" takes no single value');
    }

    if (!changed) { return tile; }
    if (!statusGiven && ctx.derive && ctx.derive.has(next.id)) {
        const status = statusFromBands(next);
        if (status) { next.status = status; }
    }
    return next;
}

/**
 * apply works out what one update means for the document and returns the new
 * document plus the IDs of the tiles that changed. It never changes `doc`.
 */
export function apply(doc: ViewDocument | null, update: Update, options: ApplyOptions): ApplyResult {
    const words = options.words || API_WORDS;
    const ctx: Context = {
        now: options.now,
        window: options.window,
        derive: options.derive,
        live: options.live,
        touched: [],
        timestamp: update.timestamp,
        series: update.series,
        lane: update.lane,
        words,
    };
    const topic = typeof update.topic === 'string' ? update.topic.trim() : '';
    const payload = update.payload as any;

    if (!topic && payload && typeof payload === 'object' && Array.isArray(payload.tiles)) {
        return { doc: clone(payload), changed: payload.tiles.map((t: any) => t && t.id), replaced: true, touched: [] };
    }
    if (!doc || !Array.isArray(doc.tiles)) {
        throw new InputError('there is no template yet: ' + words.template + ', or send a whole view document first');
    }

    let updates: [string, unknown][];
    if (topic) {
        updates = [[topic, payload]];
    } else if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        updates = Object.entries(payload);
        if (!updates.length) { throw new InputError(words.payload + ' names no tile'); }
    } else {
        throw new InputError(words.topic + ' is missing: set it to the ID of the tile this value belongs to');
    }

    const next: ViewDocument = Object.assign({}, doc, { tiles: doc.tiles.slice() });
    const changed: string[] = [];
    for (const [id, value] of updates) {
        const index = next.tiles.findIndex((t) => t.id === id);
        if (index === -1) {
            throw new InputError('the view has no tile "' + id + '"; it has ' + next.tiles.map((t) => '"' + t.id + '"').join(', '));
        }
        let tile: Tile;
        try {
            tile = updateTile(next.tiles[index], value, ctx);
        } catch (err) {
            // The refusal says what was wrong; the hint says what would have been right.
            const says = err instanceof InputError ? hint(next.tiles[index], words) : '';
            throw says ? new InputError((err as Error).message + '. ' + says) : err;
        }
        // The same value again is no change: it keeps the view alive (see
        // view.ts, heartbeat) but is no reason for an upload of its own.
        if (tile !== next.tiles[index] && JSON.stringify(tile) !== JSON.stringify(next.tiles[index])) {
            next.tiles[index] = tile;
            changed.push(id);
        }
    }
    return { doc: changed.length ? next : doc, changed, replaced: false, touched: ctx.touched };
}

/** finish fills in what the source never sends itself: when, and how long it holds. */
export function finish(doc: ViewDocument, { now, staleAfterSec }: { now: number; staleAfterSec: number }): ViewDocument {
    const out: ViewDocument = Object.assign({}, doc, { generatedAt: iso(now) });
    if (staleAfterSec > 0) { out.staleAfterSec = staleAfterSec; }
    return out;
}
