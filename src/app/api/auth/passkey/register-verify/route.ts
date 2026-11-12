import { prisma } from "@/lib/db";
import {
  consumeRegistrationChallenge,
  verifyRegistration,
} from "@/lib/auth/passkey";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { NextRequest } from "next/server";
import { apiHandler, requireCookieAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { REPROOF_FAILED_CODE } from "@/lib/auth/existing-factor-proof";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user, session } = await requireCookieAuth();

  const { data: body, error: jsonError } = await safeJson<
    Record<string, unknown>
  >(request, { maxBytes: 64 * 1024 });

  if (jsonError) return jsonError;
  const challengeId = body.challengeId as string | undefined;
  const credential = body.credential as Record<string, unknown> | undefined;

  if (!challengeId || !credential) {
    return apiError("challengeId and credential required", 422);
  }

  // Read the live session row so a stale fresh-factor stamp cannot be carried
  // through a registration ceremony after it has been downgraded/revoked.
  const freshSession = await prisma.session.findUnique({
    where: { id: session.id },
    select: { mfaVerifiedAt: true },
  });
  if (
    !freshSession ||
    (freshSession.mfaVerifiedAt &&
      freshSession.mfaVerifiedAt.getTime() < Date.now() - 5 * 60 * 1000)
  ) {
    return apiError("Fresh reauthentication proof required", 401, {
      errorCode: REPROOF_FAILED_CODE,
    });
  }

  const claim = await consumeRegistrationChallenge({
    challengeId,
    userId: user.id,
    sessionId: session.id,
  });
  if (!claim.ok) {
    return claim.reason === "wrong_context"
      ? apiError("Fresh reauthentication proof required", 401, {
          errorCode: REPROOF_FAILED_CODE,
        })
      : apiError("Registration challenge invalid or expired", 400);
  }

  let verification;
  try {
    verification = await verifyRegistration(
      claim.expectedChallenge,
      credential,
    );
  } catch {
    return apiError("Passkey verification failed", 400);
  }

  if (!verification.verified || !verification.registrationInfo) {
    return apiError("Passkey verification failed", 400);
  }

  const { registrationInfo } = verification;

  await prisma.passkey.create({
    data: {
      userId: user.id,
      credentialId: registrationInfo.credential.id,
      credentialPublicKey: Buffer.from(registrationInfo.credential.publicKey),
      counter: BigInt(registrationInfo.credential.counter),
      credentialDeviceType: registrationInfo.credentialDeviceType,
      credentialBackedUp: registrationInfo.credentialBackedUp,
      transports:
        ((credential.response as Record<string, unknown> | undefined)
          ?.transports as string[]) ?? [],
    },
  });

  await auditLog("auth.passkey.register", {
    userId: user.id,
    ipAddress: getClientIp(request),
  });

  annotate({ action: { name: "auth.passkey.register" } });

  return apiSuccess({ verified: true });
});
