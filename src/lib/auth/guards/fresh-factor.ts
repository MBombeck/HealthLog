import { prisma } from "@/lib/db";
import { hasSecondFactorEnrolled } from "@/lib/auth/second-factor";

/**
 * Default step-up freshness window (5 minutes) for sensitive mutations.
 * Within the 5–15 min band OWASP recommends; tight end because the gated
 * actions (disable MFA, regenerate codes, and later key rotation / export)
 * are destructive.
 */
export const MFA_STEP_UP_MAX_AGE_SECONDS = 5 * 60;

/**
 * Which credentials count when asking "can this account produce a fresh-factor
 * proof at all".
 *
 * The gate is the same either way — a `Session.mfaVerifiedAt` inside the window
 * on the cookie path, an elevation minted from a `FRESH_FACTOR_METHODS` proof on
 * the Bearer path. What differs is the pre-check that decides whether refusing
 * would be a gate or a dead end, and the honest answer to that depends on what
 * the route is protecting.
 *
 *   `second-factor` — a confirmed TOTP secret or a registered second-factor
 *   security key. The default of `requireMfaManagementAuth`, and the right
 *   question for the routes that MANAGE a second factor: there is nothing there
 *   to protect if nothing is enrolled.
 *
 *   `any-possession` — the above, OR a registered PRIMARY passkey. The default
 *   of `requireFreshMfa` since v1.43.3, and the right question for a route
 *   protecting the passkey itself, because a passkey is a
 *   possession factor in its own right and this codebase already treats it as
 *   one in three places: `/api/auth/passkey/login-verify` stamps `mfaVerifiedAt`
 *   on a passkey login (v1.23, M-review M1), `passkey` is in
 *   `FRESH_FACTOR_METHODS` so a passkey-proved elevation reaches the fresh-factor
 *   routes, and `resolveMfaEnrollmentRequired` counts a primary passkey as
 *   satisfying the enforcement policy outright. A passkey-only account can
 *   therefore clear the gate on both transports, and asking the narrower
 *   question would have thrown `mfa_not_enrolled` at an account that was holding
 *   the proof all along.
 */
export type FreshFactorProofSource = "second-factor" | "any-possession";

/*
 * A PASSKEY COUNTS AS A SECOND FACTOR FOR THE UNCONDITIONAL STEP-UP GATE.
 *
 * Maintainer decision, v1.43.3. `requireFreshMfa` defaults to
 * `any-possession`, so an account whose only strong credential is a passkey
 * is no longer refused `mfa_not_enrolled` on the routes that call it directly
 * (creating, editing, deleting and handing over a managed profile, inviting
 * and removing a guardian, the admin key rotation). It clears the gate the
 * way every other account does: a passkey sign-in or a passkey re-proof at
 * `POST /api/auth/reproof` stamps `Session.mfaVerifiedAt`, and the gate reads
 * that stamp inside the same five minutes.
 *
 * The limits, each deliberate:
 *
 *   - `hasSecondFactorEnrolled` keeps its narrow meaning. It decides whether
 *     the CONDITIONAL gates (`requireFreshMfaIfEnrolled`,
 *     `requireFreshMfaOrElevationIfEnrolled`, `requireRecentProof`'s branches,
 *     the enrollment proofs) apply at all. Widening it would newly gate
 *     account deletion, the data reset, the password change and the export
 *     for every passkey holder, take the password re-proof away from them, and
 *     change what the native app's Bearer requests need. None of that is part
 *     of the decision.
 *   - Password login is untouched. It asks for a second factor from
 *     `totpConfirmedAt` and the security-key count only; a passkey-only
 *     account signing in with its password is not challenged, as before.
 *   - The MFA-management routes (`requireMfaManagementAuth`) still default to
 *     `second-factor`: disabling TOTP or rotating recovery codes on an account
 *     with no second factor has nothing to protect.
 *   - Cookie only, as ever. The Bearer path is not reached from here.
 */

/**
 * Can this account produce a fresh-factor proof at all?
 *
 * The wider question, asked by the routes that gate on possession rather than
 * on second-factor management. See {@link FreshFactorProofSource} for why a
 * primary passkey answers yes and where the codebase already says so; see
 * {@link hasSecondFactorEnrolled} for why the narrower predicate must not be
 * widened into this one.
 */
export async function canProveFreshFactor(
  user: { id: string; totpConfirmedAt: Date | null },
  proofSource: FreshFactorProofSource,
): Promise<boolean> {
  if (await hasSecondFactorEnrolled(user)) return true;
  if (proofSource === "second-factor") return false;
  const passkeyCount = await prisma.passkey.count({
    where: { userId: user.id },
  });
  return passkeyCount > 0;
}
