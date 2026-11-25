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
 */
import { headers } from "next/headers";

import { isNativeClientRequest } from "./issue-token";
import { shouldIssueBearerToken } from "./native-client";

/** Whether a header set presents `Authorization: Bearer …`. */
export function carriesBearer(headerSet: Headers): boolean {
  return headerSet.get("authorization")?.startsWith("Bearer ") ?? false;
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

/** `usesTokenTransport` for the request being handled. */
export async function requestUsesTokenTransport(): Promise<boolean> {
  const list = await currentHeaders();
  return list ? usesTokenTransport(list) : false;
}
