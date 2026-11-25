/**
 * Admin-enforced MFA policy — the forced-enrollment gate.
 *
 * The effective per-user requirement is the OR of an instance-wide policy
 * (`AppSettings.mfaRequired`) and a per-user override (`User.mfaEnforced`).
 * When MFA is required AND the account has NO active second factor (no
 * confirmed TOTP and no registered security key), the user is sent through a
 * forced-enrollment interstitial after sign-in until they enrol one.
 *
 * The gate is surfaced exactly like the onboarding gate: a non-httpOnly UX-hint
 * cookie (`hl_mfa_enroll`) the proxy reads without a DB round-trip. It is a
 * server-authoritative nudge, not a cryptographic wall — every issuing auth
 * surface and `/api/auth/me` recompute it from the DB, so a locally edited
 * cookie is corrected on the next data fetch. The user can always reach
 * `/settings/security` (and the enrollment APIs) to enrol, so nobody is locked
 * out; the operator/CLI escape hatch (`scripts/disable-mfa.ts`, toggling the
 * policy off) is the recovery path of last resort.
 */
import { readOperatorRow } from "@/lib/settings/operator-row";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import { requestUsesTokenTransport } from "@/lib/auth/token-transport";

/** UX-hint cookie the proxy reads to redirect into the enrollment surface. */
export const MFA_ENROLL_COOKIE = "hl_mfa_enroll";
const MFA_ENROLL_PENDING = "required";

/** The session cookie max-age, mirrored so the hint expires with the session. */
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

interface MfaPolicyUser {
  totpConfirmedAt: Date | null;
  mfaEnforced: boolean;
}

/**
 * Resolve whether the account must enrol a second factor before using the app.
 * Cheap by construction: an account that already has TOTP short-circuits with
 * zero queries; an instance with the policy off resolves with one small read.
 */
export async function resolveMfaEnrollmentRequired(
  userId: string,
  user: MfaPolicyUser,
): Promise<boolean> {
  // Already has a confirmed TOTP secret → enrolled, nothing required.
  if (user.totpConfirmedAt) return false;

  const settings = await readOperatorRow();
  const policyApplies = Boolean(settings?.mfaRequired) || user.mfaEnforced;
  if (!policyApplies) return false;

  // Policy applies and there is no TOTP. Any of three credentials satisfies the
  // requirement: a registered security key (the MFA WebAuthn store, matching
  // `requireFreshMfa`'s either-factor rule) OR a primary passkey — a
  // passwordless passkey login is itself a phishing-resistant possession factor
  // and stamps `mfaVerifiedAt` (M-review M1), so a passkey user is "enrolled"
  // for enforcement purposes and is not nagged to add a second factor on top.
  const [webauthnKeyCount, passkeyCount] = await Promise.all([
    prisma.webauthnMfaCredential.count({ where: { userId } }),
    prisma.passkey.count({ where: { userId } }),
  ]);
  return webauthnKeyCount === 0 && passkeyCount === 0;
}

/** Set or clear the forced-enrollment UX-hint cookie. */
export async function setMfaEnrollCookie(required: boolean): Promise<void> {
  // A browser hint, never sent on the token transport: the proxy that reads
  // it guards pages, and the native client reads `mfaEnrollment` from
  // `/api/auth/me` instead (see `token-transport.ts`).
  if (await requestUsesTokenTransport()) return;
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

/** Recompute the requirement for a user and sync the hint cookie to it. */
export async function syncMfaEnrollCookie(
  userId: string,
  user: MfaPolicyUser,
): Promise<void> {
  const required = await resolveMfaEnrollmentRequired(userId, user);
  await setMfaEnrollCookie(required);
}
