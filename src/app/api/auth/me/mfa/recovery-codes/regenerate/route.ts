/**
 * POST /api/auth/me/mfa/recovery-codes/regenerate
 *
 * Issue a fresh recovery-code batch, invalidating the entire prior set in one
 * transaction. Step-up gated (`requireMfaManagementAuth({ freshFactor: true })`)
 * — a recovery-code rotation is sensitive, so it takes either a freshly
 * second-factor-verified cookie session or a single-use step-up elevation minted
 * by the calling token. The new codes are returned **once**.
 */
import {
  apiHandler,
  requireMfaManagementAuth,
  HttpError,
} from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { regenerateRecoveryCodes } from "@/lib/auth/mfa/recovery-codes";

export const dynamic = "force-dynamic";

const REGEN_RATE_LIMIT = 5;
const REGEN_WINDOW_MS = 15 * 60 * 1000;

export const POST = apiHandler(async (req: Request) => {
  const auth = await requireMfaManagementAuth({ freshFactor: true });
  const { user } = auth;

  // Defence in depth — regeneration only makes sense for an active factor.
  if (!user.totpConfirmedAt) {
    throw new HttpError(409, "No second factor is active");
  }

  const rl = await checkRateLimit(
    `mfa:recovery-regen:${user.id}`,
    REGEN_RATE_LIMIT,
    REGEN_WINDOW_MS,
  );
  if (!rl.allowed) {
    const res = apiError("Too many requests", 429);
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      res.headers.set(k, v);
    }
    return res;
  }

  await auth.commitElevation();

  const recoveryCodes = await regenerateRecoveryCodes(user.id);

  await auditLog("auth.mfa.recovery_regenerated", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: { count: recoveryCodes.length },
  });
  annotate({ action: { name: "auth.mfa.recovery_regenerated" } });

  return apiSuccess({
    recoveryCodes,
    recoveryCodesRemaining: recoveryCodes.length,
  });
});
