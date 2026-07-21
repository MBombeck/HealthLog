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
import type { PrismaClient } from "@/generated/prisma/client";
import { prisma, toJson } from "@/lib/db";
import type { Job } from "pg-boss";

import { extractExportXml } from "@/lib/import/unzip-export-xml";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  streamParseExportXml,
  type ImportJobProgress,
  type ImportJobResult,
} from "@/lib/measurements/import-apple-health-export";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";

/** Queue name isolated from revision-1 workers during rolling deployments. */
export const APPLE_HEALTH_IMPORT_V2_QUEUE = "apple-health-import-v2";

/** Queue used by pre-revision-2 binaries; new workers only bridge its backlog. */
export const APPLE_HEALTH_IMPORT_LEGACY_QUEUE = "apple-health-import";

/** Parser semantics carried by every newly-created ImportJob. */
export const APPLE_HEALTH_IMPORT_PARSER_REVISION = 2;

/** Concurrency cap per worker host. */
export const APPLE_HEALTH_IMPORT_CONCURRENCY = 1;

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
): Promise<void> {
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
    return;
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

    const unzip = extractExportXml(uploadPath);
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

    const result: ImportJobResult = await streamParseExportXml({
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
    });

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
    try {
      const span = await prisma.measurement.aggregate({
        where: { userId },
        _min: { measuredAt: true },
        _max: { measuredAt: true },
      });
      if (span._min.measuredAt && span._max.measuredAt) {
        // Add a small tail buffer to `to` so the upper bound is
        // exclusive-safe under the rollup aggregator's `< to` filter.
        const to = new Date(span._max.measuredAt.getTime() + 1);
        await recomputeUserRollups(userId, {
          from: span._min.measuredAt,
          to,
        });
      }
    } catch (rollupErr) {
      // Rollup failure is non-fatal — the next read falls through to
      // live aggregation. Log but don't poison the import.
      console.warn(
        `[apple-health-import] Rollup recompute failed for user ${userId}`,
        rollupErr,
      );
    }

    // Best-effort cleanup. A failed unlink is not fatal — `/tmp` is
    // periodically swept on the host.
    safeUnlink(unzip.xmlPath);
    safeUnlink(uploadPath);
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
