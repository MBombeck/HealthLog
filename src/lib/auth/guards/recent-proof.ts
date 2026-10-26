import { prisma } from "@/lib/db";
import type { SessionUser } from "@/lib/auth/session-user";
import { annotate } from "@/lib/logging/context";
import {
  hasSecondFactorEnrolled,
  recentProofMethods,
} from "@/lib/auth/second-factor";
import { REPROOF_REQUIRED_CODE, StepUpRequiredError } from "@/lib/api-errors";

import { requireAuth } from "./caller";
import { resolveBearerElevation } from "./elevation";
import { MFA_STEP_UP_MAX_AGE_SECONDS } from "./fresh-factor";
import type { ErasureAuthContext } from "./fresh-mfa";

/**
 * How the recent-proof gate treats a Bearer caller.
 *
 *   `elevation` — the Bearer twin of the cookie rule: an `X-Step-Up` elevation
 *   minted by `POST /api/auth/step-up`. On an account with a second factor it
 *   must come from a second-factor proof; without one, a password-proved
 *   elevation is enough. For routes no shipped client calls on Bearer.
 *
 *   `elevation-if-enrolled` — the erasure routes' rule
 *   (`requireFreshMfaOrElevationIfEnrolled`): an account with a second factor
 *   presents a second-factor elevation, one without passes on the token. For a
 *   route the shipped app calls, where the second-factor arm was already
 *   refused before and the other arm must keep working.
 *
 *   `token` — the token is the proof, as before. Only for routes the shipped
 *   app calls without an elevation, where a refusal would sign the app out (it
 *   reads a 401 outside its known paths as a dead session). Each one is named
 *   in the iOS note and in `recent-proof-surface-guard.test.ts`, so tightening
 *   it later is a visible edit.
 */
export type RecentProofBearerRule =
  "elevation" | "elevation-if-enrolled" | "token";

/**
 * The fresh-proof gate in front of the actions that hand the record, or a
 * standing credential to it, to somebody: exporting the whole record, making a
 * clinician share link, minting a token, and the admin backup, restore, wipe
 * and reset actions. A live session is not enough for those, because whoever
 * holds a stolen session would otherwise walk off with the record or leave a
 * credential behind that outlives the session.
 *
 * Cookie session, account WITH a second factor: `Session.mfaVerifiedAt`
 * within five minutes — exactly `requireFreshMfa`. Signing in completes the
 * factor; later, `POST /api/auth/reproof` with a TOTP code, security key or
 * passkey stamps it again.
 *
 * Cookie session, account WITHOUT a second factor: any of the session's
 * creation (a sign-in), `mfaVerifiedAt` (a passkey sign-in or re-proof) or
 * `reproofAt` (a password re-proof) within five minutes. Such an account
 * re-enters its password, or uses a passkey.
 *
 * The refusal is 401 `auth.reproof.required` with `meta.methods`, the proofs
 * this account can give; the web opens the re-proof dialog on it and retries.
 * An empty list means the account holds nothing to re-prove in place (an
 * SSO-only account), and signing in again is the way through.
 *
 * Returns the caller plus `commitElevation`, which spends a Bearer elevation
 * and is a no-op otherwise. Call it right before acting.
 */
export async function requireRecentProof(options: {
  bearer: RecentProofBearerRule;
}): Promise<ErasureAuthContext> {
  const auth = await requireAuth();
  const noop = async () => {};

  if (auth.authMethod === "cookie") {
    await assertRecentCookieProof(auth.user, auth.session.id);
    return { ...auth, commitElevation: noop };
  }

  const enrolled = await hasSecondFactorEnrolled(auth.user);
  if (options.bearer === "token") {
    annotate({ meta: { recent_proof: "bearer_token" } });
    return { ...auth, commitElevation: noop };
  }
  if (options.bearer === "elevation-if-enrolled" && !enrolled) {
    annotate({ meta: { recent_proof: "bearer_token" } });
    return { ...auth, commitElevation: noop };
  }
  const commitElevation = await resolveBearerElevation(
    { user: auth.user, apiTokenId: auth.session.id },
    { freshFactor: enrolled, proofSource: "second-factor" },
  );
  return { ...auth, commitElevation };
}

/**
 * The cookie arm of {@link requireRecentProof}, for routes that resolve the
 * caller themselves (the admin routes, which must stay on `requireAdmin`).
 */
export async function assertRecentCookieProof(
  user: SessionUser,
  sessionId: string,
): Promise<void> {
  const enrolled = await hasSecondFactorEnrolled(user);
  const row = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { mfaVerifiedAt: true, createdAt: true, reproofAt: true },
  });
  const now = Date.now();
  const fresh = (d: Date | null | undefined) =>
    d != null && now - d.getTime() <= MFA_STEP_UP_MAX_AGE_SECONDS * 1000;
  const satisfied = enrolled
    ? fresh(row?.mfaVerifiedAt)
    : fresh(row?.mfaVerifiedAt) ||
      fresh(row?.createdAt) ||
      fresh(row?.reproofAt);
  if (satisfied) {
    annotate({ meta: { recent_proof: "session" } });
    return;
  }
  const methods = await recentProofMethods(user, enrolled);
  annotate({
    action: { name: "auth.reproof.required" },
    meta: { second_factor: enrolled, methods: methods.join(",") },
  });
  throw new StepUpRequiredError(
    REPROOF_REQUIRED_CODE,
    "Confirm it is you to continue",
    { methods },
  );
}
