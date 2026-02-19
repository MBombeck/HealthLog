import { prisma } from "@/lib/db";
import { verifyRegistration } from "@/lib/auth/passkey";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { NextRequest } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const sessionData = await getSession();
    if (!sessionData) {
      return apiError("Nicht angemeldet", 401);
    }

    const body = await request.json();
    const { challengeId, credential } = body;

    if (!challengeId || !credential) {
      return apiError("challengeId und credential erforderlich", 422);
    }

    const verification = await verifyRegistration(challengeId, credential);

    if (!verification.verified || !verification.registrationInfo) {
      return apiError("Passkey-Verifizierung fehlgeschlagen", 400);
    }

    const { registrationInfo } = verification;

    await prisma.passkey.create({
      data: {
        userId: sessionData.user.id,
        credentialId: registrationInfo.credential.id,
        credentialPublicKey: Buffer.from(registrationInfo.credential.publicKey),
        counter: BigInt(registrationInfo.credential.counter),
        credentialDeviceType: registrationInfo.credentialDeviceType,
        credentialBackedUp: registrationInfo.credentialBackedUp,
        transports: (credential.response?.transports as string[]) ?? [],
      },
    });

    await auditLog("auth.passkey.register", {
      userId: sessionData.user.id,
      ipAddress: getClientIp(request),
    });

    return apiSuccess({ verified: true });
  } catch (err) {
    console.error("Passkey register-verify error:", err);
    return apiError("Passkey-Registrierung fehlgeschlagen", 500);
  }
}
