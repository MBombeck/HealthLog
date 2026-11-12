/**
 * The worker's own cache names: `healthlog-{static,pages,data}-<version>`.
 * Everything the app deletes from CacheStorage matches one of the two
 * patterns below and nothing else, so another app's caches on the same
 * origin are left alone. `data` names the API cache older releases kept; it
 * stays so those caches are still deleted. Same pattern as
 * `HEALTHLOG_CACHE_NAME_RE` in `public/sw.js`.
 */
export const HEALTHLOG_CACHE_NAME_RE = /^healthlog-(?:static|pages|data)-/;

/**
 * The caches that can hold something of one account: cached pages and the
 * old API answers. The session wipe deletes these and keeps the static cache.
 */
export const ACCOUNT_CACHE_NAME_RE = /^healthlog-(?:pages|data)-/;
