/**
 * The view's values from the environment: the names the .env from the Andon
 * configurator uses, so that file can be handed to a process unedited:
 *
 *   ANDON_URL  ANDON_VIEW  ANDON_WRITE_SECRET  ANDON_CONTENT_KEY  ANDON_KEY_VERSION
 *
 * A prefix replaces the leading ANDON_ of each: with ANDON_CLOUD_, the view ID is
 * read from ANDON_CLOUD_VIEW. That is what lets several views share one
 * environment - one prefix per view.
 */

type Env = Record<string, string | undefined>;

// Upper case, ending in an underscore, so that ANDON_CLOUD_ + VIEW reads like a
// variable name.
export const PREFIX = /^[A-Z][A-Z0-9_]*_$/;

/** The five suffixes, without the ANDON_ a prefix stands in for. */
export const SUFFIXES = ['URL', 'VIEW', 'WRITE_SECRET', 'CONTENT_KEY', 'KEY_VERSION'] as const;
export type Suffix = typeof SUFFIXES[number];

/**
 * name is the variable a suffix is read from. Every message about a missing value
 * has to go through here, otherwise it names a variable nobody set.
 */
export function name(prefix: string | undefined, suffix: Suffix): string {
    return String(prefix || 'ANDON_') + suffix;
}

/** pick reads one value, trimmed; the empty string counts as unset. */
export function pick(prefix: string | undefined, suffix: Suffix, env?: Env): string {
    return String(((env || process.env)[name(prefix, suffix)]) || '').trim();
}

/**
 * checkPrefix throws on a prefix that is not one. An empty prefix is not an error:
 * it means the environment is not consulted at all.
 */
export function checkPrefix(prefix: string | undefined): string {
    if (!prefix) { return ''; }
    if (!PREFIX.test(prefix)) {
        throw new Error('environment prefix "' + prefix + '" has to be upper case and end in an '
            + 'underscore, for example ANDON_ or ANDON_CLOUD_');
    }
    return prefix;
}
