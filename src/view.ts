/**
 * The runtime of one view: holds the document, takes values, decides when to
 * upload, and uploads. AndonView is its public face; the Node-RED package's
 * andon-view config node owns one of these, and every andon out node that points
 * at the view feeds the same one, so two nodes never race each other for the relay.
 *
 * When an upload happens:
 *
 *   - a change is sent at most every intervalSec (never below the relay's 10 s);
 *     the first change after a quiet spell goes out at once;
 *   - without a change, a heartbeat goes out every staleAfterSec / 2, but only
 *     when values kept arriving since the last upload. A source whose sensors went
 *     quiet must turn stale in the app, so the package never vouches for values it
 *     has not seen again;
 *   - 429 waits for Retry-After, a network error or 5xx backs off, and 401, 404,
 *     400 or 413 stop until the next value: repeating them changes nothing.
 *
 * Clock, timers and the upload are injected, so the tests run without waiting and
 * without a relay.
 */

import { hint } from './accepts';
import type { ViewDocument } from './document';
import type { PutResult } from './relay';
import { THROTTLE_SEC } from './relay';
import { fingerprint, seal } from './seal';
import { apply, finish, InputError, type SeriesWindow, type Update } from './tiles';
import { summary, tileOf, validate, type Issue } from './validate';
import { API_WORDS, type Words } from './words';

const MAX_BACKOFF_SEC = 300;

/** A value that leaves the document invalid. The document stays as it was. */
export class ValidationError extends Error {}

export { InputError };

export type Notify = 'auto' | 'always' | 'never';

export interface Clock {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(timer: unknown): void;
}

/** What one upload was, without the envelope or a secret. */
export interface UploadReport {
    view: string;
    kv: number;
    notify: boolean;
    /** HTTP status, 0 when the relay was not reached */
    status: number;
    tiles: number;
    documentBytes: number;
    envelopeBytes: number;
    generatedAt: string | undefined;
    /** sent without a change, to keep the view fresh */
    heartbeat: boolean;
}

/** The state a restart can continue from: what the `sent` event carries. */
export interface RestoredState {
    doc: ViewDocument;
    fingerprint?: string | undefined;
    /** the series and lanes holding real data; null when the whole document came from the source */
    live?: string[] | null | undefined;
}

export type RuntimeEvent =
    | { type: 'queued'; inSec: number }
    | { type: 'sent'; report: UploadReport; sources: unknown[]; doc: ViewDocument; fingerprint: string; live: string[] | null }
    | { type: 'throttled'; message: string; retryInSec: number; report: UploadReport; sources: unknown[] }
    | { type: 'error'; message: string; retryInSec?: number; report?: UploadReport; sources: unknown[] };

export interface RuntimeOptions {
    view: string;
    kv: number;
    key: Buffer;
    notify?: Notify | undefined;
    intervalSec?: number | undefined;
    staleAfterSec?: number | undefined;
    window?: SeriesWindow | undefined;
    /** the tiles whose status follows from their bands */
    derive?: ReadonlySet<string> | undefined;
    /** a view document, or null to take a whole document as the first value */
    template?: ViewDocument | null | undefined;
    /** uploads one envelope text */
    put: (envelope: string) => Promise<PutResult>;
    onEvent?: ((event: RuntimeEvent) => void) | undefined;
    clock?: Clock | undefined;
    restored?: RestoredState | null | undefined;
    words?: Words | undefined;
}

export interface ReceiveResult {
    /** the IDs of the tiles that changed */
    changed: string[];
    /** what looks off in the new document; it is sent anyway */
    warnings: Issue[];
}

export class ViewRuntime {
    readonly intervalSec: number;
    readonly staleAfterSec: number;
    doc: ViewDocument | null;

    private o: RuntimeOptions;
    private clock: Clock;
    private words: Words;
    private lastFingerprint: string | undefined;
    // Series and lanes that already hold real data (tiles.ts, fromTemplate).
    // null: the whole document came from the source, nothing is template.
    private live: Set<string> | null;
    private dirty = false;      // the document changed since the last upload
    private seen = false;       // a value arrived since the last upload, changed or not
    private blocked: string | null = null; // a fatal answer: wait for the next value
    private lastUpload: number | null = null; // ms of the last 204
    private notBefore = 0;      // Retry-After or backoff
    private failures = 0;
    private sources = new Set<unknown>();
    private timer: unknown = null;
    private inFlight: Promise<PutResult> | null = null;
    private closed = false;

    constructor(options: RuntimeOptions) {
        this.o = options;
        this.clock = options.clock || { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t as NodeJS.Timeout) };
        this.words = options.words || API_WORDS;
        this.intervalSec = Math.max(THROTTLE_SEC, Number(options.intervalSec) || 30);
        this.staleAfterSec = Number(options.staleAfterSec) > 0 ? Number(options.staleAfterSec) : this.intervalSec * 3;
        this.doc = options.restored && options.restored.doc ? options.restored.doc : options.template || null;
        this.lastFingerprint = options.restored ? options.restored.fingerprint : undefined;
        this.live = options.restored && Array.isArray(options.restored.live) ? new Set(options.restored.live)
            : options.restored && options.restored.live === null ? null : new Set();
    }

    private emit(event: RuntimeEvent): void {
        if (this.o.onEvent) { this.o.onEvent(event); }
    }

    /**
     * receive applies one update. It throws InputError or ValidationError and then
     * leaves the document exactly as it was, so one bad value never blocks the
     * others. Returns the warnings of the new document and the changed tile IDs.
     */
    receive(update: Update, sourceId?: unknown): ReceiveResult {
        const now = this.clock.now();
        const result = apply(this.doc, update, { now, window: this.o.window, derive: this.o.derive, live: this.live || undefined, words: this.words });
        let warnings: Issue[] = [];
        if (result.changed.length) {
            const check = validate(finish(result.doc, { now, staleAfterSec: this.staleAfterSec }));
            if (check.errors.length) {
                // A value that broke a tile gets told what that tile takes: the
                // schema's verdict names the field, not the value that was meant.
                const broken = [...new Set(check.errors.map((e) => tileOf(result.doc, e.path)))]
                    .filter((id): id is string => !!id && result.changed.includes(id));
                const hints = broken.slice(0, 2).map((id) => hint(this.doc ? this.doc.tiles.find((t) => t.id === id) : undefined, this.words)).filter(Boolean);
                throw new ValidationError(summary(result.doc, check.errors) + (hints.length ? '. ' + hints.join('. ') : ''));
            }
            warnings = check.warnings;
            this.doc = result.doc;
            this.dirty = true;
            if (result.replaced) { this.live = null; } else if (this.live) { const live = this.live; result.touched.forEach((k) => live.add(k)); }
        }
        this.seen = true;
        this.blocked = null;
        if (sourceId !== undefined) { this.sources.add(sourceId); }
        this.schedule();
        return { changed: result.changed, warnings };
    }

    /** pending says whether a change is waiting for its upload. */
    get pending(): boolean {
        return this.dirty && !this.blocked && !this.closed;
    }

    /** due is when the next upload may happen, or null when none is needed. */
    due(): number | null {
        if (!this.doc || this.blocked || this.closed) { return null; }
        let at: number;
        if (this.dirty) {
            at = this.lastUpload === null ? 0 : this.lastUpload + this.intervalSec * 1000;
        } else if (this.seen && this.lastUpload !== null) {
            at = this.lastUpload + Math.max(this.intervalSec, this.staleAfterSec / 2) * 1000;
        } else {
            return null;
        }
        return Math.max(at, this.notBefore);
    }

    schedule(): void {
        if (this.inFlight || this.closed) { return; }
        if (this.timer) { this.clock.clearTimeout(this.timer); this.timer = null; }
        const at = this.due();
        if (at === null) { return; }
        const wait = Math.max(0, at - this.clock.now());
        if (wait > 0) { this.emit({ type: 'queued', inSec: Math.ceil(wait / 1000) }); }
        this.timer = this.clock.setTimeout(() => {
            this.timer = null;
            void this.flush();
        }, wait);
    }

    /** flush builds, seals and uploads the current document once. */
    async flush(): Promise<PutResult | undefined> {
        if (this.inFlight || this.closed || !this.doc) { return this.inFlight || undefined; }
        const now = this.clock.now();
        const sources = Array.from(this.sources);
        const doc = finish(this.doc, { now, staleAfterSec: this.staleAfterSec });
        const wasDirty = this.dirty;
        this.dirty = false;
        this.seen = false;
        this.sources.clear();

        const fp = fingerprint(doc);
        const notify = this.o.notify === 'always' ? true : this.o.notify === 'never' ? false : fp !== this.lastFingerprint;
        let sealed;
        try {
            sealed = seal(doc, { view: this.o.view, kv: this.o.kv, key: this.o.key, notify });
        } catch (err) {
            this.blocked = 'too_large';
            this.dirty = wasDirty;
            this.emit({ type: 'error', message: (err as Error).message, sources });
            return undefined;
        }

        this.inFlight = (async () => {
            const res = await this.o.put(sealed.text);
            this.inFlight = null;
            if (this.closed) { return res; }
            const report: UploadReport = {
                view: this.o.view, kv: this.o.kv, notify, status: res.status,
                tiles: doc.tiles.length, documentBytes: sealed.documentBytes, envelopeBytes: sealed.bytes,
                generatedAt: doc.generatedAt, heartbeat: !wasDirty,
            };
            if (res.outcome === 'ok') {
                this.lastUpload = now;
                // Stored only after a 204: a status change whose
                // upload failed must still wake the devices on the next try.
                this.lastFingerprint = fp;
                this.failures = 0;
                this.notBefore = 0;
                this.emit({ type: 'sent', report, sources, doc: this.doc as ViewDocument, fingerprint: fp, live: this.live ? Array.from(this.live) : null });
            } else {
                this.dirty = this.dirty || wasDirty;
                this.seen = this.seen || !wasDirty;
                sources.forEach((s) => this.sources.add(s));
                if (res.outcome === 'throttled') {
                    this.notBefore = this.clock.now() + res.retryAfterSec * 1000;
                    this.emit({ type: 'throttled', message: res.message, retryInSec: res.retryAfterSec, report, sources });
                } else if (res.outcome === 'retry') {
                    this.failures += 1;
                    const backoff = Math.min(MAX_BACKOFF_SEC, this.intervalSec * Math.pow(2, this.failures - 1));
                    this.notBefore = this.clock.now() + backoff * 1000;
                    this.emit({ type: 'error', message: res.message, retryInSec: backoff, report, sources });
                } else {
                    this.blocked = res.code || String(res.status);
                    this.emit({ type: 'error', message: res.message, report, sources });
                }
            }
            this.schedule();
            return res;
        })();
        return this.inFlight;
    }

    /** idle resolves once no upload is in flight. */
    async idle(): Promise<void> {
        while (this.inFlight) { await this.inFlight; }
    }

    close(): void {
        this.closed = true;
        if (this.timer) { this.clock.clearTimeout(this.timer); this.timer = null; }
    }
}
