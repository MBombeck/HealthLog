/**
 * pg-boss based reminder worker — boot composition.
 *
 * v1.18.1 — this file was a 2143-LOC monolith that declared every pg-boss
 * queue name, listed them in one `allQueues` array, scheduled every cron, and
 * bound every `boss.work` handler inline. It is now a thin registration table:
 * `startReminderWorker()` boots pg-boss, runs the boot one-shots, then calls
 * the domain registrars under `src/lib/jobs/reminder/`. Each registrar owns the
 * four facts the v1.4.37 dead-queue guards pin — the queue-name constant, its
 * `allQueues` membership, its `[QUEUE, CRON]` schedule tuple, and its
 * `createAndWork(boss, QUEUE, …, handler)` binding — so a queue can never be
 * declared without being provisioned, scheduled, and drained.
 *
 * Usage: Run as a standalone process or call startReminderWorker() from a
 * custom server setup. In dev, use: npx tsx src/lib/jobs/reminder-worker.ts
 */
import { markWorkerStarted, recordError } from "@/lib/jobs/worker-status";
import { createWorkerBoss, setGlobalBoss } from "@/lib/jobs/boss-instance";
import { reportJobsCutOffAtBoot } from "@/lib/jobs/job-observer";
import { assertSubsystemEnabled } from "@/lib/process-type";
import { DATABASE_URL, workerLog } from "./reminder/shared";
import {
  registerShutdownHandlers,
  reconcileImportJobsAtBoot,
  probeIntegrationStatusAtBoot,
} from "./reminder/worker-lifecycle";
import {
  registerIntegrationSyncQueues,
  enqueueIntegrationSyncBootDiscovery,
} from "./reminder/register-integration-sync";
import { registerStatusQueues } from "./reminder/register-status";
import {
  registerRollupQueues,
  enqueueRollupBootDiscovery,
} from "./reminder/register-rollup";
import { registerReminderQueues } from "./reminder/register-reminders";
import {
  registerMaintenanceQueues,
  enqueueMaintenanceBootDiscovery,
} from "./reminder/register-maintenance";

export async function startReminderWorker() {
  // v1.4 G3: refuse to boot if the operator marked this container as
  // web-only via HEALTHLOG_PROCESS_TYPE.
  assertSubsystemEnabled("worker");

  if (!DATABASE_URL) {
    workerLog("error", "CRITICAL: DATABASE_URL is not set, refusing to start");
    return;
  }

  const boss = createWorkerBoss(DATABASE_URL);

  boss.on("error", (error: unknown) => {
    workerLog("error", "boss emitted error", error);
    recordError();
  });

  // Read before any `boss.work` binding below can take a job: whatever is
  // still active now was started by a process that is gone.
  const bootedAt = new Date();
  await boss.start();
  await reportJobsCutOffAtBoot(bootedAt);
  setGlobalBoss(boss);
  markWorkerStarted();

  // Graceful shutdown: drain in-flight jobs on SIGTERM/SIGINT.
  registerShutdownHandlers(boss);

  // Register every domain's queues (createQueue + schedule + boss.work). Each
  // registrar returns the queue names it provisioned; the aggregate is the
  // boot-level mirror of the per-registrar `allQueues` arrays the dead-queue
  // guards pin. Order preserves the monolith's createQueue / schedule / work
  // sequence (integration → status → rollup → reminders → maintenance).
  const registeredQueues = [
    ...(await registerIntegrationSyncQueues(boss)),
    ...(await registerStatusQueues(boss)),
    ...(await registerRollupQueues(boss)),
    ...(await registerReminderQueues(boss)),
    ...(await registerMaintenanceQueues(boss)),
  ];
  workerLog(
    "info",
    `[reminder-worker] registered ${registeredQueues.length} queues across 5 domain registrars`,
  );

  // v1.4.34 — reconcile any `ImportJob` rows that were mid-parse when the
  // worker last shut down, flipping orphaned rows to `failed`.
  await reconcileImportJobsAtBoot();

  // v1.4.48 M1 — boot probe for legacy `integration_statuses` rows that still
  // carry `consecutive_failures_by_kind = NULL`.
  await probeIntegrationStatusAtBoot();

  // Fire-and-forget boot discovery for every self-converging backfill /
  // consolidation pass. Each is idempotent across reboots and never fails
  // worker boot on a miss (errors come back through the helper's result).
  await enqueueRollupBootDiscovery();
  await enqueueIntegrationSyncBootDiscovery();
  await enqueueMaintenanceBootDiscovery();

  return boss;
}

// Run standalone
if (
  process.argv[1]?.endsWith("reminder-worker.ts") ||
  process.argv[1]?.endsWith("reminder-worker.js")
) {
  startReminderWorker().catch((err) => {
    workerLog("error", "Failed to start reminder worker", err);
    process.exit(1);
  });
}
