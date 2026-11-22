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
 *
 * A browser that takes no cookies would go round in circles: the route sets
 * the cookie and sends it on, the proxy finds none and sends it back. So the
 * route's hop carries the time it was made (`?via=<ms>`), and the proxy,
 * finding no cookie on a hop younger than a minute, sends the browser to
 * `/c/<token>?cookies=off` instead, where the route explains that the link
 * needs cookies. The marker is not signed and needs no secret: all it can
 * ever unlock is that explanation, never the page, so a forged one gains
 * nothing. Rendering the page without the cookie would weaken the gate for
 * every guess and still fail a protected link, whose unlock is a cookie too.
 */
export const SHARE_VIEW_GATE_COOKIE = "hls_view";

/** How long a pass through the gate lets the page open without the route. */
export const SHARE_VIEW_GATE_TTL_SECONDS = 12 * 60 * 60;

const VIEW_PATH = /^\/c\/([^/]+)\/view\/?$/;

/** The token segment of a `/c/<token>/view` path, or null for any other. */
export function shareViewToken(pathname: string): string | null {
  return VIEW_PATH.exec(pathname)?.[1] ?? null;
}

/** The query parameter on the route's hop to the page: when it was made. */
export const SHARE_VIEW_HOP_PARAM = "via";

/** The query parameter that asks the route for the "needs cookies" page. */
export const SHARE_VIEW_NO_COOKIE_PARAM = "cookies";
export const SHARE_VIEW_NO_COOKIE_VALUE = "off";

/** How old a hop may be and still count as coming straight from the route. */
export const SHARE_VIEW_HOP_WINDOW_MS = 60_000;

/** Clock skew between instances tolerated on a hop from the future. */
const HOP_SKEW_MS = 5_000;

/** Whether a `via` value is a hop the route made within the window. */
export function isFreshShareViewHop(
  value: string | null,
  now: number,
): boolean {
  if (value === null || !/^\d{13}$/.test(value)) return false;
  const age = now - Number(value);
  return age >= -HOP_SKEW_MS && age <= SHARE_VIEW_HOP_WINDOW_MS;
}
