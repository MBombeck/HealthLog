/**
 * Admin-enforced MFA policy — the forced-enrollment gate.
 *
 * Three policies can require an account to have a second factor (a confirmed
 * TOTP secret, a registered security key, or a passkey):
 *
 *   - `AppSettings.mfaRequired`: every account;
 *   - `AppSettings.mfaRequiredForAdmins` (v1.50, on by default): admin accounts;
 *   - `User.mfaEnforced`: one account, set by an admin.
 *
 * An instance policy gives the accounts it newly covers a grace period
 * (`AppSettings.mfaGraceDays`, counted from `mfaPolicySince`, which moves to
 * now whenever a policy is switched on, and which the v1.50 migration set to
 * the update for existing installs). During it the account is asked to enrol
 * and works as before. After it — and at once under a per-user enforcement —
 * the account is confined until it enrols:
 *
 *   - in the browser, the session reaches only the enrolment surface
 *     (`Session.mfaEnrollmentDueAt`, read by `getSession`; the hint cookie
 *     below sends pages to `/enroll-mfa` without a database read);
 *   - a native or SSO-native sign-in is refused with
 *     `auth.mfa.enrollment_required` (`finishLogin`), because a Bearer
 *     transport has no enrolment surface to confine to.
 *
 * The operator/CLI escape hatch (`scripts/disable-mfa.ts`, switching the
 * policies off) stays the recovery of last resort. A public demo shares one
 * account with every visitor, which cannot enrol a factor: no policy applies
 * there.
 */
import { readOperatorRow } from "@/lib/settings/operator-row";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";

/** UX-hint cookie the proxy reads to redirect into the enrollment surface. */
export const MFA_ENROLL_COOKIE = "hl_mfa_enroll";
const MFA_ENROLL_PENDING = "required";

/** The session cookie max-age, mirrored so the hint expires with the session. */
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

export interface MfaPolicyUser {
  totpConfirmedAt: Date | null;
  mfaEnforced: boolean;
  role: string;
}

/**
 * `none`: no policy covers the account, or it has a factor. `grace`: a policy
 * covers it and `dueAt` is still ahead. `required`: it has to enrol now.
 */
export type MfaEnrollmentState = "none" | "grace" | "required";

export interface MfaEnrollment {
  state: MfaEnrollmentState;
  /** When the account has to have a factor by; null for `none`. */
  dueAt: Date | null;
}

const NOT_REQUIRED: MfaEnrollment = { state: "none", dueAt: null };
const DAY_MS = 24 * 60 * 60 * 1000;

/** The policy columns, from the request's operator row or a fresh singleton. */
async function readPolicy(): Promise<{
  mfaRequired: boolean;
  mfaRequiredForAdmins: boolean;
  mfaGraceDays: number;
  mfaPolicySince: Date;
}> {
  const row = await readOperatorRow();
  if (row) return row;
  // No settings row yet: create the singleton with its defaults, so the grace
  // period of an install that never saved a setting starts once and ends.
  return prisma.appSettings.upsert({
    where: { id: "singleton" },
    create: {},
    update: {},
    select: {
      mfaRequired: true,
      mfaRequiredForAdmins: true,
      mfaGraceDays: true,
      mfaPolicySince: true,
    },
  });
}

/**
 * Whether, and by when, the account must enrol a second factor. Cheap by
 * construction: an account with TOTP answers with zero queries, one no policy
 * covers with the request's one settings read.
 */
export async function resolveMfaEnrollment(
  userId: string,
  user: MfaPolicyUser,
  now: Date = new Date(),
): Promise<MfaEnrollment> {
  // Already has a confirmed TOTP secret → enrolled, nothing required.
  if (user.totpConfirmedAt) return NOT_REQUIRED;
  if (process.env.DEMO_MODE === "true") return NOT_REQUIRED;

  const policy = await readPolicy();
  const instancePolicy =
    policy.mfaRequired ||
    (user.role === "ADMIN" && policy.mfaRequiredForAdmins);
  if (!instancePolicy && !user.mfaEnforced) return NOT_REQUIRED;

  // A policy applies and there is no TOTP. Any of three credentials satisfies
  // the requirement: a registered security key (the MFA WebAuthn store,
  // matching `requireFreshMfa`'s either-factor rule) OR a primary passkey — a
  // passwordless passkey login is itself a phishing-resistant possession
  // factor and stamps `mfaVerifiedAt` (M-review M1), so a passkey user is
  // "enrolled" for enforcement purposes and is not nagged to add a second
  // factor on top.
  const [webauthnKeyCount, passkeyCount] = await Promise.all([
    prisma.webauthnMfaCredential.count({ where: { userId } }),
    prisma.passkey.count({ where: { userId } }),
  ]);
  if (webauthnKeyCount > 0 || passkeyCount > 0) return NOT_REQUIRED;

  // An admin's per-account enforcement is a deliberate act and applies at
  // once, as it always has.
  if (user.mfaEnforced) return { state: "required", dueAt: now };

  const dueAt = new Date(
    policy.mfaPolicySince.getTime() + policy.mfaGraceDays * DAY_MS,
  );
  return { state: dueAt > now ? "grace" : "required", dueAt };
}

/** Whether the account must enrol before using the app any further. */
export async function resolveMfaEnrollmentRequired(
  userId: string,
  user: MfaPolicyUser,
): Promise<boolean> {
  return (await resolveMfaEnrollment(userId, user)).state === "required";
}

/**
 * The instant a session of this account stops reaching anything but the
 * enrolment surface: the due date under a policy, null when none applies.
 * Stamped on the session at sign-in and on the account read every app boot
 * makes, so `getSession` decides without a query per request.
 */
export function sessionMfaDueAt(enrollment: MfaEnrollment): Date | null {
  return enrollment.state === "none" ? null : enrollment.dueAt;
}

/** Set or clear the forced-enrollment UX-hint cookie. */
export async function setMfaEnrollCookie(required: boolean): Promise<void> {
  const cookieStore = await cookies();
  if (required) {
    cookieStore.set(MFA_ENROLL_COOKIE, MFA_ENROLL_PENDING, {
      // UX hint only — read by the proxy to redirect; the real check is the
      // server-side recompute on every /api/auth/me + auth surface.
      httpOnly: false,
      secure: shouldEmitSecureCookie(),
      sameSite: "strict",
      maxAge: COOKIE_MAX_AGE_S,
      path: "/",
    });
  } else {
    cookieStore.delete(MFA_ENROLL_COOKIE);
  }
}

/**
 * Recompute the requirement for a user, sync the hint cookie to it and, when
 * the request carries a session, the session's due date. Answers the state for
 * the account payload.
 */
export async function syncMfaEnrollCookie(
  userId: string,
  user: MfaPolicyUser,
  session?: { id: string; mfaEnrollmentDueAt: Date | null },
): Promise<MfaEnrollment> {
  const enrollment = await resolveMfaEnrollment(userId, user);
  await setMfaEnrollCookie(enrollment.state === "required");
  if (session) {
    const dueAt = sessionMfaDueAt(enrollment);
    if (dueAt?.getTime() !== session.mfaEnrollmentDueAt?.getTime()) {
      await prisma.session.update({
        where: { id: session.id },
        data: { mfaEnrollmentDueAt: dueAt },
      });
    }
  }
  return enrollment;
}
