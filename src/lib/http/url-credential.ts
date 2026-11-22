/**
 * The answers of an anonymous surface whose credential is the URL itself:
 * the cycle calendar feed (`/api/cycle/feed/<hlf_token>`), the care calendar
 * feed (`/api/care/feed/<hlf_token>`) and the emergency card
 * (`/e/<hlm_token>`).
 *
 * Each of them runs the same pipeline (surface limit before any lookup, the
 * token's shape, the HMAC lookup, the gates read live) and answers a miss the
 * same way, whatever the miss was. That answer lives here once, so hardening
 * it (the headers, the 404's bytes, the validator comparison) reaches every
 * such surface at once instead of the one somebody remembered.
 *
 * The proxy adds the same robots and referrer headers to these paths
 * (`setPathCredentialHeaders`); they are set here too so a response is right
 * on its own, in a test or behind a matcher change.
 */
import { apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { checkAuthSurfaceRateLimit, rateLimitHeaders } from "@/lib/rate-limit";

/**
 * Per source address, across every link of one surface, before the lookup.
 * Generous: calendar providers poll from churning address pools, and a ward
 * or a carrier puts many people behind one address. The tokens are random
 * secrets checked by HMAC, so guessing is not what this stops.
 */
export const URL_CREDENTIAL_SURFACE_LIMIT_PER_HOUR = 600;
export const HOUR_MS = 60 * 60 * 1000;

/** Headers every answer of a URL-credential surface carries, misses included. */
export const URL_CREDENTIAL_HEADERS: Readonly<Record<string, string>> = {
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
};

function withCredentialHeaders(response: Response): Response {
  for (const [k, v] of Object.entries(URL_CREDENTIAL_HEADERS)) {
    response.headers.set(k, v);
  }
  return response;
}

/** The surface limit, keyed per source address under `bucket`. */
export function checkUrlCredentialSurface(request: Request, bucket: string) {
  return checkAuthSurfaceRateLimit(
    request,
    bucket,
    URL_CREDENTIAL_SURFACE_LIMIT_PER_HOUR,
    HOUR_MS,
  );
}

/**
 * One blunt JSON 404 for every miss class. `reason` goes to the wide event
 * only, never to the caller.
 */
export function urlCredentialNotFound(
  errorCode: string,
  reason: string,
): Response {
  annotate({ meta: { url_credential_miss: reason } });
  const response = withCredentialHeaders(
    apiError("Not found", 404, { errorCode }),
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/** The 429 of a surface or per-link bucket, with its rate-limit headers. */
export function urlCredentialTooMany(
  errorCode: string,
  snapshot: Parameters<typeof rateLimitHeaders>[0],
): Response {
  const response = withCredentialHeaders(
    apiError("Too many requests. Try again later.", 429, { errorCode }),
  );
  for (const [k, v] of Object.entries(rateLimitHeaders(snapshot))) {
    response.headers.set(k, v);
  }
  return response;
}

/** Does the request's `If-None-Match` name this ETag (weak or strong)? */
export function matchesEtag(request: Request, etag: string): boolean {
  const header = request.headers.get("if-none-match");
  if (!header) return false;
  return header
    .split(",")
    .map((v) => v.trim().replace(/^W\//, ""))
    .some((v) => v === etag || v === "*");
}

/**
 * A calendar body (or its 304) with a validator. `no-cache`, not `no-store`:
 * the client keeps the body and its ETag and asks again with
 * `If-None-Match`, which is what the 304 is for.
 */
export function icsFeedResponse(input: {
  body: string;
  etag: string;
  notModified: boolean;
  filename: string;
}): Response {
  const headers: Record<string, string> = {
    ...URL_CREDENTIAL_HEADERS,
    "Cache-Control": "private, no-cache, max-age=0",
    ETag: input.etag,
  };
  if (input.notModified) return new Response(null, { status: 304, headers });
  return new Response(input.body, {
    status: 200,
    headers: {
      ...headers,
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `inline; filename="${input.filename}"`,
    },
  });
}

/**
 * A self-contained HTML page (the emergency card, or its miss), never kept by
 * any cache. A miss is a real 404 status, not a 200 with a "not found" body.
 */
export function urlCredentialHtml(html: string, status: 200 | 404): Response {
  return withCredentialHeaders(
    new Response(html, {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    }),
  );
}
