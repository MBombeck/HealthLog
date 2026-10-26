import type { SessionUser } from "@/lib/auth/session-user";
import { getSession } from "@/lib/auth/session";
import { hasSecondFactorEnrolled } from "@/lib/auth/second-factor";

import { requireBearerAuth } from "./caller";
import { requireCookieAuth } from "./cookie";
import { resolveBearerElevation } from "./elevation";
import {
  MFA_STEP_UP_MAX_AGE_SECONDS,
  type FreshFactorProofSource,
} from "./fresh-factor";
import { requireFreshMfa } from "./fresh-mfa";

/**
 * What an MFA-management route received, with the transport made explicit.
 *
 * The two arms carry DIFFERENT fields on purpose. A cookie caller has a session
 * row and a Bearer caller does not, so `session` exists only on the cookie arm
 * and the compiler refuses to read it on the other. This is the fix for a real
 * defect: the MFA-disable route passed `session.id` to `destroyOtherSessions`,
 * which on the Bearer path was an ApiToken id — matching no session row, so the
 * "keep the current one" exclusion excluded nothing and the caller revoked its
 * own device login. A comment would not have caught that; a type does.
 */
export type MfaManagementContext = {
  user: SessionUser;
  /**
   * Spend the elevation. Call it immediately BEFORE the mutation, once every
   * cheap validation has passed — a 429, a 422, or a wrong factor code must not
   * burn a proof the user then has to mint again against a 5-per-15-minute
   * ceiling.
   *
   * A no-op on the cookie arm (the session stamp is not consumable). On the
   * Bearer arm it is the atomic single-use claim, and it THROWS
   * `StepUpRequiredError` if the claim is lost — so a concurrent redemption
   * still yields exactly one winner even though validation happened earlier.
   */
  commitElevation: () => Promise<void>;
} & (
  | { transport: "cookie"; session: { id: string; expiresAt: Date } }
  | { transport: "bearer"; apiTokenId: string; accessTokenHash: string }
);

/**
 * The single gate for second-factor management.
 *
 * Every MFA-management MUTATION goes through here and nothing else does. The set
 * is frozen by `src/__tests__/step-up-elevation-guard.test.ts`, so a future
 * route cannot quietly join it: widening the reach of an elevation has to be a
 * visible edit to that allowlist.
 *
 * Two accepted proofs, and they are equals rather than a primary and a fallback:
 *
 *   COOKIE — unchanged, byte for byte. A cookie session delegates to
 *   `requireCookieAuth` / `requireFreshMfa` exactly as before this function
 *   existed. The web flow cannot regress here because there is no new code on
 *   its path; the elevation branch is only reached when there is no session at
 *   all.
 *
 *   BEARER + ELEVATION — a token that resolves cleanly AND presents a valid,
 *   unconsumed elevation minted for that same token against a re-proved factor
 *   of sufficient strength. The token alone is never enough.
 *
 * FRESH FACTOR IS ABOUT WHICH FACTOR, NOT JUST HOW RECENT. On the cookie path
 * `requireFreshMfa` reads `Session.mfaVerifiedAt`, and only a completed second
 * factor or a primary passkey login ever writes it — a password login does not.
 * The Bearer arm holds the identical line through `FRESH_FACTOR_METHODS`: a
 * password-proved elevation reaches what a plain cookie session reaches and
 * stops there. Without that rule, a stolen token plus the account password could
 * rotate the recovery codes and spend one to disable the second factor.
 *
 * `requireAdmin` is untouched and stays cookie-only. An elevation cannot reach
 * it — not because a check refuses one, but because `requireAdmin` resolves
 * through `getSession()` and never consults this function or the header.
 *
 * @param options.freshFactor mirrors the cookie path's `requireFreshMfa`. Set by
 *   the destructive routes (disable, recovery-code rotation, security-key
 *   removal, passkey removal).
 * @param options.proofSource which credentials count as "can prove a factor"
 *   when deciding whether the gate is reachable. Defaults to the second-factor
 *   set. Passkey removal passes `"any-possession"` because a primary passkey IS
 *   the proof there — see {@link FreshFactorProofSource}. It changes only the
 *   reachability pre-check; the gate itself is identical either way.
 * @param options.freshFactorIfEnrolled the Bearer arm of ADDING a factor
 *   (TOTP setup, security-key registration). On an account that already has a
 *   second factor, the elevation must come from a second-factor or passkey
 *   proof, the rule `checkCookieEnrollmentProof` holds on the cookie arm; on
 *   one without, a password-proved elevation is still enough. The cookie arm
 *   is not changed by it: those routes run their own enrollment proof there.
 */
export async function requireMfaManagementAuth(
  options: {
    freshFactor?: boolean;
    freshFactorIfEnrolled?: boolean;
    proofSource?: FreshFactorProofSource;
  } = {},
): Promise<MfaManagementContext> {
  const freshFactor = options.freshFactor === true;
  const proofSource = options.proofSource ?? "second-factor";

  // Cookie first, and via the original helpers — the web path runs the same
  // code it always did.
  const sessionData = await getSession();
  if (sessionData) {
    const resolved = freshFactor
      ? await requireFreshMfa(MFA_STEP_UP_MAX_AGE_SECONDS, proofSource)
      : await requireCookieAuth();
    return {
      transport: "cookie",
      user: resolved.user,
      session: resolved.session,
      commitElevation: async () => {},
    };
  }

  // Bearer path. Resolution first: an unknown, revoked, expired, or narrow-scope
  // token is refused here and never gets as far as presenting an elevation.
  const auth = await requireBearerAuth();
  const bearerFreshFactor =
    freshFactor ||
    (options.freshFactorIfEnrolled === true &&
      (await hasSecondFactorEnrolled(auth.user)));
  const commitElevation = await resolveBearerElevation(
    { user: auth.user, apiTokenId: auth.apiTokenId },
    { freshFactor: bearerFreshFactor, proofSource },
  );

  return {
    transport: "bearer",
    user: auth.user,
    apiTokenId: auth.apiTokenId,
    accessTokenHash: auth.accessTokenHash,
    commitElevation,
  };
}
