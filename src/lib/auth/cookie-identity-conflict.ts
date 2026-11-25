/**
 * Refuse a session cookie that rides beside a Bearer for a different account.
 *
 * `getSession()` does not read the session cookie on a request that presents
 * a Bearer: the Bearer decides who is calling. This is the one place that
 * still looks at that cookie, and only to refuse. The native client keeps
 * every cookie it is ever sent in a shared store and replays it, so a session
 * left there by an earlier sign-in, even another account's, can arrive beside
 * the current token. Two identities on one request: neither is chosen.
 */
import { cookies } from "next/headers";

import { prisma } from "@/lib/db";
import { validateSessionFromCookieValue } from "@/lib/auth/session";
import {
  expireSessionCookies,
  readSessionCookie,
} from "@/lib/auth/session-cookie";

/**
 * Called by `authenticateBearer` once the token has resolved to `bearerUserId`.
 *
 * The cookie is read without being trusted for anything: no sliding expiry,
 * no re-issue, no identity handed back. If it names a live session of another
 * account, that session is ended and its cookie expired on this response — it
 * came from the client's own cookie store and was presented with its secret,
 * so this is the sign-out it missed — and the caller answers 401. A cookie
 * naming the same account changes nothing: the Bearer is the caller, with the
 * Bearer's scope.
 *
 * Returns true when the request must be refused. A session store that cannot
 * be read propagates its 503 rather than reading as "no cookie": a check that
 * cannot run must not wave the request through.
 */
export async function refuseCookieIdentityConflict(
  bearerUserId: string,
): Promise<boolean> {
  let jar: Awaited<ReturnType<typeof cookies>>;
  try {
    jar = await cookies();
  } catch {
    // Outside a request scope there is no cookie to conflict with.
    return false;
  }
  const cookieValue = readSessionCookie(jar)?.value;
  if (!cookieValue) return false;

  const resolved = await validateSessionFromCookieValue(cookieValue);
  if (!resolved || resolved.user.id === bearerUserId) return false;

  await prisma.session.deleteMany({ where: { id: resolved.session.id } });
  try {
    expireSessionCookies(jar);
  } catch {
    // Read-only cookie context; the session row is gone either way.
  }
  return true;
}
