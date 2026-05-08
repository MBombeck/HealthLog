import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { getWorkerStatus } from "@/lib/jobs/worker-status";

/**
 * Severity tokens map onto §2.6 status taxonomy of `docs/ui-guidelines.md`.
 * Returned as plain strings so the client renders dots + labels — not RAW
 * colours — and never leans on color alone for state.
 */
export type StatusSeverity = "good" | "info" | "caution" | "alert" | "pending";

export interface StatusOverview {
  users: {
    severity: StatusSeverity;
    total: number;
    admins: number;
    newThisWeek: number;
  };
  integrations: {
    severity: StatusSeverity;
    withings: number;
    moodLog: number;
    telegram: number;
    ntfy: number;
    webPush: number;
  };
  monitoring: {
    severity: StatusSeverity;
    glitchtipEnabled: boolean;
    umamiEnabled: boolean;
    wideEventsEnabled: boolean;
    lastErrorAt: string | null;
  };
  backups: {
    severity: StatusSeverity;
    lastBackupAt: string | null;
    backedUpUsers: number;
    retentionDays: number;
  };
  maintenance: {
    severity: StatusSeverity;
    workerRunning: boolean;
    workerUptimeSeconds: number | null;
    lastIdempotencyCleanup: string | null;
    lastAuditLogCleanup: string | null;
  };
  auditLog: {
    severity: StatusSeverity;
    eventsLast30d: number;
    lastLoginAt: string | null;
  };
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function severityForBackup(lastBackupAt: Date | null): StatusSeverity {
  if (!lastBackupAt) return "alert";
  const ageMs = Date.now() - lastBackupAt.getTime();
  if (ageMs > 14 * ONE_DAY_MS) return "alert";
  if (ageMs > 8 * ONE_DAY_MS) return "caution";
  return "good";
}

function severityForMaintenance(workerRunning: boolean): StatusSeverity {
  return workerRunning ? "good" : "alert";
}

function severityForMonitoring(
  glitchtipEnabled: boolean,
  umamiEnabled: boolean,
  recentErrorAt: Date | null,
): StatusSeverity {
  if (recentErrorAt && Date.now() - recentErrorAt.getTime() < ONE_DAY_MS) {
    return "alert";
  }
  if (glitchtipEnabled && umamiEnabled) return "good";
  if (glitchtipEnabled || umamiEnabled) return "caution";
  return "info";
}

function severityForIntegrations(totalConfigured: number): StatusSeverity {
  if (totalConfigured === 0) return "info";
  return "good";
}

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.status-overview" } });

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * ONE_DAY_MS);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * ONE_DAY_MS);

  // Single batched roundtrip — no N+1.
  const [
    userTotal,
    userAdmins,
    userNewThisWeek,
    withingsCount,
    moodLogCount,
    telegramCount,
    ntfyCount,
    webPushCount,
    appSettings,
    lastErrorEntry,
    latestBackup,
    backedUpUsers,
    last30dEvents,
    lastLoginEntry,
    lastIdempotencyCleanup,
    lastAuditLogCleanup,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { role: "ADMIN" } }),
    prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    prisma.withingsConnection.count(),
    prisma.user.count({ where: { moodLogEnabled: true } }),
    prisma.user.count({ where: { telegramEnabled: true } }),
    prisma.notificationChannel.count({
      where: { type: "NTFY", enabled: true },
    }),
    prisma.pushSubscription.count(),
    prisma.appSettings.findUnique({ where: { id: "singleton" } }),
    prisma.auditLog.findFirst({
      where: { action: { startsWith: "system.error" } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.dataBackup.findFirst({
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.dataBackup
      .findMany({ select: { userId: true }, distinct: ["userId"] })
      .then((rows) => rows.length),
    prisma.auditLog.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    prisma.auditLog.findFirst({
      where: { action: "auth.login" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.auditLog.findFirst({
      where: { action: "system.cleanup.idempotency" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.auditLog.findFirst({
      where: { action: "system.cleanup.audit-log" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  const worker = getWorkerStatus();
  const workerUptimeSeconds = worker.startedAt
    ? Math.max(
        0,
        Math.floor(
          (now.getTime() - new Date(worker.startedAt).getTime()) / 1000,
        ),
      )
    : null;

  const integrationsTotal =
    withingsCount + moodLogCount + telegramCount + ntfyCount + webPushCount;

  const overview: StatusOverview = {
    users: {
      severity: "good",
      total: userTotal,
      admins: userAdmins,
      newThisWeek: userNewThisWeek,
    },
    integrations: {
      severity: severityForIntegrations(integrationsTotal),
      withings: withingsCount,
      moodLog: moodLogCount,
      telegram: telegramCount,
      ntfy: ntfyCount,
      webPush: webPushCount,
    },
    monitoring: {
      severity: severityForMonitoring(
        Boolean(appSettings?.glitchtipEnabled),
        Boolean(appSettings?.umamiEnabled),
        lastErrorEntry?.createdAt ?? null,
      ),
      glitchtipEnabled: Boolean(appSettings?.glitchtipEnabled),
      umamiEnabled: Boolean(appSettings?.umamiEnabled),
      wideEventsEnabled: true,
      lastErrorAt: lastErrorEntry?.createdAt.toISOString() ?? null,
    },
    backups: {
      severity: severityForBackup(latestBackup?.createdAt ?? null),
      lastBackupAt: latestBackup?.createdAt.toISOString() ?? null,
      backedUpUsers,
      retentionDays: 90,
    },
    maintenance: {
      severity: severityForMaintenance(worker.running),
      workerRunning: worker.running,
      workerUptimeSeconds,
      lastIdempotencyCleanup:
        lastIdempotencyCleanup?.createdAt.toISOString() ?? null,
      lastAuditLogCleanup: lastAuditLogCleanup?.createdAt.toISOString() ?? null,
    },
    auditLog: {
      severity: "info",
      eventsLast30d: last30dEvents,
      lastLoginAt: lastLoginEntry?.createdAt.toISOString() ?? null,
    },
  };

  return apiSuccess(overview);
});
