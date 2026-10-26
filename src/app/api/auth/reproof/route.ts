/**
 * POST /api/auth/reproof
 *
 * A browser session re-proves a credential the account holds, so that for the
 * next five minutes it may export the whole record, make a share link, mint a
 * token, or run an admin backup, restore, wipe or reset. Those routes answer
 * 401 `auth.reproof.required` with `meta.methods` when the session carries no
 * recent proof; the web opens the re-proof dialog, posts the proof here, and
 * retries. The fresh-factor routes (`requireFreshMfa`: the managed-profile
 * acts, second-factor and passkey changes, the password change, account
 * deletion, the data wipe, key rotation) answer 401 `auth.stepup.required`
 * with `meta.methods` on a browser session, and the same dialog clears them
 * here with a possession proof.
 *
 * What a proof stamps on the session row:
 *   - `totp`, `webauthn` or `passkey`: `mfaVerifiedAt` and `reproofAt`. The
 *     same stamp a completed second factor or passkey sign-in writes, from the
 *     same factor, so it also clears the fresh-factor routes, exactly as
 *     signing in again would.
 *   - `password`: `reproofAt` only. Accepted only on an account without a
 *     second factor; an account with one is told which proofs it can give
 *     instead (422 `auth.reproof.too_weak`), because a password has never
 *     stood in for the second factor.
 *
 * Cookie-only. The Bearer transport has its own proof flow (`POST
 * /api/auth/step-up`, token-bound single-use elevations), and a stamp on a
 * session row means nothing to a token.
 *
 * GET asks the same question the gated routes ask, without acting: 200 when
 * the session's proof is recent, otherwise the same 401 `auth.reproof.required`
 * with `meta.methods`. The web calls it before a large upload, so the file is
 * not sent twice around a re-proof.
 *
 * Proofs draw on the account's shared re-proof budget (five per fifteen
 * minutes, the same bucket as the step-up mint and the enrollment routes) and
 * every refusal is audited. Failures are indistinguishable on the wire.
 */
import { NextRequest } from "next/server";
import {
  apiHandler,
  assertRecentCookieProof,
  recentProofMethods,
  requireCookieAuth,
} from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import {
  REPROOF_FAILED_CODE,
  recordReproofFailure,
  refundReproof,
  throttleReproof,
  verifyExistingFactorProof,
} from "@/lib/auth/existing-factor-proof";
import { stepUpMintSchema } from "@/lib/validations/step-up";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user, session } = await requireCookieAuth();
  const ip = getClientIp(request);

  const parsed = await parseJsonBody(request, stepUpMintSchema, {
    maxBytes: 64 * 1024,
    message: "Invalid request",
  });
  if (!parsed.ok) return parsed.error;
  const proof = parsed.data;

  // Refuse a proof that could not satisfy the gate BEFORE spending a guess on
  // it: a password on an account with a second factor would verify and still
  // leave every gated action refused.
  const methods = await recentProofMethods(user);
  if (!methods.includes(proof.method)) {
    annotate({
      action: { name: "auth.reproof.method_refused" },
      meta: { method: proof.method },
    });
    return apiError("Use one of the listed ways to confirm it is you", 422, {
      errorCode: "auth.reproof.too_weak",
      methods,
    });
  }

  const limited = await throttleReproof(user.id, ip, "reproof");
  if (limited) return limited;

  const outcome = await verifyExistingFactorProof(user, proof);
  if (!outcome.ok) {
    await recordReproofFailure(
      user.id,
      ip,
      "reproof",
      proof.method,
      outcome.reason,
    );
    return apiError("Verification failed", 401, {
      errorCode: REPROOF_FAILED_CODE,
    });
  }

  await refundReproof(user.id);

  const now = new Date();
  await prisma.session.update({
    where: { id: session.id },
    data:
      proof.method === "password"
        ? { reproofAt: now }
        : { reproofAt: now, mfaVerifiedAt: now },
  });

  await auditLog("auth.reproof.succeeded", {
    userId: user.id,
    ipAddress: ip,
    details: { method: proof.method },
  });
  annotate({
    action: { name: "auth.reproof.succeeded" },
    meta: { method: proof.method },
  });

  return apiSuccess({ method: proof.method, verifiedAt: now.toISOString() });
});

export const GET = apiHandler(async () => {
  const { user, session } = await requireCookieAuth();
  await assertRecentCookieProof(user, session.id);
  return apiSuccess({ recent: true });
});
