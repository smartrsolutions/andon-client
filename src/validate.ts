/**
 * Checks a view document before it is sealed: the schema (schema/view-v1.schema.json)
 * plus the rules the schema cannot express. The rules are those of the Andon
 * configurator, so a document the configurator rejects is rejected here, and the
 * other way round - except for the size limit, which is stricter here (see
 * semanticIssues).
 *
 * The configurator precompiles its validator because a CSP forbids new Function();
 * a Node.js process has no CSP, so this one compiles at load time and needs no
 * build step.
 */

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { ViewDocument } from './document';
import { MAX_ENVELOPE } from './seal';

// Read at run time from the package's schema/, next to dist/: the copy of
// spec/view-v1.schema.json that andon-client-dev checks.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const schema = require('../schema/view-v1.schema.json');

/** One finding. `path` is a JSON pointer into the document. */
export interface Issue {
    level: 'error' | 'warning';
    path: string;
    message: string;
}

export interface Validation {
    /** the document must not be sent */
    errors: Issue[];
    /** it may be sent, but something looks off */
    warnings: Issue[];
}

// verbose: a failed oneOf then carries its branches and the data, which
// narrowOneOf needs to tell which branch was meant.
const ajv = new Ajv2020({ allErrors: true, strict: false, verbose: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

function describe(e: ErrorObject): string {
    const params = e.params as any;
    switch (e.keyword) {
        case 'additionalProperties': return 'unknown field ' + JSON.stringify(params.additionalProperty);
        case 'required': return 'missing required field ' + params.missingProperty;
        case 'false schema': return 'field is not allowed for this tile kind';
        case 'enum': return 'must be one of ' + params.allowedValues.join(', ');
        case 'const': return 'must be exactly ' + JSON.stringify(params.allowedValue);
        case 'format': return 'invalid ' + params.format;
        case 'pattern': return params.pattern === 'Z$' ? 'timestamp must end in Z (UTC), no offset' : 'does not match ' + params.pattern;
        default: return e.message || e.keyword;
    }
}

/**
 * intendedBranch picks the branch of a failed oneOf that the object was meant
 * for: the one that knows the most of its fields. A series with start, stepSec
 * and points means the step form even when its start is broken. Without a clear
 * winner it returns null, and every branch's errors stand.
 */
function intendedBranch(e: ErrorObject): ValidateFunction | null {
    const data = e.data;
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(e.schema)) { return null; }
    let best: ValidateFunction | null = null;
    let bestScore = -1;
    let tie = false;
    for (const branch of e.schema) {
        const check = branch?.$ref ? ajv.getSchema(schema.$id + branch.$ref) : undefined;
        const props = (check?.schema as any)?.properties;
        if (!check || !props) { return null; }
        const score = Object.keys(data).filter((k) => Object.hasOwn(props, k)).length;
        if (score > bestScore) { best = check; bestScore = score; tie = false; } else if (score === bestScore) { tie = true; }
    }
    return tie ? null : best;
}

/**
 * narrowOneOf replaces the errors of every branch of a failed oneOf with those
 * of the branch that was meant. Ajv reports all of them, and the first three -
 * all a status line shows - then say "missing samples" and "unknown field start"
 * about a series whose only fault is the format of its start.
 */
function narrowOneOf(errors: ErrorObject[]): ErrorObject[] {
    let out = errors;
    for (const e of errors) {
        if (e.keyword !== 'oneOf') { continue; }
        const check = intendedBranch(e);
        if (!check || check(e.data)) { continue; }
        const at = e.instancePath;
        const inside = (x: ErrorObject) => x.instancePath === at || x.instancePath.startsWith(at + '/');
        const mine = narrowOneOf(check.errors || []).map((x) => ({ ...x, instancePath: at + x.instancePath }));
        out = out.filter((x) => !inside(x) || x === e).concat(mine);
    }
    return out;
}

function schemaErrors(doc: unknown): Issue[] {
    if (validateSchema(doc)) { return []; }
    const seen = new Set<string>();
    const out: Issue[] = [];
    for (const e of narrowOneOf(validateSchema.errors || [])) {
        // Ajv reports every branch of the if/then tree; the leaves are the useful part.
        if (e.keyword === 'if' || e.keyword === 'allOf' || e.keyword === 'oneOf' || e.keyword === 'anyOf') { continue; }
        const issue: Issue = { level: 'error', path: e.instancePath || '/', message: describe(e) };
        const key = issue.path + '|' + issue.message;
        if (!seen.has(key)) { seen.add(key); out.push(issue); }
    }
    return out;
}

/**
 * semanticIssues follows the configurator's validator rule for rule and in the
 * same order. Three deliberate differences:
 *
 *   - size: an error from 72 % of 256 KiB of plaintext, not 95 %. Sealing adds a
 *     third (base64), so from about 192 KiB the envelope no longer fits and the
 *     relay refuses it; 95 % is too late for a document that is about to be sealed.
 *   - generatedAt in the future or older than staleAfterSec: not checked. The
 *     package sets generatedAt itself, just before sealing.
 *   - "fewer than 3 points": not checked. The first real value replaces the
 *     template's points (tiles.ts), so a fresh series starts at one point on
 *     every start; warning about that would be noise, not advice.
 */
function semanticIssues(doc: any): Issue[] {
    const out: Issue[] = [];
    const tiles: any[] = Array.isArray(doc.tiles) ? doc.tiles : [];
    const error = (path: string, message: string) => out.push({ level: 'error', path, message });
    const warning = (path: string, message: string) => out.push({ level: 'warning', path, message });

    const bytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
    if (bytes > MAX_ENVELOPE * 0.72) {
        error('/', 'the document is ' + Math.round(bytes / 1024) + ' KiB; sealed it would pass the 256 KiB limit');
    } else if (bytes > 64 * 1024) {
        warning('/', 'the document is ' + Math.round(bytes / 1024) + ' KiB; fewer points per series save radio and battery');
    }
    if (typeof doc.staleAfterSec === 'number' && doc.staleAfterSec < 30) {
        warning('/staleAfterSec', 'very small; rule of thumb: two to three times the upload interval');
    }

    const ids = new Map<string, number>();
    tiles.forEach((tile, i) => {
        const p = '/tiles/' + i;
        if (tile && typeof tile.id === 'string') {
            if (ids.has(tile.id)) { error(p + '/id', 'duplicate tile id "' + tile.id + '" (also at /tiles/' + ids.get(tile.id) + ')'); } else { ids.set(tile.id, i); }
        }
        if (!tile || typeof tile !== 'object') { return; }
        if (typeof tile.titleShort === 'string' && tile.titleShort.length > 12) { error(p + '/titleShort', 'longer than 12 characters'); }
        if (typeof tile.title === 'string' && tile.title.length > 12 && !tile.titleShort) { warning(p + '/titleShort', 'missing: the title is cut in small widgets'); }

        const r = tile.range;
        const hasRange = r && typeof r.min === 'number' && typeof r.max === 'number';
        if (hasRange && r.max <= r.min) { error(p + '/range', 'max must be greater than min'); }
        if (hasRange && typeof tile.value === 'number' && (tile.value < r.min || tile.value > r.max)) { warning(p + '/value', 'lies outside range'); }
        if (hasRange && typeof tile.target === 'number' && (tile.target < r.min || tile.target > r.max)) { warning(p + '/target', 'lies outside range'); }
        if (Array.isArray(tile.bands) && tile.bands.length) {
            let prev = hasRange ? r.min : -Infinity;
            tile.bands.forEach((b: any, bi: number) => {
                if (b && typeof b.to === 'number' && b.to < prev) { error(p + '/bands/' + bi + '/to', 'bands must be ascending'); }
                if (b && typeof b.to === 'number') { prev = b.to; }
            });
            if (hasRange && prev < r.max) { warning(p + '/bands', 'last band ends before range.max; the rest of the scale stays uncoloured'); }
            if (tile.status && hasRange && typeof tile.value === 'number') {
                let from = r.min;
                for (const b of tile.bands) {
                    if (tile.value >= from && tile.value <= b.to) {
                        if (b.status !== tile.status) { warning(p + '/status', '"' + tile.status + '", but the value sits in the "' + b.status + '" band'); }
                        break;
                    }
                    from = b.to;
                }
            }
        }

        if (Array.isArray(tile.categories)) {
            if ((tile.view === 'pie' || tile.view === 'donut') && tile.categories.length > 8) { warning(p + '/categories', 'more than 8 categories: the palette starts over'); }
            if (Array.isArray(tile.series)) {
                tile.series.forEach((s: any, si: number) => {
                    if (s && Array.isArray(s.values) && s.values.length !== tile.categories.length) {
                        error(p + '/series/' + si + '/values', s.values.length + ' values but ' + tile.categories.length + ' categories');
                    }
                    if (s && Array.isArray(s.statuses) && Array.isArray(s.values)) {
                        if (s.statuses.length !== s.values.length) {
                            warning(p + '/series/' + si + '/statuses', s.statuses.length + ' statuses but ' + s.values.length + ' values; the app reads missing ones as null and ignores surplus ones');
                        }
                        if (s.statuses.length > 1 && s.statuses.every((x: unknown) => x === 'ok')) {
                            warning(p + '/series/' + si + '/statuses', 'every bar ok: traffic lights only for bars that carry a verdict, the rest stays null');
                        }
                    }
                });
            }
        }
        if (tile.view === 'line' && Array.isArray(tile.series)) {
            tile.series.forEach((s: any, si: number) => {
                let n = 0;
                if (Array.isArray(s?.samples)) { n = s.samples.length; } else if (Array.isArray(s?.points)) { n = s.points.length; }
                if (n > 500) { warning(p + '/series/' + si, n + ' points; 30 to 60 are enough for one screen'); }
                if (s && Array.isArray(s.samples)) {
                    let last = -Infinity;
                    for (let k = 0; k < s.samples.length; k++) {
                        const ts = Date.parse(s.samples[k] && s.samples[k][0]);
                        if (Number.isFinite(ts) && ts < last) { warning(p + '/series/' + si + '/samples/' + k, 'timestamps not ascending'); break; }
                        if (Number.isFinite(ts)) { last = ts; }
                    }
                }
            });
        }

        if (tile.view === 'table' && Array.isArray(tile.columns) && Array.isArray(tile.rows)) {
            tile.rows.forEach((row: any, ri: number) => {
                if (row && Array.isArray(row.cells) && row.cells.length !== tile.columns.length) {
                    warning(p + '/rows/' + ri + '/cells', row.cells.length + ' cells but ' + tile.columns.length + ' columns');
                }
            });
            if (tile.rows.length > 10) { warning(p + '/rows', tile.rows.length + ' rows; in a widget ten is a lot'); }
        }

        if (tile.view === 'timeline') {
            const from = Date.parse(tile.from);
            const to = Date.parse(tile.to);
            if (Number.isFinite(from) && Number.isFinite(to) && to <= from) { error(p + '/to', 'to must be after from'); }
            const stateIds = new Set((Array.isArray(tile.states) ? tile.states : []).map((s: any) => s && s.id));
            (Array.isArray(tile.lanes) ? tile.lanes : []).forEach((l: any, li: number) => {
                let last = -Infinity;
                (l && Array.isArray(l.segments) ? l.segments : []).forEach((seg: any, si: number) => {
                    const at = p + '/lanes/' + li + '/segments/' + si;
                    if (!stateIds.has(seg && seg[1])) { error(at, 'unknown state "' + (seg && seg[1]) + '"'); }
                    const ts = Date.parse(seg && seg[0]);
                    if (Number.isFinite(ts) && ts < last) { error(at, 'segments must be ascending'); }
                    if (Number.isFinite(ts)) { last = ts; }
                    if (Number.isFinite(ts) && Number.isFinite(from) && ts < from) { warning(at, 'starts before from'); }
                });
            });
        }

        if (typeof tile.subtext === 'string' && /\b(vor \d|ago)\b/i.test(tile.subtext)) {
            warning(p + '/subtext', 'time of day rather than duration: "3 minutes ago" is already wrong when read');
        }
    });
    return out;
}

/**
 * validate returns the errors (the document must not be sent) and the warnings
 * (it may be sent, but something looks off). Semantic checks run only on a
 * document that passed the schema: on a broken one they would mostly repeat it.
 */
export function validate(doc: unknown): Validation {
    const schemaIssues = schemaErrors(doc);
    const issues = schemaIssues.length ? schemaIssues : semanticIssues(doc);
    return {
        errors: issues.filter((i) => i.level === 'error'),
        warnings: issues.filter((i) => i.level === 'warning'),
    };
}

/** tileOf names the tile an issue path points into, for messages a person reads. */
export function tileOf(doc: Partial<ViewDocument> | null | undefined, path: string | undefined): string | null {
    const m = /^\/tiles\/(\d+)/.exec(path || '');
    const tile = m && doc && Array.isArray(doc.tiles) ? doc.tiles[Number(m[1])] : null;
    return tile && typeof tile.id === 'string' ? tile.id : null;
}

/** summary puts the first three issues into one line. */
export function summary(doc: Partial<ViewDocument> | null | undefined, issues: Issue[]): string {
    return issues.slice(0, 3).map((i) => {
        const id = tileOf(doc, i.path);
        const rest = id ? i.path.replace(/^\/tiles\/\d+/, '') : i.path;
        return (id ? 'tile "' + id + '"' : 'document') + (rest && rest !== '/' ? ' ' + rest : '') + ': ' + i.message;
    }).join('; ') + (issues.length > 3 ? ' (+' + (issues.length - 3) + ' more)' : '');
}
