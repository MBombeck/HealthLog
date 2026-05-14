import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { getWorkerStatus } from "@/lib/jobs/worker-status";
import { getLegacyFormTotal } from "@/app/api/withings/webhook/route";
import { readFileSync } from "node:fs";

// Build timestamp (set at build time via next.config)
const BUILD_TIME = process.env.BUILD_TIMESTAMP || new Date().toISOString();
const START_TIME = new Date().toISOString();

// Try to read git commit info
let gitCommit = process.env.GIT_COMMIT ?? "unknown";
try {
  const head = readFileSync(".git/HEAD", "utf-8").trim();
  if (head.startsWith("ref:")) {
    const ref = head.replace("ref: ", "");
    gitCommit = readFileSync(`.git/${ref}`, "utf-8").trim().slice(0, 8);
  } else {
    gitCommit = head.slice(0, 8);
  }
} catch {
  // In Docker or production, .git may not exist
}

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.status" } });

  const [
    userCount,
    measurementCount,
    medicationCount,
    intakeEventCount,
    tokenCount,
    sessionCount,
    appSettings,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.measurement.count(),
    prisma.medication.count(),
    prisma.medicationIntakeEvent.count(),
    prisma.apiToken.count({ where: { revoked: false } }),
    prisma.session.count(),
    prisma.appSettings.findUnique({ where: { id: "singleton" } }),
  ]);

  const umamiConfigured = Boolean(
    appSettings?.umamiScriptUrl && appSettings?.umamiWebsiteId,
  );
  const glitchtipConfigured = Boolean(appSettings?.glitchtipDsn);
  const webPushConfigured = Boolean(
    appSettings?.webPushVapidPublicKey &&
    appSettings?.webPushVapidPrivateKeyEncrypted &&
    appSettings?.webPushVapidSubject,
  );
  const bugReportConfigured = Boolean(
    appSettings?.githubIssueRepo && appSettings?.githubIssueTokenEncrypted,
  );

  const workerStatus = getWorkerStatus();

  return apiSuccess({
    version: process.env.npm_package_version ?? "0.1.0",
    nodeVersion: process.version,
    gitCommit,
    buildTime: BUILD_TIME,
    startTime: START_TIME,
    database: "connected",
    worker: workerStatus,
    counts: {
      users: userCount,
      measurements: measurementCount,
      medications: medicationCount,
      intakeEvents: intakeEventCount,
      activeTokens: tokenCount,
      activeSessions: sessionCount,
    },
    integrations: {
      umami: umamiConfigured
        ? { configured: true, enabled: appSettings?.umamiEnabled ?? false }
        : null,
      glitchtip: glitchtipConfigured
        ? {
            configured: true,
            enabled: appSettings?.glitchtipEnabled ?? false,
          }
        : null,
      webPush: webPushConfigured ? { configured: true } : null,
      bugReport: bugReportConfigured ? { configured: true } : null,
    },
    // v1.4.25 W21 Fix-K — in-memory counters that the release-gate can
    // read to confirm "legacy form usage trending toward zero" before
    // the v1.4.27 cut of the legacy Withings webhook route.
    counters: {
      withingsWebhookLegacyFormTotal: getLegacyFormTotal(),
    },
  });
});
