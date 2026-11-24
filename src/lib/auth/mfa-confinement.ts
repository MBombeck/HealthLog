/**
 * The web half of the second-factor policy: a session whose account is past
 * its enrolment date reaches only the enrolment surface.
 *
 * The hint cookie (`hl_mfa_enroll`) sends pages to `/enroll-mfa` without a
 * database read, but a browser that drops the cookie, or a script holding the
 * session cookie, never sees that redirect. This is the server half:
 * `getSession` reads `Session.mfaEnrollmentDueAt` from the row it already
 * loaded, and once that instant has passed it asks the policy again
 * (`resolveMfaEnrollment`). Still required: the request is refused unless it
 * is one the enrolment needs. No longer required (the account enrolled, the
 * operator lifted the policy): the stamp is cleared and the session is whole.
 *
 * Which request it is comes from the wide event's path for an API route
 * (`apiHandler` sets it from the request URL) and, for a page render, from the
 * `x-healthlog-path` header the proxy writes on every page request. A request
 * with neither is treated as outside the allowlist: confinement fails closed.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/api-errors";
import { getEvent } from "@/lib/logging/context";
import {
  resolveMfaEnrollment,
  sessionMfaDueAt,
  type MfaPolicyUser,
} from "@/lib/auth/mfa-enrollment";

/** Request header the proxy stamps with the page path. */
export const PAGE_PATH_HEADER = "x-healthlog-path";

/** API routes a confined session may call: reading the account, signing out, enrolling. */
const API_EXACT = new Set([
  "/api/auth/me",
  "/api/auth/logout",
  "/api/auth/reproof",
  "/api/auth/oidc/reproof",
  "/api/auth/passkeys",
  "/api/auth/passkey/register-options",
  "/api/auth/passkey/register-verify",
  "/api/auth/me/mfa",
]);
const API_PREFIXES = ["/api/auth/me/mfa/"];

/** Pages that render the enrolment cards. */
const PAGE_PREFIXES = ["/enroll-mfa", "/settings/security"];

function startsWithSegment(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function isMfaEnrollmentApiPath(path: string): boolean {
  return API_EXACT.has(path) || API_PREFIXES.some((p) => path.startsWith(p));
}

export function isMfaEnrollmentPagePath(path: string): boolean {
  return PAGE_PREFIXES.some((p) => startsWithSegment(path, p));
}

/**
 * The due date a new session of this account carries, read at sign-in: null
 * when no policy covers the account or it has a factor.
 */
export async function mfaDueAtForSignIn(userId: string): Promise<Date | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, totpConfirmedAt: true, mfaEnforced: true },
  });
  if (!user) return null;
  return sessionMfaDueAt(await resolveMfaEnrollment(userId, user));
}

interface ConfinableSession {
  id: string;
  mfaEnrollmentDueAt: Date | null;
  user: MfaPolicyUser & { id: string };
}

/**
 * Refuse the request when the session's account is past its enrolment date
 * and the request is not one the enrolment needs. A no-op for every session
 * without a due date in the past, which is every session but these.
 */
export async function enforceMfaEnrollment(
  session: ConfinableSession,
): Promise<void> {
  const due = session.mfaEnrollmentDueAt;
  if (!due || due.getTime() > Date.now()) return;

  const enrollment = await resolveMfaEnrollment(session.user.id, session.user);
  if (enrollment.state !== "required") {
    const dueAt = sessionMfaDueAt(enrollment);
    await prisma.session.update({
      where: { id: session.id },
      data: { mfaEnrollmentDueAt: dueAt },
    });
    session.mfaEnrollmentDueAt = dueAt;
    return;
  }

  const apiPath = getEvent()?.getHttpPath();
  if (apiPath !== undefined) {
    if (isMfaEnrollmentApiPath(apiPath)) return;
    throw new HttpError(
      403,
      "Set up two-factor sign-in to continue",
      "auth.mfa.enrollment_required",
    );
  }

  let pagePath: string | null = null;
  try {
    pagePath = (await headers()).get(PAGE_PATH_HEADER);
  } catch {
    pagePath = null;
  }
  if (pagePath !== null && isMfaEnrollmentPagePath(pagePath)) return;
  redirect("/enroll-mfa");
}
