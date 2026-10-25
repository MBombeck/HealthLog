/**
 * Refuse a state-changing request that a browser sent from another site.
 *
 * The session cookie is `SameSite=Lax`, which keeps it off a cross-site POST
 * but not off a POST from a sibling subdomain: `SameSite` compares the
 * registrable domain, so `https://other.example.com` is the same site as
 * `https://health.example.com`. A page there could send
 * `fetch(url, { method: "POST", mode: "no-cors", credentials: "include" })`
 * with a body typed `text/plain`, which needs no preflight, and act as the
 * signed-in person: add readings, delete entries, disconnect integrations,
 * invite a delegate. Nothing on the server compared where a request came
 * from.
 *
 * A browser says where a request comes from: `Sec-Fetch-Site` on every
 * request from a current browser, and `Origin` on every cross-origin POST
 * from any browser of the last decade. This guard runs in `apiHandler`
 * before the handler, for every method that can change state:
 *
 *   - `Sec-Fetch-Site: same-origin` or `none` passes; `same-site` and
 *     `cross-site` are refused.
 *   - Without `Sec-Fetch-Site`, an `Origin` passes only when its host is the
 *     host the request was sent to (`Host`, or `X-Forwarded-Host` behind a
 *     proxy) or the configured `APP_URL`. A page cannot set either header
 *     on another origin's request.
 *   - A request with neither header is not from a browser page (the phone
 *     app, a script, a webhook sender) and passes; it carries no cookie a
 *     page could have lent it.
 *   - A request carrying `Authorization` passes: a page cannot attach that
 *     header to another origin without a CORS preflight, which this server
 *     never answers.
 *
 * Exempt by path: the surfaces that authenticate with a secret in a header
 * or the URL rather than the session cookie, and that a third party's client
 * may legitimately call from a browser (a push client's action button). The
 * MCP OAuth endpoints, which must accept cross-origin requests by their
 * specification, do not run through `apiHandler` at all.
 */
import { apiError } from "@/lib/api-response";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Path prefixes that do not authenticate with the session cookie. Each is a
 * webhook with its own secret or a URL-credential action; see the module
 * comment.
 */
export const CROSS_SITE_EXEMPT_PREFIXES = [
  "/api/withings/webhook",
  "/api/whoop/webhook/",
  "/api/telegram/webhook",
  "/api/internal/deploy-webhook",
  "/api/notifications/action/",
  "/api/monitoring/csp-report",
] as const;

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/** The hosts this request may name as its own origin. */
function ownHosts(request: Request): Set<string> {
  const hosts = new Set<string>();
  const host = request.headers.get("host")?.trim().toLowerCase();
  if (host) hosts.add(host);
  const forwarded = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (forwarded) hosts.add(forwarded);
  for (const configured of [
    process.env.APP_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ]) {
    const appHost = hostOf(configured);
    if (appHost) hosts.add(appHost);
  }
  return hosts;
}

/** Why a request is refused, or null when it may proceed. */
export function crossSiteWriteReason(
  request: Request,
  pathname: string,
): "sec-fetch-site" | "origin" | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;
  if (CROSS_SITE_EXEMPT_PREFIXES.some((p) => pathname.startsWith(p))) {
    return null;
  }
  if (request.headers.has("authorization")) return null;

  const site = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site) {
    return site === "same-origin" || site === "none" ? null : "sec-fetch-site";
  }
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  const originHost = hostOf(origin);
  return originHost && ownHosts(request).has(originHost) ? null : "origin";
}

/** A 403 for a cross-site state change, or null. */
export function refuseCrossSiteWrite(
  request: Request,
  pathname: string,
): { response: Response; reason: "sec-fetch-site" | "origin" } | null {
  const reason = crossSiteWriteReason(request, pathname);
  if (!reason) return null;
  return {
    reason,
    response: apiError("Cross-site request refused", 403, {
      errorCode: "request.cross_site",
    }),
  };
}
