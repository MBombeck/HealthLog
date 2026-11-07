/**
 * Edge headers for the paths whose credential is the URL itself.
 *
 * The public clinician share view at `/c/<token>` is a scoped
 * health record authenticated by an unguessable bearer token in the path.
 * Defend it at the edge regardless of what the RSC emits:
 *   - `Cache-Control: no-store` so no shared proxy / CDN ever retains a
 *     scoped record (the page is `force-dynamic`, but that governs Next's
 *     cache, not a downstream intermediary).
 *   - `X-Robots-Tag: noindex, nofollow` as the header peer of the page's
 *     `robots` meta — a crawler that never parses the document still obeys
 *     the header, and the token must never reach a search index.
 *   - `Referrer-Policy: no-referrer` so the token-bearing URL is not leaked
 *     in the `Referer` of any outbound navigation from the page.
 *
 * The invite landing `/invite/<hlv_token>` (iOS #16) carries an equally sensitive
 * secret in the path, so it earns the same edge defence even though it is a
 * pure server redirect: no shared proxy / CDN may cache it and no crawler may
 * index the token-bearing URL.
 *
 * The cycle calendar feed (`/api/cycle/feed/<hlf_token>`) carries its
 * credential in the path too. It is kept out of indexes and referrers like the
 * share view, but its caching is the route's own: `private, no-cache` plus an
 * ETag, so a provider can ask again with `If-None-Match` instead of
 * downloading the body on every poll. `no-store` here would throw the
 * validator away.
 *
 * Runs after the proxy's general header block, so these values win.
 */
export function setPathCredentialHeaders(
  pathname: string,
  headers: Headers,
): void {
  const feed = pathname.startsWith("/api/cycle/feed/");
  const page = pathname.startsWith("/c/") || pathname.startsWith("/invite/");
  if (!feed && !page) return;
  if (page) headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Referrer-Policy", "no-referrer");
}
