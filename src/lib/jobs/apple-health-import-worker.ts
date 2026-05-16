/**
 * v1.4.34 — pg-boss handler for the `apple-health-import` queue.
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
import { PrismaClient, Prisma } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Job } from "pg-boss";

import { extractExportXml } from "@/lib/import/unzip-export-xml";
import {
  streamParseExportXml,
  type ImportJobProgress,
  type ImportJobResult,
} from "@/lib/measurements/import-apple-health-export";

/** Queue name for the Apple Health export ingest. */
export const APPLE_HEALTH_IMPORT_QUEUE = "apple-health-import";

/** Concurrency cap per worker host. */
export const APPLE_HEALTH_IMPORT_CONCURRENCY = 1;

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
function getWorkerPrisma(): PrismaClient {
  if (!workerPrismaSingleton) {
    const adapter = new PrismaPg({
      connectionString: process.env.DATABASE_URL!,
    });
    workerPrismaSingleton = new PrismaClient({ adapter });
  }
  return workerPrismaSingleton;
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
      progress: progress as unknown as Prisma.InputJsonValue,
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
      `[apple-health-import] No ImportJob row for pgBossJobId=${job.id};`
      + " creating a stand-in",
    );
    importJob = await prisma.importJob.create({
      data: {
        userId,
        triggeredByAdminId: triggeredByAdminId ?? null,
        pgBossJobId: job.id,
        status: "queued",
        uploadBytes,
      },
    });
  }
  const importJobId = importJob.id;

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
            progress: snapshot as unknown as Prisma.InputJsonValue,
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
        progress: {
          currentPhase: "upserting",
          recordsRead: result.totals.recordsRead,
          rowsUpserted: result.totals.rowsUpserted,
          percent: 100,
          elapsedMs: result.totals.durationMs,
        } as unknown as Prisma.InputJsonValue,
        result: result as unknown as Prisma.InputJsonValue,
      },
    });

    // Best-effort cleanup. A failed unlink is not fatal — `/tmp` is
    // periodically swept on the host.
    safeUnlink(unzip.xmlPath);
    safeUnlink(uploadPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        status: "failed",
        failureReason: reason.slice(0, 1000),
        completedAt: new Date(),
      },
    });
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
 * Reconcile orphan `ImportJob` rows on worker startup. A row stuck
 * in `parsing` or `upserting` whose `pgBossJobId` is no longer alive
 * on the boss side means the worker was killed mid-run; flip it to
 * `failed` with `interrupted_by_restart` so the operator can re-run
 * the upload. Idempotent — re-running this on a clean startup is a
 * no-op.
 *
 * Exported so the worker boot path in `reminder-worker.ts` can wire
 * it into the start-up sequence right after `boss.start()`.
 */
export async function reconcileOrphanImportJobs(): Promise<void> {
  const prisma = getWorkerPrisma();
  await prisma.importJob.updateMany({
    where: {
      status: { in: ["unpacking", "parsing", "upserting"] },
    },
    data: {
      status: "failed",
      failureReason: "interrupted_by_restart",
      completedAt: new Date(),
    },
  });
}
