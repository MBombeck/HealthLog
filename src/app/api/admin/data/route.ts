import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Admin-only global wipe of all health/integration data.
 * Keeps users/passkeys so access to the app remains possible.
 */
export async function DELETE(request: NextRequest) {
  const ip = getClientIp(request);
  const rl = checkRateLimit(`admin-data-delete:${ip}`, 5, 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { data: null, error: "Rate limit exceeded" },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  const admin = await requireAdmin();
  if (!admin) return apiError("Nicht berechtigt", 403);

  let confirm = "";
  try {
    const body = await request.json();
    confirm = typeof body?.confirm === "string" ? body.confirm : "";
  } catch {
    return apiError("Ungültige Anfrage", 422);
  }

  if (confirm !== "DELETE ALL") {
    return apiError("Bestätigung fehlt", 422);
  }

  const result = await prisma.$transaction(async (tx) => {
    const measurements = await tx.measurement.deleteMany({});
    const intakeEvents = await tx.medicationIntakeEvent.deleteMany({});
    const medications = await tx.medication.deleteMany({});
    const apiTokens = await tx.apiToken.deleteMany({});
    const withingsConnections = await tx.withingsConnection.deleteMany({});
    const auditLogs = await tx.auditLog.deleteMany({});
    const authChallenges = await tx.authChallenge.deleteMany({});

    await tx.user.updateMany({
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
      authChallenges: authChallenges.count,
    };
  });

  await auditLog("admin.data.clear", {
    userId: admin.id,
    ipAddress: getClientIp(request),
    details: result,
  });

  return apiSuccess({ cleared: true, ...result });
}
