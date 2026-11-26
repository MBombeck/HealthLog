/**
 * Which transport a request is answered on: the browser's cookie session, or
 * the token transport the native app and the programmatic clients use.
 *
 * Two questions, kept apart on purpose:
 *
 *   `carriesBearer` — the request presents `Authorization: Bearer`. Then the
 *   Bearer decides who is calling, everywhere. A session cookie on the same
 *   request is not a second answer: `getSession()` does not read it, so the
 *   cookie-only guards (`requireAdmin`, `requireCookieAuth`, `requireFreshMfa`)
 *   refuse the request exactly as they refuse a Bearer caller with no cookie,
 *   and the one place that still looks at the cookie is the conflict check in
 *   `authenticateBearer`, which refuses a cookie naming somebody else.
 *
 *   `usesTokenTransport` — the request is a Bearer caller, or a native sign-in
 *   that is about to receive tokens in the body (the same test `finishLogin`
 *   uses to choose its branch). Such a request is never handed a web session
 *   cookie or one of its hint cookies. A native client keeps whatever
 *   `Set-Cookie` it is sent in a shared cookie store and replays it on every
 *   later request, including after its own sign-out and under the next
 *   account to sign in on the device; a cookie it was never meant to hold is
 *   a second identity riding beside its token.
 *
 * A browser never sends `Authorization: Bearer` to this app: the web client
 * authenticates by cookie alone, and a cross-origin page cannot attach the
 * header without a CORS grant this app never gives.
 *
 * Only a Bearer in this app's own format counts (`hlk_<64 hex>`, the one
 * shape every token it has ever minted carries). A reverse proxy in front of
 * the app may forward a credential of its own in the same header (an
 * oauth2-proxy with `--pass-authorization-header`, a forward-auth answer that
 * sets `Authorization`). Such a header names no account here, so it is not a
 * second identity to choose between: the request is answered on its cookie,
 * as if the header were absent. Treated as a token, it switched the cookie
 * off and signed every browser behind such a proxy out of the app.
 */
import { headers } from "next/headers";

import { isNativeClientRequest } from "./issue-token";
import { shouldIssueBearerToken } from "./native-client";

/** The `Authorization` prefix of a token this app minted. */
const OWN_BEARER_PREFIX = "Bearer hlk_";

/**
 * The raw token of an `Authorization` value in this app's own format
 * (`Bearer hlk_…`), else null. Every place that decides between the token and
 * the cookie reads the header through this, so the two cannot disagree.
 */
export function ownBearerToken(
  authorization: string | null | undefined,
): string | null {
  return authorization?.startsWith(OWN_BEARER_PREFIX)
    ? authorization.slice("Bearer ".length)
    : null;
}

/** Whether a header set presents a Bearer token of this app's own format. */
export function carriesBearer(headerSet: Headers): boolean {
  return ownBearerToken(headerSet.get("authorization")) !== null;
}

/**
 * Whether a header set belongs to the token transport: a Bearer caller, or a
 * native sign-in answered with tokens rather than a session cookie.
 */
export function usesTokenTransport(headerSet: Headers): boolean {
  return (
    carriesBearer(headerSet) ||
    shouldIssueBearerToken(headerSet) ||
    isNativeClientRequest(headerSet)
  );
}

/**
 * The current request's headers, or null outside a request scope (a script, a
 * job, a unit test that mocks only the cookie store). Null reads as "not the
 * token transport", which is what every such caller has always been.
 */
async function currentHeaders(): Promise<Headers | null> {
  try {
    const list = await headers();
    return typeof list?.get === "function" ? (list as Headers) : null;
  } catch {
    return null;
  }
}

/** `carriesBearer` for the request being handled. */
export async function requestCarriesBearer(): Promise<boolean> {
  const list = await currentHeaders();
  return list ? carriesBearer(list) : false;
}

/** `ownBearerToken` for the request being handled; null outside one. */
export async function requestOwnBearerToken(): Promise<string | null> {
  const list = await currentHeaders();
  return list ? ownBearerToken(list.get("authorization")) : null;
}

/** `usesTokenTransport` for the request being handled. */
export async function requestUsesTokenTransport(): Promise<boolean> {
  const list = await currentHeaders();
  return list ? usesTokenTransport(list) : false;
}
