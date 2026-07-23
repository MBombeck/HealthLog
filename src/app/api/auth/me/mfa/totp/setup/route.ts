/**
 * POST /api/auth/me/mfa/totp/setup
 *
 * Begin TOTP enrollment. Generates a 160-bit secret, stores it **encrypted**
 * (AES-256-GCM, the same at-rest envelope as every other credential), and
 * returns the `otpauth://` URI + the raw Base32 secret so the client can
 * render the QR and offer manual entry. The secret is **pending** — MFA is
 * not active until `/confirm` verifies a code, so `totpConfirmedAt` stays
 * null here.
 *
 * Gated by `requireMfaManagementAuth`: a cookie session, or a Bearer token
 * presenting a single-use step-up elevation minted against a re-proved factor.
 * A token on its own can still never enrol MFA. The recovery-code batch is
 * issued at `/confirm` (after the factor is proven), not here, so an abandoned
 * setup never persists codes.
 */
import {
  apiHandler,
  requireMfaManagementAuth,
  HttpError,
} from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { generateTotpSecret, buildOtpauthUri } from "@/lib/auth/mfa/totp";

export const dynamic = "force-dynamic";

const SETUP_RATE_LIMIT = 5;
const SETUP_WINDOW_MS = 15 * 60 * 1000;

export const POST = apiHandler(async (req: Request) => {
  const auth = await requireMfaManagementAuth();
  const { user } = auth;

  const rl = await checkRateLimit(
    `mfa:setup:${user.id}`,
    SETUP_RATE_LIMIT,
    SETUP_WINDOW_MS,
  );
  if (!rl.allowed) {
    const res = apiError("Too many requests", 429);
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      res.headers.set(k, v);
    }
    return res;
  }

  // An already-active factor must be disabled (step-up gated) before a new
  // secret can be enrolled — re-running setup must not silently rotate the
  // live secret out from under the user's authenticator.
  if (user.totpConfirmedAt) {
    annotate({ action: { name: "auth.mfa.totp.setup.already_active" } });
    throw new HttpError(409, "A second factor is already active");
  }

  // Rate limit and the already-active check have passed; the write is next.
  await auth.commitElevation();

  const secret = generateTotpSecret();
  const account = user.email ?? user.username;
  const otpauthUri = buildOtpauthUri(secret, account);

  // Store the pending secret encrypted; leave `totpConfirmedAt` null.
  await prisma.user.update({
    where: { id: user.id },
    data: {
      totpSecretEncrypted: encrypt(secret),
      // A re-setup resets the replay counter — the new secret starts fresh.
      totpLastStep: null,
    },
  });

  await auditLog("auth.mfa.totp.setup", {
    userId: user.id,
    ipAddress: getClientIp(req),
  });
  annotate({ action: { name: "auth.mfa.totp.setup" } });

  // `totpSecret` / `otpauthUri` are redaction-denylisted (`/totp/i`,
  // `/otp/i`, `/secret/i`) so they never surface in a wide-event excerpt.
  return apiSuccess({ otpauthUri, totpSecret: secret });
});
