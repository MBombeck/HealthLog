import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Delete all user-owned health/integration data while keeping the account.
 */
export async function DELETE(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  let confirm = "";
  try {
    const body = await request.json();
    confirm = typeof body?.confirm === "string" ? body.confirm : "";
  } catch {
    return apiError("Ungültige Anfrage", 422);
  }

  if (confirm !== "DELETE") {
    return apiError("Bestätigung fehlt", 422);
  }

  const userId = sessionData.user.id;

  const result = await prisma.$transaction(async (tx) => {
    const measurements = await tx.measurement.deleteMany({
      where: { userId },
    });
    const intakeEvents = await tx.medicationIntakeEvent.deleteMany({
      where: { userId },
    });
    const medications = await tx.medication.deleteMany({
      where: { userId },
    });
    const apiTokens = await tx.apiToken.deleteMany({
      where: { userId },
    });
    const withingsConnections = await tx.withingsConnection.deleteMany({
      where: { userId },
    });
    const auditLogs = await tx.auditLog.deleteMany({
      where: { userId },
    });

    await tx.user.update({
      where: { id: userId },
      data: {
        heightCm: null,
        dateOfBirth: null,
        gender: null,
        openaiKeyEncrypted: null,
        insightsPrivacyMode: "aggregated",
        insightsCachedAt: null,
        insightsCachedText: null,
        telegramBotToken: null,
        telegramChatId: null,
        telegramEnabled: false,
        withingsClientIdEncrypted: null,
        withingsClientSecretEncrypted: null,
        onboardingCompletedAt: null,
      },
    });

    return {
      measurements: measurements.count,
      intakeEvents: intakeEvents.count,
      medications: medications.count,
      apiTokens: apiTokens.count,
      withingsConnections: withingsConnections.count,
      auditLogs: auditLogs.count,
    };
  });

  await auditLog("user.data.clear", {
    userId,
    ipAddress: getClientIp(request),
    details: result,
  });

  return apiSuccess({ cleared: true, ...result });
}
