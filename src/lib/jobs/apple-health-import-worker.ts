/**
 * v1.4.34 — pg-boss handler for the revision-2 Apple Health import queue.
 *
 * The kick-off endpoint (`POST /api/import/apple-health-export`,
 * `POST /api/admin/import-apple-health-export`) writes the upload to
 * `/tmp`, creates an `ImportJob` row in `queued`, and sends the
 * payload below to this queue. The handler:
 *
 *   1. Resolves the mirror `ImportJob` row by `pgBossJobId`.
 *   2. Extracts `export.xml` from the upload's ZIP archive.
 *   3. Streams the XML through `streamParseExportXml()`, which
 *      UPSERTs `Measurement` and `Workout` rows while feeding a
 *      live progress snapshot back onto the `ImportJob` row.
 *   4. Marks the row `done` with the terminal `ImportJobResult`
 *      envelope on success, or `failed` with a reason string on
 *      throw.
 *   5. Cleans up the upload + extracted XML so `/tmp` does not
 *      accumulate gigabyte tails on the worker host.
 *
 * Concurrency: 1 per host. The parse loop is CPU-bound and a
 * concurrent second import would race the first for RSS; the
 * pg-boss `boss.work` registration in `reminder-worker.ts` caps
 * `localConcurrency: 1`.
 *
 * Locks per `.planning/research/v1434-r-1-xml-import.md` §5.1.
 */
import { unlinkSync } from "node:fs";
import { getHeapStatistics } from "node:v8";
import type { PrismaClient } from "@/generated/prisma/client";
import { prisma, toJson } from "@/lib/db";
import type { Job } from "pg-boss";

import { streamAppleHealthEcgMembers } from "@/lib/apple-health/archive-stream";
import { parseAppleHealthEcgCsv } from "@/lib/apple-health/ecg-csv";
import { importAppleHealthEcg } from "@/lib/apple-health/ecg-import";
import { extractExportXml } from "@/lib/import/unzip-export-xml";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import {
  streamParseExportXml,
  type ImportJobProgress,
  type ImportJobResult,
} from "@/lib/measurements/import-apple-health-export";
import {
  recomputeUserRollups,
  ROLLUP_FOLD_WINDOW_MS,
} from "@/lib/rollups/measurement-rollups";
import { withBackgroundEvent } from "@/lib/logging/background";

/**
 * Queue + cron for the periodic orphan-ImportJob sweep. v1.32.1
 * (issue #588) — `reconcileOrphanImportJobs()` used to run only once,
 * at worker boot. `restart: unless-stopped` in `docker-compose.yml`
 * DOES bring a crashed/OOM-killed worker back up, so the boot-time
 * pass usually catches a dead run — but only when that restart lands
 * AFTER the row's heartbeat has already gone stale (30 minutes) or
 * pg-boss no longer reports the backing job as live. A fast restart
 * lands neither condition true yet, and because the pass runs
 * exactly once per boot, a worker that then stays up and healthy
 * NEVER re-evaluates that row — it is stuck in `unpacking` /
 * `parsing` / `upserting` with "0 rows imported" forever and no
 * failure ever surfaced to the status poll. A 15-minute cron closes
 * that gap: within two ticks of the heartbeat going stale, the same
 * idempotent reconcile flips the row to `failed` with an honest
 * reason, so the UI's "Unpacking the archive…" spinner eventually
 * turns into a visible, actionable error instead of an indefinite
 * silent stall.
 */
export const IMPORT_JOB_RECONCILE_QUEUE = "apple-health-import-reconcile";
export const IMPORT_JOB_RECONCILE_CRON = "*/15 * * * *";

/**
 * Cron handler for the periodic orphan-ImportJob sweep. Delegates to
 * the same `reconcileOrphanImportJobs()` the boot path calls — the
 * heartbeat + live pg-boss-job check already make it safe to re-run
 * on a healthy worker (a live import's fresh heartbeat and `active`
 * pg-boss state both keep its row untouched). A sweep that throws now
 * reports a failed outcome instead of only leaving a warning behind:
 * this pass exists to end a silent stall, and a stall in the pass
 * itself was the one condition nothing surfaced. The next tick is 15
 * minutes away regardless, so nothing rests on the retry.
 */
export async function handleImportJobReconcileTick(
  jobs: Job<object>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent(
    "job.apple_health_import_reconcile",
    async (evt) => {
      try {
        await reconcileOrphanImportJobs();
      } catch (err) {
        evt.addWarning(`apple-health-import-reconcile failed: ${err}`);
        return jobFailed("apple health import reconcile failed", err);
      }
      return jobDone();
    },
  );
}

/** Queue name isolated from revision-1 workers during rolling deployments. */
export const APPLE_HEALTH_IMPORT_V2_QUEUE = "apple-health-import-v2";

/** Queue used by pre-revision-2 binaries; new workers only bridge its backlog. */
export const APPLE_HEALTH_IMPORT_LEGACY_QUEUE = "apple-health-import";

/** Parser semantics carried by every newly-created ImportJob. */
export const APPLE_HEALTH_IMPORT_PARSER_REVISION = 3;

const APPLE_HEALTH_ECG_ARCHIVE_LIMITS = {
  maxMembers: 20_000,
  maxEcgMembers: 2_000,
  maxMemberBytes: 16 * 1024 * 1024,
  maxTotalEcgBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
} as const;
const APPLE_HEALTH_ECG_MAX_SAMPLES = 2_000_000;

/** Concurrency cap per worker host. */
export const APPLE_HEALTH_IMPORT_CONCURRENCY = 1;

/**
 * (issue #775) Memory preflight for the parse. The streaming pipeline
 * keeps per-record work off the heap, so what remains resident scales
 * with data SPAN (cumulative day-buckets, per-type counters, batch
 * buffers), not record count — a small fraction of the XML size. The
 * model below is deliberately generous: a fixed base for parser +
 * batches + framework, plus 1/64 of the declared XML size for the
 * span-bounded fold state. An 8 GiB export (the archive-level cap)
 * needs ~320 MiB under this model — any default Node heap clears it.
 * The preflight only refuses the truly impossible, e.g. an operator
 * who pinned --max-old-space-size far below that, and it refuses
 * BEFORE minutes of unpack work and with an actionable reason instead
 * of an OOM-killed worker and a job stuck in "running".
 */
export const IMPORT_MEMORY_PREFLIGHT_BASE_BYTES = 192 * 1024 * 1024;
export const IMPORT_MEMORY_PREFLIGHT_XML_DIVISOR = 64;

/**
 * Machine-readable prefix of the preflight refusal. The web UI keys
 * its translated message off this prefix (mirroring the bare
 * `interrupted_by_restart` code the reconcile writes); the rest of the
 * string stays honest English for the status API and logs.
 */
export const INSUFFICIENT_MEMORY_REASON_PREFIX = "insufficient_memory";

const MIB = 1024 * 1024;

/**
 * Returns `null` when the runtime heap can carry the declared export,
 * otherwise the `failureReason` string for the refused import.
 * `heapLimitBytes` is injectable for tests; production reads the real
 * V8 limit, which reflects `NODE_OPTIONS=--max-old-space-size`.
 */
export function importMemoryPreflightReason(
  declaredXmlBytes: number,
  heapLimitBytes: number = getHeapStatistics().heap_size_limit,
): string | null {
  const requiredBytes =
    IMPORT_MEMORY_PREFLIGHT_BASE_BYTES +
    Math.ceil(declaredXmlBytes / IMPORT_MEMORY_PREFLIGHT_XML_DIVISOR);
  if (heapLimitBytes >= requiredBytes) return null;
  const requiredMib = Math.ceil(requiredBytes / MIB);
  const suggestedMib = Math.max(512, requiredMib);
  return (
    `${INSUFFICIENT_MEMORY_REASON_PREFIX}: export.xml declares ` +
    `${Math.ceil(declaredXmlBytes / MIB)} MiB uncompressed; parsing it needs ` +
    `roughly ${requiredMib} MiB of heap but the Node.js heap limit is ` +
    `${Math.floor(heapLimitBytes / MIB)} MiB. Raise it with ` +
    `NODE_OPTIONS=--max-old-space-size=${suggestedMib} on the container ` +
    `that runs the worker, then upload the export again.`
  );
}

/**
 * v1.28.33 (issue #486) — job-level pg-boss overrides for the import
 * sends. The queue defaults (retryLimit 2, expireInSeconds 900) are
 * wrong for this job shape twice over:
 *
 *   - A retry can never succeed: the first run consumes and unlinks the
 *     staged `/tmp` upload, so a redelivery re-opens a deleted file and
 *     its ENOENT masks the first run's real outcome.
 *   - A GB-scale export parses for well over 15 minutes; the default
 *     expiration marked the still-running job failed mid-run and
 *     scheduled exactly that doomed retry.
 *
 * `retryLimit: 0` makes the single run authoritative; the expiration
 * leaves generous headroom over the largest observed exports.
 */
export const APPLE_HEALTH_IMPORT_SEND_OPTIONS = {
  retryLimit: 0,
  expireInSeconds: 6 * 60 * 60,
} as const;

/** Payload `boss.send` carries onto the queue. */
export interface AppleHealthImportPayload {
  /** Owner of the imported rows. */
  userId: string;
  /** Admin who triggered the import (admin variant only). */
  triggeredByAdminId?: string;
  /** Absolute path on the worker filesystem where the upload landed. */
  uploadPath: string;
  /** Bytes count surfaced to the audit log. */
  uploadBytes: number;
  /** Wall-clock kick-off so duration is computable even with queue lag. */
  enqueuedAt: string;
}

let workerPrismaSingleton: PrismaClient | null = null;

/**
 * Test-only handle on the worker Prisma singleton. Mirrors the
 * `_resetEnsureUserRollupsFreshInFlightForTests` pattern in
 * `measurement-rollups.ts` — the integration suite injects the shared
 * testcontainer client so the handler does not open a second pool that
 * would dangle past the container teardown. Production code never calls
 * this.
 */
export function _setWorkerPrismaForTests(client: PrismaClient | null): void {
  workerPrismaSingleton = client;
}

function getWorkerPrisma(): PrismaClient {
  return workerPrismaSingleton ?? prisma;
}

/**
 * Move a job claimed from the legacy queue onto the revision-2 queue without
 * parsing it under the wrong revision. The existing ImportJob id remains the
 * status handle; only its pg-boss mirror id and truthful parser revision move.
 */
export async function migrateLegacyAppleHealthImport(
  job: Job<AppleHealthImportPayload>,
): Promise<void> {
  const prisma = getWorkerPrisma();
  let importJob = await prisma.importJob.findUnique({
    where: { pgBossJobId: job.id },
  });
  if (!importJob) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 250);
    await promise;
    importJob = await prisma.importJob.findUnique({
      where: { pgBossJobId: job.id },
    });
  }
  if (!importJob) {
    throw new Error(`No ImportJob mirror for legacy pg-boss job ${job.id}`);
  }
  if (importJob.status === "done" || importJob.status === "failed") {
    return;
  }

  const boss = getGlobalBoss();
  if (!boss) {
    throw new Error("Cannot bridge legacy Apple Health import without pg-boss");
  }
  const v2BossJobId = await boss.send(
    APPLE_HEALTH_IMPORT_V2_QUEUE,
    job.data,
    APPLE_HEALTH_IMPORT_SEND_OPTIONS,
  );
  if (!v2BossJobId) {
    throw new Error("Failed to enqueue bridged Apple Health import");
  }

  await prisma.importJob.update({
    where: { id: importJob.id },
    data: {
      pgBossJobId: v2BossJobId,
      parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
      status: "queued",
      failureReason: null,
      completedAt: null,
    },
  });
}

/**
 * Persist a progress snapshot onto the mirror `ImportJob` row. The
 * worker calls this every `PROGRESS_TICK_RECORDS` records parsed +
 * once on terminal `done`.
 */
async function writeProgress(
  prisma: PrismaClient,
  importJobId: string,
  status: string,
  progress: ImportJobProgress,
): Promise<void> {
  await prisma.importJob.update({
    where: { id: importJobId },
    data: {
      status,
      progress: toJson(progress),
    },
  });
}

/**
 * Top-level handler. Thrown errors land the job in `failed` with the
 * error message recorded on `ImportJob.failureReason` and re-thrown
 * so pg-boss sees the failure.
 */
export async function handleAppleHealthImport(
  job: Job<AppleHealthImportPayload>,
): Promise<JobOutcome> {
  const { userId, uploadPath, uploadBytes, triggeredByAdminId } = job.data;
  const prisma = getWorkerPrisma();

  // Resolve the mirror ImportJob row. The kick-off endpoint may have
  // raced the worker — if the row hasn't landed yet, retry once.
  let importJob = await prisma.importJob.findUnique({
    where: { pgBossJobId: job.id },
  });
  if (!importJob) {
    await new Promise((r) => setTimeout(r, 250));
    importJob = await prisma.importJob.findUnique({
      where: { pgBossJobId: job.id },
    });
  }
  if (!importJob) {
    // No mirror row — log and exit; we cannot surface progress.
    console.warn(
      `[apple-health-import] No ImportJob row for pgBossJobId=${job.id};` +
        " creating a stand-in",
    );
    importJob = await prisma.importJob.create({
      data: {
        userId,
        triggeredByAdminId: triggeredByAdminId ?? null,
        pgBossJobId: job.id,
        status: "queued",
        uploadBytes,
        parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
      },
    });
  }
  const importJobId = importJob.id;

  // v1.28.33 (issue #486) — refuse to re-run a job whose mirror row is
  // already terminal. pg-boss redelivers after the queue's expiration
  // window (a GB-scale import outlives the default 15 minutes), but the
  // first run consumed and unlinked the staged upload, so a redelivery
  // can only re-open the deleted `/tmp` file, fail with ENOENT, and
  // OVERWRITE the first run's real outcome (a genuine failure reason —
  // or a completed import flipped back to `failed`). The kick-off
  // endpoints now send with `retryLimit: 0`; this guard keeps any
  // residual redelivery (expiration sweep, operator requeue) from
  // masking the terminal state.
  if (importJob.status === "done" || importJob.status === "failed") {
    console.warn(
      `[apple-health-import] Ignoring duplicate delivery for ImportJob=${importJobId}` +
        ` — row is already terminal (${importJob.status}); the staged upload` +
        " was consumed by the first run and a re-run could only mask its outcome",
    );
    return jobDone({ skipped: "already_terminal" });
  }

  // Extracted-XML path, hoisted so the failure path can clean it up —
  // pre-v1.28.33 a parse failure stranded the multi-GB XML in `/tmp`.
  let extractedXmlPath: string | null = null;

  try {
    // Resolve the user's timezone — required for the cumulative
    // `stats:` day-key bucketing. Default to Europe/Berlin if the
    // user has no preference set.
    const userRow = await prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    const userTimezone =
      userRow?.timezone && userRow.timezone.length > 0
        ? userRow.timezone
        : "Europe/Berlin";

    // Phase 1: unpacking
    await writeProgress(prisma, importJobId, "unpacking", {
      currentPhase: "unpacking",
      recordsRead: 0,
      rowsUpserted: 0,
      percent: null,
      elapsedMs: 0,
    });

    const unzip = await extractExportXml(uploadPath, {
      // Refuse an export the heap demonstrably cannot carry BEFORE the
      // multi-minute unpack, with an actionable reason instead of an
      // OOM-killed worker (issue #775).
      preflight: ({ declaredXmlBytes }) => {
        const reason = importMemoryPreflightReason(declaredXmlBytes);
        if (reason) throw new Error(reason);
      },
    });
    extractedXmlPath = unzip.xmlPath;

    // Phase 2 + 3: parsing + upserting (the parser tracks both
    // phases internally via the onProgress hook).
    await writeProgress(prisma, importJobId, "parsing", {
      currentPhase: "parsing",
      recordsRead: 0,
      rowsUpserted: 0,
      percent: null,
      elapsedMs: 0,
    });

    const result: ImportJobResult = {
      ...(await streamParseExportXml({
        xmlPath: unzip.xmlPath,
        userId,
        userTimezone,
        prisma,
        onProgress: async (snapshot) => {
          // The phase label here is what the polling endpoint surfaces;
          // map "parsing" / "upserting" through verbatim.
          await prisma.importJob.update({
            where: { id: importJobId },
            data: {
              status: snapshot.currentPhase,
              progress: toJson(snapshot),
            },
          });
        },
        // The instant the Health app stamped on the archive. Persisted as
        // soon as the parser reads it, so the status endpoint answers with
        // it for the rest of the run and a job that later fails still
        // records which export it was working from. Best-effort: the
        // stamp is provenance, and losing it must not fail an import.
        onExportDate: async (exportedAt) => {
          await prisma.importJob
            .update({ where: { id: importJobId }, data: { exportedAt } })
            .catch(() => {});
        },
      })),
      ecg: {
        discovered: 0,
        imported: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
      },
    };

    // Auxiliary ECGs are intentionally fail-soft. The canonical export.xml
    // transaction has already completed; malformed, oversized, or unwritable
    // ECG members affect only bounded scalar counters in the terminal result.
    const ecg = result.ecg;
    ecg.discovered = unzip.otherMembers.filter((member) => {
      const lower = member.name.toLowerCase();
      return lower.includes("electrocardiograms/") && lower.endsWith(".csv");
    }).length;
    try {
      for await (const member of streamAppleHealthEcgMembers({
        archivePath: uploadPath,
        limits: APPLE_HEALTH_ECG_ARCHIVE_LIMITS,
      })) {
        try {
          const parsed = await parseAppleHealthEcgCsv({
            memberName: member.name,
            stream: member.stream,
            maxSamples: APPLE_HEALTH_ECG_MAX_SAMPLES,
          });
          const outcome = await importAppleHealthEcg({
            userId,
            ecg: parsed,
            prisma,
          });
          ecg[outcome] += 1;
        } catch {
          ecg.failed += 1;
        }
      }
    } catch {
      const completed = ecg.imported + ecg.updated + ecg.skipped + ecg.failed;
      ecg.failed += Math.max(0, ecg.discovered - completed);
    }

    // Done. Persist the terminal envelope.
    await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        status: "done",
        completedAt: new Date(),
        progress: toJson({
          currentPhase: "upserting",
          recordsRead: result.totals.recordsRead,
          rowsUpserted: result.totals.rowsUpserted,
          percent: 100,
          elapsedMs: result.totals.durationMs,
        }),
        result: toJson(result),
      },
    });

    // v1.5.0 — fold the persistent rollup table for the imported
    // user. The per-row write hooks are intentionally skipped on the
    // streaming-ingest path (a 100k-row import would otherwise pay
    // 100k DAY-recompute round-trips); we run the rollup once at
    // the end, scoped to the user's full measurement span, so
    // post-import reads of the analytics + comprehensive surfaces
    // hit the warm rollup table on first paint.
    //
    // The miss rides out as a fact rather than as a failed job: the
    // import is committed and its mirror row already reads `done`, so
    // failing here would report a completed import as failed and
    // contradict the row the status poll surfaces to the operator.
    let rollupFailed = false;
    try {
      // Folded over what this import wrote, not over the account's whole
      // history, and never further back than the fold window every other
      // path keeps to: buckets older than `ROLLUP_FOLD_WINDOW_MS` are by
      // design never written, so reads there fall back to live SQL. The old
      // span ran from the account's first measurement, whatever the import
      // carried, and folded any history older than the window as well.
      const span = result.measuredSpan;
      if (span) {
        const windowStart = new Date(Date.now() - ROLLUP_FOLD_WINDOW_MS);
        const spanFrom = new Date(span.from);
        const from = spanFrom > windowStart ? spanFrom : windowStart;
        // `to` is exclusive in the aggregator, so one millisecond past the
        // newest row.
        const to = new Date(new Date(span.to).getTime() + 1);
        if (to > from) {
          await recomputeUserRollups(userId, { from, to });
        }
      }
    } catch (rollupErr) {
      // Rollup failure is non-fatal — the next read falls through to
      // live aggregation. Log but don't poison the import.
      rollupFailed = true;
      console.warn(
        `[apple-health-import] Rollup recompute failed for user ${userId}`,
        rollupErr,
      );
    }

    // Best-effort cleanup. A failed unlink is not fatal — `/tmp` is
    // periodically swept on the host.
    safeUnlink(unzip.xmlPath);
    safeUnlink(uploadPath);

    return jobDone({
      records_read: result.totals.recordsRead,
      rows_upserted: result.totals.rowsUpserted,
      duration_ms: result.totals.durationMs,
      rollup_failed: rollupFailed,
    });
  } catch (err) {
    // v1.28.33 (issue #486) — a missing staging file is an operational
    // condition, not a parse failure: `/tmp` is wiped on a container
    // restart and a previous attempt unlinks the upload on its own
    // failure path. Surface an honest, actionable reason instead of the
    // raw `ENOENT: no such file or directory, open '/tmp/…'` string the
    // status endpoint used to hand the UI.
    const missingStagingFile =
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT";
    const reason = missingStagingFile
      ? "Import staging file is no longer available — the server restarted," +
        " a previous attempt cleaned it up, or (if you run separate web and" +
        " worker containers) they do not share the import staging directory." +
        " Upload the export again; split deployments must run single-container" +
        " mode or mount a shared staging volume on both the web and worker" +
        " containers."
      : err instanceof Error
        ? err.message
        : String(err);
    await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        status: "failed",
        failureReason: reason.slice(0, 1000),
        completedAt: new Date(),
      },
    });
    if (extractedXmlPath) safeUnlink(extractedXmlPath);
    safeUnlink(uploadPath);
    throw err;
  }
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // ignore — file may already be gone
  }
}

/**
 * A non-terminal ImportJob whose heartbeat (`updatedAt`) has not moved
 * for this long is treated as orphaned even when pg-boss still reports
 * its job `active`. A live import bumps the heartbeat on every progress
 * tick (every 1000 records → sub-second during the parse phase), and
 * the only legitimately-quiet window is the `unpacking` unzip of a
 * multi-GB archive, so 30 minutes clears the largest observed exports
 * with headroom while still self-healing a genuinely stuck job.
 */
const IMPORT_HEARTBEAT_STALE_MS = 30 * 60 * 1000;

/** pg-boss job states from which a mid-run import can still make progress. */
const LIVE_PG_BOSS_STATES = new Set(["active", "created", "retry"]);

/**
 * Reconcile orphan `ImportJob` rows on worker startup. A row stuck in
 * `unpacking` / `parsing` / `upserting` means a worker was mid-run when
 * it last shut down — flip it to `failed` with `interrupted_by_restart`
 * so the operator can re-upload (and, post-issue-#486, so the kick-off
 * dedup no longer short-circuits future re-uploads onto a dead job).
 * Revision-1 rows are deliberately excluded: during a rolling deployment
 * their backing jobs live on the legacy queue and remain owned by old workers.
 *
 * The reconcile is deliberately NOT unconditional. In a multi-replica
 * or rolling-deploy topology a booting worker must not flip a row that
 * another live worker is actively parsing. It therefore keeps a
 * non-terminal row alive when BOTH:
 *   - pg-boss still reports its backing job in a live state
 *     (`active` / `created` / `retry`), AND
 *   - the row's `updatedAt` heartbeat is fresher than
 *     `IMPORT_HEARTBEAT_STALE_MS`.
 * A row is reconciled to `failed` when its pg-boss job is gone (null,
 * archived) or terminal (`completed` / `cancelled` / `failed`), OR when
 * its heartbeat has gone stale (owner died but pg-boss has not yet
 * expired the job). This keeps the single-worker default self-healing
 * truly-stuck jobs while never racing a live import in another worker.
 *
 * If the boss handle is unavailable (should not happen — reconcile runs
 * after `setGlobalBoss()`), it falls back to the heartbeat bound alone.
 * Idempotent — re-running on a clean startup is a no-op.
 *
 * Exported so the worker boot path in `reminder-worker.ts` can wire it
 * into the start-up sequence right after `boss.start()`.
 */
export async function reconcileOrphanImportJobs(): Promise<void> {
  const prisma = getWorkerPrisma();
  const candidates = await prisma.importJob.findMany({
    where: {
      parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
      status: { in: ["unpacking", "parsing", "upserting"] },
    },
    select: { id: true, pgBossJobId: true, updatedAt: true },
  });
  if (candidates.length === 0) return;

  const boss = getGlobalBoss();
  const staleBefore = Date.now() - IMPORT_HEARTBEAT_STALE_MS;
  const orphanIds: string[] = [];

  for (const row of candidates) {
    const heartbeatStale = row.updatedAt.getTime() < staleBefore;

    // No live-state source, or no backing job id, or a stale heartbeat:
    // the row cannot be confirmed as running anywhere → reconcile it.
    if (!boss || !row.pgBossJobId || heartbeatStale) {
      orphanIds.push(row.id);
      continue;
    }

    let live = false;
    try {
      const job = await boss.getJobById(
        APPLE_HEALTH_IMPORT_V2_QUEUE,
        row.pgBossJobId,
      );
      live = job !== null && LIVE_PG_BOSS_STATES.has(job.state);
    } catch {
      // Lookup failed — the heartbeat is fresh (checked above), so leave
      // the row alone rather than risk flipping a live import; a later
      // boot re-evaluates it once the heartbeat goes stale.
      live = true;
    }

    if (!live) orphanIds.push(row.id);
  }

  if (orphanIds.length === 0) return;
  await prisma.importJob.updateMany({
    where: { id: { in: orphanIds } },
    data: {
      status: "failed",
      failureReason: "interrupted_by_restart",
      completedAt: new Date(),
    },
  });
}
