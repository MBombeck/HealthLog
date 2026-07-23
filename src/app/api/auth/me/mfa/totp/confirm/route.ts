/**
 * POST /api/auth/me/mfa/totp/confirm
 *
 * Finish TOTP enrollment. Verifies a code against the pending secret; on
 * success it promotes pending → active (`totpConfirmedAt = now()`), records
 * the accepted time-step (replay guard), generates + persists the Argon2id-
 * hashed recovery codes, and returns the codes **once** for the user to save.
 *
 * On the cookie path the completing session is stamped `mfaVerifiedAt = now()`
 * so the user can immediately manage the freshly-enabled factor (disable /
 * regenerate codes) without an extra step-up round-trip. A Bearer caller has no
 * session row to stamp — the stamping `updateMany` simply matches nothing — and
 * mints a fresh elevation per action instead.
 *
 * Gated by `requireMfaManagementAuth`: a cookie session, or a Bearer token
 * presenting a single-use step-up elevation. A token on its own can still never
 * enrol MFA.
 */
import {
  apiHandler,
  requireMfaManagementAuth,
  HttpError,
} from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { verifyTotp } from "@/lib/auth/mfa/totp";
import {
  generateRecoveryCodes,
  persistRecoveryCodes,
} from "@/lib/auth/mfa/recovery-codes";
import { totpConfirmSchema } from "@/lib/validations/mfa";
import { setMfaEnrollCookie } from "@/lib/auth/mfa-enrollment";

export const dynamic = "force-dynamic";

const CONFIRM_RATE_LIMIT = 10;
const CONFIRM_WINDOW_MS = 15 * 60 * 1000;

export const POST = apiHandler(async (req: Request) => {
  const auth = await requireMfaManagementAuth();
  const { user } = auth;

  const rl = await checkRateLimit(
    `mfa:confirm:${user.id}`,
    CONFIRM_RATE_LIMIT,
    CONFIRM_WINDOW_MS,
  );
  if (!rl.allowed) {
    const res = apiError("Too many requests", 429);
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      res.headers.set(k, v);
    }
    return res;
  }

  if (user.totpConfirmedAt) {
    throw new HttpError(409, "A second factor is already active");
  }
  if (!user.totpSecretEncrypted) {
    throw new HttpError(409, "Start enrollment before confirming");
  }

  const { data: body, error: jsonError } = await safeJson(req, {
    maxBytes: 4096,
  });
  if (jsonError) {
    throw new HttpError(400, "Invalid JSON body");
  }
  const parsed = totpConfirmSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid code", 422);
  }

  // Decrypt is fail-closed — a missing/rotated key throws rather than
  // confirming against junk.
  const secret = decrypt(user.totpSecretEncrypted);
  const result = verifyTotp(
    secret,
    parsed.data.code,
    user.totpLastStep === null ? null : Number(user.totpLastStep),
  );

  if (!result.valid) {
    await auditLog("auth.mfa.failed", {
      userId: user.id,
      ipAddress: getClientIp(req),
      details: { stage: "confirm", replay: result.replay },
    });
    annotate({
      action: { name: "auth.mfa.totp.confirm.invalid" },
      meta: { replay: result.replay },
    });
    throw new HttpError(401, "Invalid code");
  }

  const recoveryCodes = generateRecoveryCodes();

  // The code verified and the activation is next — spend the elevation here so
  // a wrong code above costs the caller nothing.
  await auth.commitElevation();

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        totpConfirmedAt: new Date(),
        totpLastStep: BigInt(result.step as number),
      },
    });
    // A fresh enrollment starts from a clean recovery set.
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
    await persistRecoveryCodes(tx, user.id, recoveryCodes);
    // Stamp the completing session so the user can immediately manage the
    // factor under step-up without re-verifying. Cookie transport only — a
    // Bearer caller has no session row, and mints a fresh elevation per action.
    if (auth.transport === "cookie") {
      await tx.session.updateMany({
        where: { id: auth.session.id },
        data: { mfaVerifiedAt: new Date() },
      });
    }
  });

  // v1.23 — the account now has an active second factor, so any
  // admin-enforced forced-enrollment redirect must clear immediately.
  await setMfaEnrollCookie(false);

  await auditLog("auth.mfa.enabled", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: { factor: "totp" },
  });
  annotate({ action: { name: "auth.mfa.enabled" } });

  // `recoveryCodes` is redaction-denylisted (`/recovery.?code/i`).
  return apiSuccess({
    enabled: true,
    recoveryCodes,
    recoveryCodesRemaining: recoveryCodes.length,
  });
});
