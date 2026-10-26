/**
 * pg-boss worker boot.
 *
 * `startReminderWorker()` starts pg-boss, registers every queue from the
 * declarative registry (`./registry/`), runs the boot one-shots and the boot
 * discovery. The registry declares each queue with its schedule, policy,
 * concurrency and handler loader; a queue cannot be declared without being
 * created, scheduled and drained. Handler modules load on their queue's first
 * job, not at boot.
 *
 * Usage: Run as a standalone process or call startReminderWorker() from a
 * custom server setup. In dev, use: npx tsx src/lib/jobs/reminder-worker.ts
 */
import { markWorkerStarted, recordError } from "@/lib/jobs/worker-status";
import { createWorkerBoss, setGlobalBoss } from "@/lib/jobs/boss-instance";
import { reportJobsCutOffAtBoot } from "@/lib/jobs/job-observer";
import { beginBootStep, reportBootSteps } from "@/lib/boot/boot-steps";
import { assertSubsystemEnabled } from "@/lib/process-type";
import { DATABASE_URL, workerLog } from "./reminder/shared";
import type { BoundLoader } from "./registry/index";

/**
 * Give the event loop a turn around a module load, so requests and the
 * health probe are answered between boot steps.
 */
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Import one boot module as its own boot step. */
async function loadBootModule<T>(
  name: string,
  load: () => Promise<T>,
): Promise<T> {
  beginBootStep(`load_${name}`);
  await yieldToLoop();
  const mod = await load();
  await yieldToLoop();
  return mod;
}

export async function startReminderWorker() {
  // v1.4: refuse to boot if the operator marked this container as
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
  beginBootStep("boss_start");
  const bootedAt = new Date();
  await boss.start();
  await reportJobsCutOffAtBoot(bootedAt);
  setGlobalBoss(boss);
  markWorkerStarted();

  // Graceful shutdown: drain in-flight jobs on SIGTERM/SIGINT.
  const lifecycle = await loadBootModule(
    "worker_lifecycle",
    () => import("./reminder/worker-lifecycle"),
  );
  lifecycle.registerShutdownHandlers(boss);

  // Register every queue (createQueue + schedule + boss.work) from the
  // declarative registry, one group per boot step. The registry holds
  // declarations only; each handler module loads on its queue's first job.
  const registry = await loadBootModule(
    "registry",
    () => import("./registry/index"),
  );
  const bound: BoundLoader[] = [];
  const registeredQueues = await registry.registerAllJobGroups(
    boss,
    (group) => beginBootStep(`register_${group.name}`),
    (loader) => bound.push(loader),
  );
  workerLog(
    "info",
    `[reminder-worker] registered ${registeredQueues.length} queues across ${registry.JOB_GROUPS.length} groups`,
  );

  // v1.4.34 — reconcile any `ImportJob` rows that were mid-parse when the
  // worker last shut down, flipping orphaned rows to `failed`.
  beginBootStep("boot_reconcile");
  await lifecycle.reconcileImportJobsAtBoot();

  // v1.4.48 — boot probe for legacy `integration_statuses` rows that still
  // carry `consecutive_failures_by_kind = NULL`.
  await lifecycle.probeIntegrationStatusAtBoot();

  // Fire-and-forget boot discovery for every self-converging backfill /
  // consolidation pass. Each is idempotent across reboots and never fails
  // worker boot on a miss.
  beginBootStep("boot_discovery");
  await registry.runAllBootDiscovery();

  await reportBootSteps({ boot_queue_count: registeredQueues.length });

  // Every handler module is loaded once now, in the background, so one that
  // cannot load is reported at deploy time rather than on its queue's first
  // job. Not awaited: readiness does not wait on it, and it never throws.
  void registry.preloadHandlers(bound);
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
