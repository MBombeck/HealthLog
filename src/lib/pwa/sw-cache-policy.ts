/**
 * The worker's own cache names: `healthlog-{static,pages,data}-<version>`.
 * Everything the app deletes from CacheStorage (session end, the "new
 * version" reload) matches against this and nothing else, so another app's
 * caches on the same origin are left alone. `data` names the API cache older
 * releases kept; it stays so those caches are still deleted. Same pattern as
 * `HEALTHLOG_CACHE_NAME_RE` in `public/sw.js`.
 */
export const HEALTHLOG_CACHE_NAME_RE = /^healthlog-(?:static|pages|data)-/;
