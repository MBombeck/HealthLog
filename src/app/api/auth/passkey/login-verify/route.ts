import { verifyAuthentication } from "@/lib/auth/passkey";
import { createSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { NextRequest } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { challengeId, credential } = body;

    if (!challengeId || !credential) {
      return apiError("challengeId und credential erforderlich", 422);
    }

    const { verification, passkey } = await verifyAuthentication(
      challengeId,
      credential,
    );

    if (!verification.verified) {
      const ip = getClientIp(request);
      await auditLog("auth.login.failed", {
        ipAddress: ip,
        details: { reason: "passkey_verification_failed" },
      });
      return apiError("Passkey-Verifizierung fehlgeschlagen", 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: passkey.userId },
    });

    if (!user) {
      return apiError("Benutzer nicht gefunden", 404);
    }

    const ip = getClientIp(request);
    const ua = request.headers.get("user-agent");
    await createSession(user.id, ip, ua);

    await auditLog("auth.login.passkey", {
      userId: user.id,
      ipAddress: ip,
    });

    return apiSuccess({
      user: { id: user.id, username: user.username },
    });
  } catch (err) {
    console.error("Passkey login-verify error:", err);
    return apiError("Anmeldung fehlgeschlagen", 500);
  }
}
