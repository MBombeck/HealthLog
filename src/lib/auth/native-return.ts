/**
 * The native sign-in's opt-in https return (#163 B2).
 *
 * By default the native SSO leg ends on the compiled-in custom scheme
 * `healthlog://oidc-callback`. An app build that carries an associated domain
 * for this instance may instead ask for `return=https` on
 * `GET /api/auth/oidc/login`; the callback then ends on this instance's own
 * `https://<host>/auth/native-return?…` with exactly the parameters the scheme
 * would carry (`code`, `mfa_ticket` + `methods`, `error`, `purgeAt`).
 *
 * Kept free of database imports so the edge proxy can read the path.
 */

/**
 * The fixed return path. A compile-time constant, like the scheme: there is
 * no operator- or client-supplied return target anywhere. Announced as
 * `nativeReturnPath` on `GET /api/auth/oidc/status` and listed in the
 * `apple-app-site-association` file, so both always name the same address.
 */
export const NATIVE_OIDC_RETURN_PATH = "/auth/native-return";

/**
 * The origin the https return is built on: the operator-set
 * `NEXT_PUBLIC_APP_URL`, origin only, and only when it is https. Never the
 * request's own Host or forwarded headers, which a caller controls. Null on an
 * instance served over plain http or without a usable app URL, where the
 * return is not offered at all (an associated domain needs https anyway).
 */
export function nativeHttpsReturnOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_APP_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}
