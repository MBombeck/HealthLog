/**
 * POST /api/auth/me/mfa/webauthn/register/verify
 *
 * Finish registering a WebAuthn security key as a second factor. Takes a cookie
 * session or a Bearer token presenting a single-use step-up elevation. Verifies
 * the attestation against the user-bound challenge and stores the credential in
 * `WebauthnMfaCredential` (kept separate from primary passkeys).
 */
import { NextRequest } from "next/server";
import { apiHandler, requireMfaManagementAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { verifyMfaRegistration } from "@/lib/auth/mfa/webauthn";
import { mfaWebauthnRegisterVerifySchema } from "@/lib/validations/mfa";
import { setMfaEnrollCookie } from "@/lib/auth/mfa-enrollment";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const auth = await requireMfaManagementAuth();
  const { user } = auth;

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = mfaWebauthnRegisterVerifySchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid request", 422);
  }
  const { challengeId, credential, name } = parsed.data;

  const verification = await verifyMfaRegistration(
    challengeId,
    user.id,
    credential,
  );
  if (!verification.verified || !verification.registrationInfo) {
    return apiError("Security key verification failed", 400);
  }

  // The attestation verified and the credential is about to be stored — a
  // failed ceremony above must not have cost the caller their elevation.
  await auth.commitElevation();

  const { registrationInfo } = verification;
  const created = await prisma.webauthnMfaCredential.create({
    data: {
      userId: user.id,
      name: name ?? "Security key",
      credentialId: registrationInfo.credential.id,
      credentialPublicKey: Buffer.from(registrationInfo.credential.publicKey),
      counter: BigInt(registrationInfo.credential.counter),
      transports:
        ((credential.response as Record<string, unknown> | undefined)
          ?.transports as string[]) ?? [],
    },
    select: { id: true, name: true, createdAt: true, lastUsedAt: true },
  });

  // v1.23 — a registered security key satisfies an admin-enforced MFA policy,
  // so clear any forced-enrollment redirect immediately.
  await setMfaEnrollCookie(false);

  await auditLog("auth.mfa.webauthn.register", {
    userId: user.id,
    ipAddress: getClientIp(request),
  });
  annotate({ action: { name: "auth.mfa.webauthn.register" } });

  return apiSuccess(created);
});
