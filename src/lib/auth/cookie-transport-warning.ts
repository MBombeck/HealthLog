/**
 * The sign-in's operator log line for a `Secure` cookie about to be set on a
 * plain-HTTP request. Kept apart from `./secure-cookie.ts` because it reads
 * the request through `resolveRequestOrigin`, which needs Node modules, and
 * `secure-cookie.ts` sits in the Edge proxy's graph.
 */
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import { resolveRequestOrigin } from "@/lib/http/origin";

/**
 * One-line diagnostic for the single most common self-host login-loop cause:
 * the app is about to set a `Secure` session cookie
 * (`shouldEmitSecureCookie() === true`) while the request itself arrived over
 * plain HTTP. The browser silently drops a `Secure` cookie on an `http://`
 * origin, so the next request is unauthenticated and the user bounces back to
 * the login page with no error at all — it reads like a wrong password forever.
 *
 * Returns a human-readable message when the mismatch is detected, else `null`.
 * The caller logs it at login time (`console.warn` survives the prod
 * `console.*` strip) so an operator sees WHY login loops without having to find
 * the note buried in three docs. Non-fatal: the login still completes; the
 * cookie just won't stick until `SESSION_COOKIE_SECURE=false` is set (or TLS is
 * fronted).
 *
 * A request counts as HTTPS by the one scheme resolver the setup check and
 * the links share (`resolveRequestOrigin` in `@/lib/http/origin`): what a
 * trusted proxy reported, else the configured public URL when it names this
 * host, else the request URL. A proxy that terminates TLS, omits
 * `X-Forwarded-Proto` and runs without a configured public URL still reads as
 * plain HTTP; the message names that case so it stays actionable either way.
 */
export function detectInsecureCookieTransport(req: {
  headers: Headers;
  url: string;
}): string | null {
  if (!shouldEmitSecureCookie()) return null;

  let protocol: "http" | "https" = "http";
  try {
    protocol = resolveRequestOrigin(req).protocol;
  } catch {
    protocol = "http";
  }
  if (protocol === "https") return null;

  return (
    "This request arrived over plain HTTP but the session cookie is being " +
    "issued with the `Secure` flag — the browser will drop it and login will " +
    "loop back to the sign-in page with no error message. If you serve HTTP " +
    "directly (LAN / NAS / Tailscale, no TLS reverse proxy), set " +
    "SESSION_COOKIE_SECURE=false. If a reverse proxy terminates TLS in front " +
    "of this container, make sure it forwards `X-Forwarded-Proto: https`."
  );
}
