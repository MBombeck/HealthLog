import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

/**
 * Delete all user-owned health/integration data while keeping the account.
 */
export const DELETE = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  let confirm = "";
  try {
    const body = await request.json();
    confirm = typeof body?.confirm === "string" ? body.confirm : "";
  } catch {
    return apiError("Invalid request", 422);
  }

  if (confirm !== "DELETE") {
    return apiError("Confirmation missing", 422);
  }

  const userId = user.id;

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
    const moodEntries = await tx.moodEntry.deleteMany({
      where: { userId },
    });
    // v1.4.39 W-MOOD — wipe the persisted rollup partition for this
    // user so the next analytics read returns an empty envelope.
    await tx.moodEntryRollup.deleteMany({ where: { userId } });
    const apiTokens = await tx.apiToken.deleteMany({
      where: { userId },
    });
    const withingsConnections = await tx.withingsConnection.deleteMany({
      where: { userId },
    });
    const notificationChannels = await tx.notificationChannel.deleteMany({
      where: { userId },
    });
    const pushSubscriptions = await tx.pushSubscription.deleteMany({
      where: { userId },
    });
    const dataBackups = await tx.dataBackup.deleteMany({
      where: { userId },
    });
    const achievements = await tx.userAchievement.deleteMany({
      where: { userId },
    });
    const telegramDeletions = await tx.telegramScheduledDeletion.deleteMany({
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
        insightsPrivacyMode: "aggregated",
        insightsCachedAt: null,
        insightsCachedText: null,
        telegramBotToken: null,
        telegramChatId: null,
        telegramEnabled: false,
        withingsClientIdEncrypted: null,
        withingsClientSecretEncrypted: null,
        moodLogUrlEncrypted: null,
        moodLogApiKeyEncrypted: null,
        moodLogEnabled: false,
        moodLogLastSyncedAt: null,
        moodLogWebhookSecret: null,
        onboardingCompletedAt: null,
      },
    });

    return {
      measurements: measurements.count,
      intakeEvents: intakeEvents.count,
      medications: medications.count,
      moodEntries: moodEntries.count,
      apiTokens: apiTokens.count,
      withingsConnections: withingsConnections.count,
      notificationChannels: notificationChannels.count,
      pushSubscriptions: pushSubscriptions.count,
      dataBackups: dataBackups.count,
      achievements: achievements.count,
      telegramDeletions: telegramDeletions.count,
      auditLogs: auditLogs.count,
    };
  });

  await auditLog("user.data.clear", {
    userId,
    ipAddress: getClientIp(request),
    details: result,
  });

  annotate({ action: { name: "settings.data.clear" }, meta: result });

  return apiSuccess({ cleared: true, ...result });
});
