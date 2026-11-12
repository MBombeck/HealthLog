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
 * A token on its own can still never enrol MFA.
 *
 * A cookie session on its own cannot either. Enrolling hands the caller a
 * factor that later satisfies every step-up gate, so a stolen session must not
 * be able to mint one: the cookie arm also passes `checkCookieEnrollmentProof`
 * — a sign-in or second factor inside the last five minutes, or a password /
 * factor proof in the body (the step-up mint's shapes); on an account that
 * already has a second factor, only that factor or a passkey. The Bearer arm
 * carries the proof in its elevation, under the same rule: on an account with
 * a second factor the elevation must come from one. The recovery-code batch is
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
import { checkCookieEnrollmentProof } from "@/lib/auth/existing-factor-proof";

const TOTP_ALREADY_ACTIVE_CODE = "auth.mfa.already_active";

export const dynamic = "force-dynamic";

const SETUP_RATE_LIMIT = 5;
const SETUP_WINDOW_MS = 15 * 60 * 1000;

export const POST = apiHandler(async (req: Request) => {
  const auth = await requireMfaManagementAuth({ freshFactorIfEnrolled: true });
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
    throw new HttpError(
      409,
      "A second factor is already active",
      TOTP_ALREADY_ACTIVE_CODE,
    );
  }

  if (auth.transport === "cookie") {
    const refusal = await checkCookieEnrollmentProof({
      user,
      sessionId: auth.session.id,
      request: req,
      ipAddress: getClientIp(req),
      stage: "totp_enroll",
    });
    if (refusal) return refusal;
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
