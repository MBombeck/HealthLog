/**
 * The two headers that carry the proxy's "was this page rendered for a
 * session?" decision to the places that act on it. Edge-safe: no imports.
 */

/**
 * The service worker's page-cache permit. Only a page rendered for a request
 * that carries no session cookie may be kept on the device, and the worker
 * keeps nothing that does not carry this header with the value `anonymous`:
 * an allowlist, so a page the proxy forgot to mark is not cached rather than
 * cached by mistake. Keep the name in lockstep with
 * `HEALTHLOG_PAGE_CACHE_HEADER` in `public/sw.js`.
 */
export const HEALTHLOG_PAGE_CACHE_HEADER = "X-HealthLog-Page-Cache";

/**
 * Request header the proxy hands the root layout: present (`1`) only on a
 * session-gated page, the one place the layout may write the account seed
 * into the document. Any incoming value is dropped first, so a client cannot
 * set it.
 */
export const ACCOUNT_SEED_REQUEST_HEADER = "x-healthlog-page-seed";

/**
 * Hand the root layout its permission to write the account seed: set on a
 * session-gated page only, and any value the client sent is dropped first.
 */
export function forwardAccountSeedPermission(
  requestHeaders: Headers,
  sessionGated: boolean,
): void {
  requestHeaders.delete(ACCOUNT_SEED_REQUEST_HEADER);
  if (sessionGated) requestHeaders.set(ACCOUNT_SEED_REQUEST_HEADER, "1");
}

/**
 * The cache posture of a page response, set at the edge where no page-level
 * change can weaken it.
 *
 * Session-gated pages carry one account's health record in the document
 * itself: several server-prefetch their data into the HTML through a
 * TanStack `HydrationBoundary` (the dashboard, Insights, the workouts list,
 * the medications list, the Coach), and the root layout writes the account
 * seed. They are dynamic only as a side effect of reading the session
 * cookie, which is a property of the page code, not a guarantee: a stray
 * `revalidate`, a `force-static` segment or a caching proxy in front of the
 * app would be enough to keep one account's page and hand it to the next
 * caller. `private` bars shared caches outright; `no-store` also stops the
 * browser's disk cache and the bfcache snapshot, so a back-navigation after
 * logout cannot repaint the record.
 *
 * The rule follows the cookie as well as the path: a public page (sign-in,
 * legal, about) rendered for a request that carries a session cookie is
 * rendered for that session, so it is `private, no-store` too. Only a page
 * answered to a request without a session cookie stays cacheable, and only
 * that one carries the service worker's page-cache permit.
 *
 * Runs after the path-credential headers: a stricter answer already set
 * there (`no-store` on a token page) stands, and nothing uncacheable carries
 * the permit.
 */
export function setPageCachePolicy(
  headers: Headers,
  page: { sessionGated: boolean; isPage: boolean; carriesSession: boolean },
): void {
  if (!page.isPage && !page.sessionGated) return;
  if (/no-store/i.test(headers.get("Cache-Control") ?? "")) return;
  if (page.sessionGated || page.carriesSession) {
    headers.set("Cache-Control", "private, no-store");
  } else {
    headers.set(HEALTHLOG_PAGE_CACHE_HEADER, "anonymous");
  }
}
