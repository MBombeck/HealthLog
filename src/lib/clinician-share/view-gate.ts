/**
 * The clinician share link's entry gate, shared by the route that answers
 * `/c/<token>` and the proxy. Edge-safe: no imports.
 *
 * `/c/<token>` is a route, not a page: a page renders under the root layout's
 * loading boundary, which sends the status line before the token lookup ends,
 * so an unknown, expired or revoked link could only ever answer 200 with a
 * "not found" body. The route looks the token up first and answers every miss
 * with a real 404. A live link is sent on to the page at `/c/<token>/view`
 * with this cookie, scoped to that path; the proxy turns a direct visit to
 * the page without it back to `/c/<token>`, so a stranger's guess meets the
 * route's 404 and never the page. The cookie carries no secret (the token in
 * the path is the credential, and the page resolves it again): it only says
 * that this browser came through the gate.
 */
export const SHARE_VIEW_GATE_COOKIE = "hls_view";

/** How long a pass through the gate lets the page open without the route. */
export const SHARE_VIEW_GATE_TTL_SECONDS = 12 * 60 * 60;

const VIEW_PATH = /^\/c\/([^/]+)\/view\/?$/;

/** The token segment of a `/c/<token>/view` path, or null for any other. */
export function shareViewToken(pathname: string): string | null {
  return VIEW_PATH.exec(pathname)?.[1] ?? null;
}
