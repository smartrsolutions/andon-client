/**
 * The one request this package makes: PUT /v1/views/{id}/envelope.
 *
 * The write secret travels in the Authorization header and nowhere else; it is
 * never part of a URL, a result or an error text. Users talk to relay.andon.app;
 * ANDON_RELAY_URL exists for development against a local relay only.
 */

export const DEFAULT_RELAY = 'https://relay.andon.app';
const TIMEOUT_MS = 15000;

/** The relay accepts at most one upload per view per ten seconds (429 otherwise). */
export const THROTTLE_SEC = 10;

type Env = Record<string, string | undefined>;

/** noTrailingSlash drops the slashes a URL ends in; a loop, as /\/+$/ backtracks on long runs of slashes. */
export function noTrailingSlash(url: string): string {
    let end = url.length;
    while (end > 0 && url[end - 1] === '/') { end--; }
    return url.slice(0, end);
}

/** relayUrl is ANDON_RELAY_URL without a trailing slash, or the public relay. */
export function relayUrl(env?: Env): string {
    const value = noTrailingSlash(String((env || process.env).ANDON_RELAY_URL || '').trim());
    return value || DEFAULT_RELAY;
}

/**
 * relayAliases are the other addresses under which a .env may name this same
 * relay. Development only: in a container a local relay is reachable as
 * host.docker.internal:8080, while the .env names it as 127.0.0.1:8080 or by the
 * machine's LAN address. ANDON_RELAY_ALIASES is a comma-separated list, empty by default.
 */
export function relayAliases(env?: Env): string[] {
    return String((env || process.env).ANDON_RELAY_ALIASES || '')
        .split(',')
        .map((s) => noTrailingSlash(s.trim()))
        .filter(Boolean);
}

function errorCode(text: string): string {
    if (!text?.startsWith('{')) { return ''; }
    try {
        const parsed = JSON.parse(text);
        return typeof parsed.error === 'string' ? parsed.error : '';
    } catch {
        return ''; // not the relay's JSON (a proxy's page, say): no code to report
    }
}

/** unreachable says why a request got no answer at all. */
function unreachable(err: any): string {
    if (err?.name === 'AbortError') { return 'the relay did not answer within ' + TIMEOUT_MS / 1000 + ' s'; }
    let why: string;
    if (err?.cause?.code) { why = err.cause.code; } else if (err?.message) { why = err.message; } else { why = String(err); }
    return 'the relay could not be reached: ' + why;
}

/** hint says what to change, per the relay's answers. */
function hint(status: number, code: string): string {
    switch (status) {
        case 401: return 'the relay rejected the write secret (' + code + '): use the current .env of the view';
        case 404: return 'the relay does not know this view (' + code + '): check the view ID, or use the current .env';
        case 413: return 'the envelope is larger than 256 KiB (' + code + '): fewer tiles or shorter series';
        case 400: return 'the relay refused the envelope (' + code + ')';
        case 429: return 'throttled (' + code + '): the next upload carries the latest state';
        default: return 'upload failed with HTTP ' + status + (code ? ' (' + code + ')' : '');
    }
}

/**
 * The answer to one upload:
 *
 *   ok        204, stored
 *   throttled 429, try again after retryAfterSec
 *   retry     network error or 5xx, worth trying again later
 *   fatal     401, 404, 400, 413: trying again changes nothing until a person does
 */
export type PutResult =
    | { outcome: 'ok'; status: 204 }
    | { outcome: 'throttled'; status: 429; code: string; message: string; retryAfterSec: number }
    | { outcome: 'retry' | 'fatal'; status: number; code: string; message: string };

export interface PutOptions {
    base: string;
    view: string;
    writeSecret: string;
    envelope: string;
    fetchImpl?: typeof fetch | undefined;
    /** Overrides the wording of the 401 and 404 hints, for a caller that says "import" instead of "use". */
    hints?: Partial<Record<401 | 404, string>> | undefined;
}

/** put uploads one envelope and classifies the answer. It never throws. */
export async function put({ base, view, writeSecret, envelope, fetchImpl, hints }: PutOptions): Promise<PutResult> {
    const doFetch = fetchImpl || fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const say = (status: number, code: string) => {
        const own = hints && (hints as Record<number, string>)[status];
        return own ? own.replace('__code__', code) : hint(status, code);
    };
    try {
        const res = await doFetch(base + '/v1/views/' + encodeURIComponent(view) + '/envelope', {
            method: 'PUT',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + writeSecret },
            body: envelope,
            signal: controller.signal,
        });
        const text = res.status === 204 ? '' : (await res.text().catch(() => '')).slice(0, 300);
        const code = errorCode(text);
        const retryAfter = Number(res.headers?.get ? res.headers.get('retry-after') : Number.NaN);
        if (res.status === 204) { return { outcome: 'ok', status: 204 }; }
        if (res.status === 429) {
            return { outcome: 'throttled', status: 429, code, message: say(429, code || 'throttled'), retryAfterSec: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : THROTTLE_SEC };
        }
        if (res.status >= 500) { return { outcome: 'retry', status: res.status, code, message: say(res.status, code) }; }
        return { outcome: 'fatal', status: res.status, code, message: say(res.status, code) };
    } catch (err: any) {
        return { outcome: 'retry', status: 0, code: 'network', message: unreachable(err) };
    } finally {
        clearTimeout(timer);
    }
}
