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
export const ACCOUNT_SEED_REQUEST_HEADER = "x-healthlog-account-seed";
