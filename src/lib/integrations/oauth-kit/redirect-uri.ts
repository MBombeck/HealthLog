/**
 * The OAuth `redirect_uri` of a provider integration.
 *
 * An explicit `<PROVIDER>_REDIRECT_URI` wins; otherwise the callback route
 * under `NEXT_PUBLIC_APP_URL`. An empty or blank value counts as unset: the
 * compose whitelist materialises an unset variable as an empty string, which
 * must fall through to the derived URI rather than go out as `redirect_uri=`.
 */
import { envOr, envValue } from "@/lib/env";

/** The configured or derived redirect URI, unchecked. */
export function derivedRedirectUri(
  envVar: string,
  callbackPath: string,
): string {
  return envOr(envVar, `${envValue("NEXT_PUBLIC_APP_URL")}${callbackPath}`);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The redirect URI, checked against an allowlist before it is used
 * (defence in depth for the providers that need it).
 *
 * The value is operator configuration, not user input, and the provider's
 * registered-redirect check is the real backstop. But a misconfigured or
 * `Host`-coerced `NEXT_PUBLIC_APP_URL` (a reverse proxy reflecting a forwarded
 * Host) would otherwise send the authorization code's landing URL off-origin,
 * so the handshake fails fast instead:
 *   - the URI must be absolute and parseable,
 *   - https, or http on a loopback development host,
 *   - on the fixed callback path,
 *   - and an explicit URI must share its origin with `NEXT_PUBLIC_APP_URL`.
 */
export function checkedRedirectUri(
  label: string,
  envVar: string,
  callbackPath: string,
): string {
  const explicit = envValue(envVar);
  const appUrl = envValue("NEXT_PUBLIC_APP_URL");
  const raw = explicit ?? (appUrl ? `${appUrl}${callbackPath}` : undefined);

  if (!raw) {
    throw new Error(
      `${label} redirect_uri is not configured — set ${envVar} or NEXT_PUBLIC_APP_URL`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} redirect_uri is not an absolute URL: ${raw}`);
  }

  const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopback)
  ) {
    throw new Error(
      `${label} redirect_uri must be https (or http on localhost): ${parsed.origin}`,
    );
  }

  if (parsed.pathname !== callbackPath) {
    throw new Error(
      `${label} redirect_uri must target ${callbackPath}, got ${parsed.pathname}`,
    );
  }

  if (explicit && appUrl) {
    let appOrigin: string;
    try {
      appOrigin = new URL(appUrl).origin;
    } catch {
      throw new Error(`NEXT_PUBLIC_APP_URL is not an absolute URL: ${appUrl}`);
    }
    if (parsed.origin !== appOrigin) {
      throw new Error(
        `${label} redirect_uri origin ${parsed.origin} does not match NEXT_PUBLIC_APP_URL origin ${appOrigin}`,
      );
    }
  }

  return parsed.toString();
}
