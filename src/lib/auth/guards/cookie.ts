import { getEvent } from "@/lib/logging/context";
import { getSession } from "@/lib/auth/session";
import { meterAccountWrite } from "@/lib/auth/write-meter";
import { AUTH_ERROR_CODES, HttpError } from "@/lib/api-errors";

import type { AuthContext } from "./context";

/**
 * Require an authenticated admin user. Throws HttpError(401) or HttpError(403).
 * Cookie-only — Bearer tokens never elevate to admin (security boundary).
 * Automatically annotates the Wide Event with auth context.
 *
 * Unreachable by a switch, structurally: it resolves through
 * `getSession()`, which knows only who is calling, and the role is read off
 * that row. Switching into an ADMIN's record therefore confers nothing, and
 * making it confer something would take a deliberate edit here rather than an
 * oversight elsewhere.
 */
export async function requireAdmin(): Promise<AuthContext> {
  const sessionData = await getSession();
  if (!sessionData)
    throw new HttpError(401, "Not authenticated", AUTH_ERROR_CODES.missing);

  const evt = getEvent();
  if (evt) {
    evt.setAuth({
      user_id: sessionData.user.id,
      user_role: sessionData.user.role,
      auth_method: "session",
    });
  }

  if (sessionData.user.role !== "ADMIN") {
    throw new HttpError(403, "Admin access required", AUTH_ERROR_CODES.admin);
  }
  await meterAccountWrite(sessionData.user.id);
  return { ...sessionData, authMethod: "cookie" };
}

/**
 * Require a cookie-backed session, refusing Bearer tokens.
 *
 * Cookie-only by the same structural argument as `requireAdmin`: it resolves
 * the session via `getSession()` (which reads only the session cookie) and
 * never falls through to the Bearer branch. The second-factor management
 * surfaces (TOTP enroll / confirm / disable / recovery-code regenerate) use
 * this so an API token — even a wildcard one — can never enrol or tear down
 * MFA on the account it belongs to. MFA management is a browser-only action.
 */
export async function requireCookieAuth(): Promise<AuthContext> {
  const sessionData = await getSession();
  if (!sessionData)
    throw new HttpError(401, "Not authenticated", AUTH_ERROR_CODES.missing);

  const evt = getEvent();
  if (evt) {
    evt.setAuth({
      user_id: sessionData.user.id,
      user_role: sessionData.user.role,
      auth_method: "session",
    });
  }
  await meterAccountWrite(sessionData.user.id);
  return { ...sessionData, authMethod: "cookie" };
}
