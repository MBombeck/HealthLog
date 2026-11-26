/**
 * The confinement half of the second-factor policy: an account past its
 * enrolment date reaches only the enrolment surface.
 *
 * The hint cookie (`hl_mfa_enroll`) sends pages to `/enroll-mfa` without a
 * database read, but a browser that drops the cookie, or a script holding the
 * session cookie, never sees that redirect. This is the server half, and it
 * asks the policy on every request (`resolveMfaEnrollment`: no query for an
 * account with TOTP, the request's one settings read for an account no policy
 * covers). It never trusts a due date stored on the session: a session that
 * began before the policy existed carries none, and a policy switched on, or
 * a grace period shortened, after sign-in would not show in one. Still
 * required: the request is refused unless it is one the enrolment needs.
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
  MFA_POLICY_USER_SELECT,
  resolveMfaEnrollment,
  resolveMfaEnrollmentRequired,
  sessionMfaDueAt,
  sessionMfaRecordStale,
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
    select: MFA_POLICY_USER_SELECT,
  });
  if (!user) return null;
  return sessionMfaDueAt(await resolveMfaEnrollment(userId, user));
}

interface ConfinableSession {
  id: string;
  mfaEnrollmentDueAt: Date | null;
  user: MfaPolicyUser & { id: string };
}

function enrollmentRequiredError(): HttpError {
  return new HttpError(
    403,
    "Set up two-factor sign-in to continue",
    "auth.mfa.enrollment_required",
  );
}

/**
 * Refuse a browser request when the session's account has to enrol a factor
 * now and the request is not one the enrolment needs. The session's recorded
 * due date is brought in line with the answer (a record, not an input).
 */
export async function enforceMfaEnrollment(
  session: ConfinableSession,
): Promise<void> {
  const enrollment = await resolveMfaEnrollment(session.user.id, session.user);
  if (sessionMfaRecordStale(session.mfaEnrollmentDueAt, enrollment)) {
    const dueAt = sessionMfaDueAt(enrollment);
    // The record only: a failed write must not decide the request.
    await prisma.session
      .update({
        where: { id: session.id },
        data: { mfaEnrollmentDueAt: dueAt },
      })
      .catch(() => {});
    session.mfaEnrollmentDueAt = dueAt;
  }
  if (enrollment.state !== "required") return;

  const apiPath = getEvent()?.getHttpPath();
  if (apiPath !== undefined) {
    if (isMfaEnrollmentApiPath(apiPath)) return;
    throw enrollmentRequiredError();
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

/**
 * The same confinement for a sign-in token (`["*"]`, minted by login, the
 * native hand-offs and refresh). Such a token may have been issued before the
 * policy applied, so it is judged by what holds now: past the due date it
 * reaches the enrolment API only (the account payload says why, sign-out
 * works) and every other route answers 403 `auth.mfa.enrollment_required`.
 * A narrow token is not a sign-in and is left to its scope.
 */
export async function refuseConfinedBearer(
  user: MfaPolicyUser & { id: string },
): Promise<void> {
  if (!(await resolveMfaEnrollmentRequired(user.id, user))) return;
  const apiPath = getEvent()?.getHttpPath();
  if (apiPath !== undefined && isMfaEnrollmentApiPath(apiPath)) return;
  throw enrollmentRequiredError();
}
