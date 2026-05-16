/**
 * Centralised `Cache-Control` directives for HealthLog HTTP responses.
 *
 * Two presets cover the load-bearing cases for the web tree:
 *
 * - {@link NO_STORE_BUT_BFCACHE} — the default for every authenticated page
 *   response. The directive replaces the framework's stock
 *   `no-store, must-revalidate` (which Chromium counts as a hard bfcache
 *   breaker per the eligibility matrix) with `private, max-age=0,
 *   must-revalidate`. `private` keeps shared caches (proxies, CDNs) from
 *   storing personal data, `max-age=0` forces revalidation on every
 *   navigation so cookie + session swaps still detect on the wire, and
 *   `must-revalidate` honours the staleness contract. The combination is
 *   bfcache-eligible — Chromium admits the page on back-forward navigation,
 *   restoring scroll position and DOM state instead of paying a full
 *   reload.
 *
 * - {@link SHORT_LIVED_PUBLIC} — for static-ish public payloads (manifest
 *   metadata, the AASA blob, etc.) where a one-hour shared-cache TTL is
 *   appropriate. Not for authenticated content.
 *
 * {@link applyAuthedHeaders} stamps `NO_STORE_BUT_BFCACHE` onto an existing
 * `Response` (or `NextResponse`) in-place. Use it inside a route handler
 * that needs the bfcache-friendly directive on a non-HTML payload (the
 * `next.config.ts` `headers()` rule handles the HTML default; this helper
 * covers the API-route edges that opt into the same posture).
 */

export const NO_STORE_BUT_BFCACHE = "private, max-age=0, must-revalidate";

export const SHORT_LIVED_PUBLIC = "public, max-age=3600";

/**
 * Stamp the bfcache-friendly authed `Cache-Control` directive onto a
 * response. Returns the same response for chaining.
 */
export function applyAuthedHeaders<T extends Response>(res: T): T {
  res.headers.set("Cache-Control", NO_STORE_BUT_BFCACHE);
  return res;
}
