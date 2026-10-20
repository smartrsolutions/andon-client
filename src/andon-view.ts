/**
 * AndonView: one view, from the outside. Values in by tile ID, tiles on the
 * devices paired with the view. Everything below it (when to upload, what a value
 * means for its tile, sealing, the relay's answers) is the runtime the Node-RED
 * package runs too, so both keep the same rules.
 */

import type { ViewDocument } from './document';
import * as envFile from './env';
import { DEFAULT_RELAY, put, relayUrl, type PutResult } from './relay';
import { parseKey, parseKeyVersion, VIEW_ID, WRITE_SECRET } from './seal';
import { DEFAULT_WINDOW, type SeriesWindow } from './tiles';
import { summary, validate } from './validate';
import { ViewRuntime, type Clock, type Notify, type ReceiveResult, type UploadReport } from './view';

type Env = Record<string, string | undefined>;

export interface AndonViewOptions {
    /** the view ID, `vw_…` */
    view: string;
    /** the write secret, `ws_…`: sent only in the Authorization header of an upload */
    writeSecret: string;
    /** the content key, base64 or base64url: never leaves this process */
    contentKey: string | Buffer;
    /** the content key's version, 1 unless the key was renewed */
    keyVersion?: number | string | undefined;
    /**
     * The tiles, as the configurator's template (a view document, or its JSON text).
     * Without one, the first value has to be a whole view document (`replace`).
     */
    template?: ViewDocument | string | null | undefined;
    /** a change goes out at most this often, in seconds: 30 by default, 10 at least */
    intervalSec?: number | undefined;
    /** after how many seconds without an upload the app shows the view as stale: three intervals by default */
    staleAfterSec?: number | undefined;
    /** when devices are woken: `auto` (a tile's status changed, the default), `always` or `never` */
    notify?: Notify | undefined;
    /** how much of a time series is kept: the newest `points` (60 by default), none older than `ageSec` (0: no limit) */
    window?: Partial<SeriesWindow> | undefined;
    /** the tiles whose status follows from their bands, by ID */
    deriveStatus?: Iterable<string> | undefined;
    /** after every stored upload */
    onSent?: ((report: UploadReport) => void) | undefined;
    /**
     * When an upload failed. `retryInSec` says when the next try is; without it,
     * uploads stop until the next value, because trying again changes nothing.
     * Without onError the message goes to console.warn.
     */
    onError?: ((error: { message: string; status?: number | undefined; retryInSec?: number | undefined }) => void) | undefined;
    /** For development against a local relay. */
    relayUrl?: string | undefined;
    /** For tests: a fetch to upload with. */
    fetch?: typeof fetch | undefined;
    /** For tests: the clock and timers. */
    clock?: Clock | undefined;
}

export interface FromEnvOptions extends Omit<AndonViewOptions, 'view' | 'writeSecret' | 'contentKey' | 'keyVersion'> {
    /** replaces the leading `ANDON_` of every name, e.g. `ANDON_CLOUD_`; `ANDON_` by default */
    prefix?: string | undefined;
    /** the variables to read, `process.env` by default */
    env?: Env | undefined;
}

export interface SetOptions {
    /** when the value was measured, for a series or a timeline: a Date, milliseconds or ISO 8601; now by default */
    at?: Date | number | string | undefined;
    /** the series the value belongs to, by name; the first one by default */
    series?: string | undefined;
    /** the timeline lane the state belongs to, by name; the first one by default */
    lane?: string | undefined;
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
}

function templateOf(value: AndonViewOptions['template']): ViewDocument | null {
    if (value === undefined || value === null || value === '') { return null; }
    let doc: ViewDocument;
    try {
        doc = typeof value === 'string' ? JSON.parse(value) : clone(value);
    } catch (err) {
        throw new Error('the template is not a JSON document');
    }
    const check = validate(doc);
    if (check.errors.length) { throw new Error('the template is invalid: ' + summary(doc, check.errors)); }
    return doc;
}

export class AndonView {
    private runtime: ViewRuntime;
    private closing: Promise<void> | null = null;

    constructor(options: AndonViewOptions) {
        const view = String(options.view || '').trim();
        if (!VIEW_ID.test(view)) { throw new Error('view ID missing or not one: "' + view + '" (vw_ and 26 characters)'); }
        const writeSecret = String(options.writeSecret || '').trim();
        if (!WRITE_SECRET.test(writeSecret)) { throw new Error('write secret missing or not one (ws_ and 43 characters)'); }
        const key = Buffer.isBuffer(options.contentKey) ? options.contentKey : parseKey(options.contentKey);
        if (key.length !== 32) { throw new Error('content key is ' + key.length + ' bytes, expected 32'); }
        const kv = parseKeyVersion(options.keyVersion === undefined || options.keyVersion === '' ? 1 : options.keyVersion);
        const base = String(options.relayUrl || relayUrl()).trim().replace(/\/+$/, '') || DEFAULT_RELAY;
        const onError = options.onError || ((e) => console.warn('andon: ' + e.message));

        this.runtime = new ViewRuntime({
            view,
            kv,
            key,
            notify: options.notify || 'auto',
            intervalSec: options.intervalSec,
            staleAfterSec: options.staleAfterSec,
            window: Object.assign({}, DEFAULT_WINDOW, options.window),
            derive: new Set(options.deriveStatus || []),
            template: templateOf(options.template),
            clock: options.clock,
            put: (envelope) => put({ base, view, writeSecret, envelope, fetchImpl: options.fetch }),
            onEvent: (event) => {
                if (event.type === 'sent') {
                    if (options.onSent) { options.onSent(event.report); }
                } else if (event.type === 'error') {
                    onError({ message: event.message, status: event.report ? event.report.status : undefined, retryInSec: event.retryInSec });
                } else if (event.type === 'throttled') {
                    onError({ message: event.message, status: 429, retryInSec: event.retryInSec });
                }
            },
        });
    }

    /**
     * fromEnv takes the view from the environment, under the names the `.env` from
     * the configurator uses: ANDON_VIEW, ANDON_WRITE_SECRET, ANDON_CONTENT_KEY,
     * ANDON_KEY_VERSION.
     */
    static fromEnv(options: FromEnvOptions = {}): AndonView {
        const prefix = envFile.checkPrefix(options.prefix) || 'ANDON_';
        const env = options.env || process.env;
        const need = (suffix: envFile.Suffix) => {
            const value = envFile.pick(prefix, suffix, env);
            if (!value) { throw new Error(envFile.name(prefix, suffix) + ' is not set'); }
            return value;
        };
        const own = envFile.pick(prefix, 'URL', env).replace(/\/+$/, '');
        const { prefix: _prefix, env: _env, ...rest } = options;
        return new AndonView(Object.assign({}, rest, {
            view: need('VIEW'),
            writeSecret: need('WRITE_SECRET'),
            contentKey: need('CONTENT_KEY'),
            keyVersion: envFile.pick(prefix, 'KEY_VERSION', env) || 1,
            relayUrl: options.relayUrl || own || relayUrl(env),
        }));
    }

    /**
     * set gives one tile a value, or several tiles theirs: `set('t_oee', 79.3)` or
     * `set({ t_oee: 79.3, t_shift: 580 })`. An object for a single tile sets the
     * fields it names: `set('t_oee', { value: 79.3, status: 'warning' })`.
     *
     * It throws InputError when a value does not fit its tile and ValidationError
     * when it would leave the view invalid; the view then stays as it was. Values
     * set together go out in the same upload.
     */
    set(tileId: string, value: unknown, options?: SetOptions): ReceiveResult;
    set(values: Record<string, unknown>, options?: SetOptions): ReceiveResult;
    set(first: string | Record<string, unknown>, second?: unknown, third?: SetOptions): ReceiveResult {
        this.open();
        if (typeof first === 'string') {
            if (!first.trim()) { throw new TypeError('set needs a tile ID'); }
            return this.runtime.receive(Object.assign({ topic: first, payload: second }, this.extra(third)));
        }
        if (!first || typeof first !== 'object' || Array.isArray(first) || Array.isArray((first as any).tiles)) {
            throw new TypeError('set takes a tile ID and a value, or an object of tile IDs and values; replace() takes a whole view document');
        }
        return this.runtime.receive(Object.assign({ payload: first }, this.extra(second as SetOptions | undefined)));
    }

    /** replace swaps in a whole view document: for a source that builds its tiles itself. */
    replace(doc: ViewDocument): ReceiveResult {
        this.open();
        if (!doc || typeof doc !== 'object' || !Array.isArray(doc.tiles)) { throw new TypeError('replace takes a view document, with tiles'); }
        return this.runtime.receive({ payload: doc });
    }

    /** document is a copy of the view as it stands, or null before the first value without a template. */
    get document(): ViewDocument | null {
        return this.runtime.doc ? clone(this.runtime.doc) : null;
    }

    /**
     * flush uploads a pending change now instead of at the end of the interval, and
     * resolves with the relay's answer; undefined when nothing was pending. The
     * relay takes one upload per view every ten seconds and answers 429 to more.
     */
    async flush(): Promise<PutResult | undefined> {
        await this.runtime.idle();
        if (!this.runtime.pending) { return undefined; }
        return this.runtime.flush();
    }

    /**
     * close uploads what is still pending (unless `flush: false`) and stops every
     * timer, so the process can exit. The view takes no values afterwards.
     */
    close(options: { flush?: boolean } = {}): Promise<void> {
        if (!this.closing) {
            this.closing = (async () => {
                if (options.flush !== false) { await this.flush(); }
                await this.runtime.idle();
                this.runtime.close();
            })();
        }
        return this.closing;
    }

    private open(): void {
        if (this.closing) { throw new Error('the view is closed'); }
    }

    private extra(options: SetOptions | undefined): { timestamp?: unknown; series?: unknown; lane?: unknown } {
        if (!options) { return {}; }
        const out: { timestamp?: unknown; series?: unknown; lane?: unknown } = {};
        if (options.at !== undefined) { out.timestamp = options.at; }
        if (options.series !== undefined) { out.series = options.series; }
        if (options.lane !== undefined) { out.lane = options.lane; }
        return out;
    }
}
