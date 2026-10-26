import { prisma } from "@/lib/db";
import { annotate, getEvent } from "@/lib/logging/context";
import { getSession } from "@/lib/auth/session";
import {
  hasSecondFactorEnrolled,
  recentProofMethods,
} from "@/lib/auth/second-factor";
import { meterAccountWrite } from "@/lib/auth/write-meter";
import {
  AUTH_ERROR_CODES,
  HttpError,
  StepUpRequiredError,
} from "@/lib/api-errors";

import { requireAuth } from "./caller";
import type { AuthContext } from "./context";
import { resolveBearerElevation } from "./elevation";
import {
  canProveFreshFactor,
  type FreshFactorProofSource,
} from "./fresh-factor";

export type FreshMfaContext = AuthContext & { mfaVerifiedAt: Date };

/**
 * Step-up gate. Passes only for a COOKIE session whose
 * `Session.mfaVerifiedAt` is within `maxAgeSeconds` AND whose user holds a
 * credential that can produce such a stamp. Throws `StepUpRequiredError`
 * (401, `errorCode: "auth.stepup.required"`) otherwise.
 *
 * Bearer tokens can NEVER satisfy this — exactly like `requireAdmin`, the
 * resolution path is `getSession()` (cookie-only) and there is no Bearer
 * fall-through. A token transport carries no `mfaVerifiedAt` and cannot
 * acquire one, so the boundary is structural, not a softenable runtime check.
 *
 * Consumed in Phase M by MFA disable + recovery-code regeneration; later
 * waves gate account deletion, key rotation, and passphrase export on it.
 *
 * @param proofSource which credentials count as "can prove a factor". Defaults
 *   to `any-possession`, so a primary passkey counts (see the decision note
 *   below {@link FreshFactorProofSource}); `requireMfaManagementAuth` passes
 *   `second-factor` explicitly.
 */
export async function requireFreshMfa(
  maxAgeSeconds: number,
  proofSource: FreshFactorProofSource = "any-possession",
): Promise<FreshMfaContext> {
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

  // The account must hold a credential that can stamp `mfaVerifiedAt` in the
  // first place. Without one a step-up-gated action is unreachable by design
  // rather than merely refused, so the refusal is named differently
  // (`mfa_not_enrolled`) and the management UI gates enrolment ahead of it.
  if (!(await canProveFreshFactor(sessionData.user, proofSource))) {
    throw new StepUpRequiredError("auth.stepup.mfa_not_enrolled");
  }

  // Read the freshness stamp off the live session row — `getSession`'s
  // projection intentionally omits it.
  const row = await prisma.session.findUnique({
    where: { id: sessionData.session.id },
    select: { mfaVerifiedAt: true },
  });
  const verifiedAt = row?.mfaVerifiedAt ?? null;
  if (!verifiedAt || verifiedAt.getTime() < Date.now() - maxAgeSeconds * 1000) {
    // Name the proofs that clear this gate, the way the recent-proof gate
    // does, so the browser can open the re-proof dialog instead of printing a
    // sentence with nowhere to act on it. Only the possession proofs: a
    // `POST /api/auth/reproof` with one of them stamps `mfaVerifiedAt`, a
    // password stamps `reproofAt` only and would leave this gate shut.
    const methods = (await recentProofMethods(sessionData.user)).filter(
      (method) => method !== "password",
    );
    annotate({ meta: { step_up_methods: methods.join(",") } });
    throw new StepUpRequiredError(
      "auth.stepup.required",
      "Recent second-factor verification required",
      { methods },
    );
  }

  return { ...sessionData, authMethod: "cookie", mfaVerifiedAt: verifiedAt };
}

/**
 * Conditional step-up for destructive account actions.
 *
 * Resolves the caller with the standard `requireAuth()` (cookie OR Bearer).
 * For an account WITHOUT a confirmed second factor the caller passes straight
 * through — a single-factor user is intentionally unaffected, so account
 * deletion / data reset keeps its existing typed-confirmation-only contract.
 * For an account WITH MFA active (`totpConfirmedAt` set) it additionally runs
 * `requireFreshMfa`, which is cookie-only by construction: an MFA-enrolled
 * account's Bearer transport carries no `mfaVerifiedAt` and therefore cannot
 * satisfy step-up, surfacing `StepUpRequiredError` (401,
 * `errorCode: "auth.stepup.required"`) so the UI launches a re-verification.
 *
 * Gating only the MFA-enrolled cohort keeps the boundary structural: a
 * hijacked live cookie session for an MFA user cannot nuke the record without
 * a fresh factor, while users who never opted into MFA are not forced through
 * a flow they have no way to complete.
 */
export async function requireFreshMfaIfEnrolled(
  maxAgeSeconds: number,
): Promise<AuthContext> {
  const auth = await requireAuth();
  if (await hasSecondFactorEnrolled(auth.user)) {
    await requireFreshMfa(maxAgeSeconds);
  }
  return auth;
}

/**
 * What an erasure route received: the caller, plus the hook that spends a
 * Bearer elevation. See `MfaManagementContext.commitElevation` for the
 * contract — call it immediately before the mutation, after every cheap
 * refusal (a bad confirmation, the last-admin check) has passed, so a 422
 * does not burn a proof the user then has to mint again.
 */
export type ErasureAuthContext = AuthContext & {
  commitElevation: () => Promise<void>;
};

/**
 * The sibling of `requireFreshMfaIfEnrolled` for the two erasure routes —
 * account deletion and the record wipe — and only those.
 *
 * WHY IT EXISTS. App Store guideline 5.1.1(v) requires that an account created
 * in the app can be deleted from the app. `requireFreshMfaIfEnrolled` gates an
 * MFA-enrolled account on `requireFreshMfa`, which is cookie-only by
 * construction, so a native-app user with a second factor could not delete
 * their account from the app at all: the Bearer transport had no way to
 * present a fresh factor and the route answered 401 "Not authenticated" to a
 * perfectly valid token. This helper adds the Bearer arm without touching
 * `requireFreshMfa`, which stays cookie-only.
 *
 * THE THREE ARMS.
 *
 *   No second factor enrolled — pass through on either transport, exactly as
 *   the sibling does. A user who never enrolled has no ceremony to complete.
 *
 *   Cookie + enrolled — `requireFreshMfa`, unchanged: `Session.mfaVerifiedAt`
 *   within the window. A browser session cannot tell the two helpers apart.
 *
 *   Bearer + enrolled — a step-up elevation in the `X-Step-Up` header, minted
 *   by `POST /api/auth/step-up` against a re-proved factor, validated by the
 *   same code the MFA-management routes use and with `freshFactor` pinned ON:
 *   a `totp`, `webauthn`, or `passkey` proof passes; a password proof is
 *   refused with the same generic 401, because a password login has never
 *   satisfied step-up on the web and must not start here. The elevation is
 *   token-bound, single-use, and five minutes wide — the cookie window.
 *
 * WHAT IT DOES NOT DO. Scope is `requireAuth()`'s fail-closed default, so a
 * narrow token is refused 403 before the header is read. A recovery code is
 * not accepted on Bearer — the mint does not take one, and `FRESH_FACTOR_METHODS`
 * says why; an account that has lost its authenticator erases itself on the
 * web, where `/api/auth/mfa/verify` accepts the code and stamps the session.
 * And the gate takes no factor in the BODY: there is one mint surface and one
 * redemption path, which is what `step-up-elevation-guard.test.ts` freezes.
 */
export async function requireFreshMfaOrElevationIfEnrolled(
  maxAgeSeconds: number,
): Promise<ErasureAuthContext> {
  const auth = await requireAuth();
  const noop = async () => {};

  if (!(await hasSecondFactorEnrolled(auth.user))) {
    return { ...auth, commitElevation: noop };
  }

  if (auth.authMethod === "cookie") {
    await requireFreshMfa(maxAgeSeconds);
    return { ...auth, commitElevation: noop };
  }

  // On the Bearer path `requireAuth` puts the resolved `ApiToken` row id in
  // `session.id` — the binding the elevation was minted against.
  const commitElevation = await resolveBearerElevation(
    { user: auth.user, apiTokenId: auth.session.id },
    { freshFactor: true, proofSource: "second-factor" },
  );
  return { ...auth, commitElevation };
}
