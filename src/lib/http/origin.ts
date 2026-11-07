/**
 * The absolute origin a link the app hands out is built from.
 *
 * Prefers the forwarded host and protocol a reverse proxy sets (the documented
 * self-hosting path fronts the app with Caddy, Traefik or nginx), falling back
 * to the request URL's own origin. It trusts `X-Forwarded-Host` exactly as far
 * as the share links always have: the value only ever reaches the caller who
 * sent it, in the response to their own authenticated request.
 *
 * Shared by the clinician share links and the cycle calendar feed, so the two
 * links a person copies out of the app always name the same host.
 */
export function resolveOrigin(request: Request): string {
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    new URL(request.url).protocol.replace(":", "");
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host") ||
    new URL(request.url).host;
  return `${proto}://${host}`;
}
