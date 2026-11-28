import { envOr } from "@/lib/env";
import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { getWorkerStatus } from "@/lib/jobs/worker-status";
import {
  JOB_FAILURE_WINDOW_HOURS,
  readFailingQueues,
} from "@/lib/jobs/job-failures";
import { readGoneHolds } from "@/lib/notifications/gone-registrations";
import { readFileSync } from "node:fs";
import {
  containerMemoryLimitMb,
  heapLimitMb,
  isBelowMemoryFloor,
  isHeapLimitLow,
  MEMORY_FLOOR_MB,
} from "@/lib/support/heap-limit";
import {
  geoLookupMode,
  geoProviderChosen,
  resolveGeoProviderHost,
} from "@/lib/geo";

// Build timestamp (set at build time via next.config)
const BUILD_TIME = process.env.BUILD_TIMESTAMP || new Date().toISOString();
const START_TIME = new Date().toISOString();

// Try to read git commit info
let gitCommit = envOr("GIT_COMMIT", "unknown");
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
    // v1.4.41 — exclude soft-deleted measurements from the
    // admin status count so the dashboard tile reflects live data only.
    prisma.measurement.count({ where: { deletedAt: null } }),
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
  const workerStatus = getWorkerStatus();
  // `worker.errors` is one unnamed counter, which is how a queue that failed on
  // every run for months could sit behind a number nobody could act on. The
  // queue itself knows which job broke and why, so that is what the status
  // reports. `null` = no queue schema to ask (web-only deployment); an empty
  // array = asked, nothing is failing.
  const queueFailures = await readFailingQueues();
  // A push channel whose breaker holds deletions is listed with them: the
  // push service called too many registrations gone at once, which points at
  // this server's push configuration (`gone-registrations.ts`).
  const holds = (await readGoneHolds()).map((hold) => ({
    queue: `push-registration-cleanup:${hold.channel}`,
    failures: hold.count,
    lastFailedAt: hold.trippedAt.toISOString(),
    lastError:
      `${hold.count} registrations reported gone at once; deletions are held until ` +
      `${hold.until.toISOString()}. Check the push configuration ` +
      `(APNs topic and bundle id, Wallet Pass Type ID, key environment, VAPID keys).`,
  }));
  const failingJobs =
    queueFailures === null && holds.length === 0
      ? null
      : [...holds, ...(queueFailures ?? [])];
  // The process's heap ceiling, and whether it is the 1 GB-container size
  // that a long-used account can fill (`heap-limit.ts`).
  const heapLimit = heapLimitMb();
  // And the container's own limit against the supported floor.
  const containerLimit = containerMemoryLimitMb();

  return apiSuccess({
    version: process.env.npm_package_version || "0.1.0",
    nodeVersion: process.version,
    gitCommit,
    buildTime: BUILD_TIME,
    startTime: START_TIME,
    database: "connected",
    memory: {
      heapLimitMb: heapLimit,
      low: isHeapLimitLow(heapLimit),
      containerLimitMb: containerLimit,
      floorMb: MEMORY_FLOOR_MB,
      belowFloor: isBelowMemoryFloor(containerLimit),
    },
    worker: {
      running: workerStatus.running,
      startedAt: workerStatus.startedAt,
      lastHeartbeat: workerStatus.lastHeartbeat,
      lastReminderCheck: workerStatus.lastReminderCheck,
      lastWithingsSync: workerStatus.lastWithingsSync,
      lastInsightsRun: workerStatus.lastInsightsRun,
      jobsProcessed: workerStatus.jobsProcessed,
    },
    failingJobs:
      failingJobs === null
        ? null
        : { windowHours: JOB_FAILURE_WINDOW_HOURS, queues: failingJobs },
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
    },
    // How login IPs are placed on this host. Admin-only: the public
    // `/api/version` keeps just `offlineGeoEnabled` and `geoProviderHost`.
    geo: {
      lookup: geoLookupMode(),
      providerChosen: geoProviderChosen(),
      providerHost: resolveGeoProviderHost(),
    },
  });
});
