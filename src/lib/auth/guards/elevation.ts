import { headers } from "next/headers";

import type { SessionUser } from "@/lib/auth/session-user";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  claimStepUpElevation,
  validateStepUpElevation,
  STEP_UP_ELEVATION_TTL_SECONDS,
} from "@/lib/auth/step-up";
import { StepUpRequiredError } from "@/lib/api-errors";

import {
  canProveFreshFactor,
  type FreshFactorProofSource,
} from "./fresh-factor";

/**
 * Header carrying a step-up elevation on the Bearer path. Never logged — the
 * wide event captures no request headers at all, and `redactSecrets` carries an
 * `hle_` rule as a second line of defence.
 */
export const STEP_UP_ELEVATION_HEADER = "x-step-up";

/**
 * The Bearer elevation arm, shared by `requireMfaManagementAuth` and
 * `requireFreshMfaOrElevationIfEnrolled` so there is exactly one place that
 * reads the header, validates, refuses, and claims.
 *
 * Takes an ALREADY-RESOLVED Bearer caller: the token's own validity and scope
 * were decided before this runs, and nothing here can widen that decision. It
 * returns the commit closure — the atomic single-use claim — and throws
 * `StepUpRequiredError` for a missing, unknown, foreign, spent, expired, or
 * too-weak elevation, with the real reason in the audit row and none of it on
 * the wire.
 */
export async function resolveBearerElevation(
  auth: { user: SessionUser; apiTokenId: string },
  options: { freshFactor: boolean; proofSource: FreshFactorProofSource },
): Promise<() => Promise<void>> {
  const { freshFactor, proofSource } = options;

  let raw: string | null = null;
  try {
    const headerList = await headers();
    raw = headerList.get(STEP_UP_ELEVATION_HEADER);
  } catch {
    raw = null;
  }

  if (!raw) {
    annotate({
      action: { name: "auth.stepup.elevation.missing" },
      meta: { maxAgeSeconds: STEP_UP_ELEVATION_TTL_SECONDS, freshFactor },
    });
    throw new StepUpRequiredError();
  }
  const rawToken = raw;

  const refusal = (reason: string): StepUpRequiredError => {
    // One audit row with the machine reason, one generic refusal on the wire.
    // A prober learns only "not accepted" — never whether the elevation was
    // unknown, already spent, expired, minted for a different token, or minted
    // from a factor too weak for this route.
    auditLog("auth.stepup.elevation.rejected", {
      userId: auth.user.id,
      details: { reason, freshFactor },
    }).catch(() => {});
    annotate({
      action: { name: "auth.stepup.elevation.rejected" },
      meta: { reason, freshFactor },
    });
    // Returned rather than thrown so every call site reads `throw refusal(...)`
    // and the compiler narrows the result union afterwards.
    return new StepUpRequiredError();
  };

  // Validate WITHOUT consuming. The route runs its own cheap checks next and
  // spends the elevation only when it is about to act.
  const validated = await validateStepUpElevation({
    rawToken,
    userId: auth.user.id,
    apiTokenId: auth.apiTokenId,
    requireFreshFactor: freshFactor,
  });
  if (!validated.ok) throw refusal(validated.reason);

  // Parity with the cookie path: `requireFreshMfa` refuses an account that holds
  // no credential able to produce the proof, because a step-up-gated action is
  // unreachable rather than merely refused there. The Bearer path asks the same
  // question, with the same `proofSource`, rather than becoming the softer or
  // the stricter route.
  if (freshFactor && !(await canProveFreshFactor(auth.user, proofSource))) {
    throw new StepUpRequiredError("auth.stepup.mfa_not_enrolled");
  }

  return async () => {
    const claimed = await claimStepUpElevation({
      rawToken,
      userId: auth.user.id,
      apiTokenId: auth.apiTokenId,
      requireFreshFactor: freshFactor,
    });
    if (!claimed.ok) throw refusal(claimed.reason);
    annotate({
      action: { name: "auth.stepup.elevation.accepted" },
      meta: { method: claimed.method, freshFactor },
    });
  };
}
