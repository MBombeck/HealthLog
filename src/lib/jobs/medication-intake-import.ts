import type { Job, JobWithMetadata } from "pg-boss";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";

import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { auditLog } from "@/lib/auth/audit";
import { prisma, toJson } from "@/lib/db";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { jobBudget } from "@/lib/jobs/job-budget";
import { enqueueSupplementNutrientRecompute } from "@/lib/medications/ingredients/recompute-job";
import { consumeImportedIntakesBatch } from "@/lib/medications/inventory/consumption";
import { queueMedicationIntakeSync } from "@/lib/notifications/medication-intake-sync";
export const MEDICATION_INTAKE_IMPORT_CHUNK_SIZE = 100;
export const MEDICATION_INTAKE_IMPORT_STALE_AFTER_MS = 15 * 60_000;

export const MEDICATION_INTAKE_IMPORT_SEND_OPTIONS = {
  retryLimit: 3,
  retryDelay: 15,
  retryBackoff: true,
  expireInSeconds: 60 * 60,
} as const;

export interface MedicationImportEntry {
  /**
   * The slot instant this dose belongs to, and the fact it is identified by.
   * Equals `takenAt` for an ad-hoc dose that belongs to no slot.
   */
  scheduledFor: string;
  /** When the dose was actually taken. `null` for a deliberate skip. */
  takenAt: string | null;
  idempotencyKey: string;
  /**
   * The medication this dose attaches to. Carried per entry because a dose
   * history exported from another app covers a whole regimen in one file, so the
   * job cannot be scoped to a single medication the way the per-medication
   * import route's job is. Absent on that route's jobs, where the job row names
   * the medication instead.
   */
  medicationId?: string;
  /**
   * Per-dose override, free text, mirroring `Medication.dose`. Absent when the
   * configured schedule dose applies — which is the overwhelming majority, and
   * absence is how `MedicationIntakeEvent.doseTaken` already says so.
   */
  doseTaken?: string;
  /**
   * 1-based row in the submitted file. This is the only source-row identity
   * persisted for result details: never carry medication, dose, timestamp or
   * raw file content into the status response.
   */
  sourceLine?: number;
}

export interface MedicationImportPayload {
  entries: MedicationImportEntry[];
}

/**
 * Why a submitted row did not become a row on the ledger. Machine-readable; the
 * client turns each into a sentence.
 *
 * `duplicate_in_file` — two rows of the same submission resolve to the same
 * medication and slot, so only one can be written.
 * `already_recorded` — the dose is already on the ledger for that slot from an
 * earlier import. `source` is part of the live-row unique
 * `(user_id, medication_id, scheduled_for, source)`, so this does NOT cover a
 * dose the person logged by hand at the same slot on another surface: that row
 * and the imported one are distinct keys and both are written. Cross-surface
 * dedup is a slot-window question, not a unique-key one, and it does not exist
 * yet — do not read this reason as though it did.
 *
 * Those two used to be one `skippedDuplicates` number, which is how a file whose
 * every row collapsed onto one key could report "27 duplicates skipped" about 27
 * doses that had no duplicate anywhere. Naming the reason is what makes the count
 * checkable against what the person actually submitted.
 *
 * The rest are decided before the queue, when a whole export file is parsed and
 * matched against the record. They are seeded into the job's progress so the
 * final count covers the entire file rather than only the part that reached the
 * database — a row refused at the door is still a row the person needs told
 * about, by name.
 */
export const MEDICATION_IMPORT_SKIP_REASONS = [
  "duplicate_in_file",
  "already_recorded",
  "medication_not_found",
  "medication_ambiguous",
  "medication_is_mirrored",
  "status_no_dose_information",
  "status_reminder_event",
  "status_notification_not_sent",
  "status_unknown",
  "missing_timestamp",
  "missing_timezone_offset",
  "unreadable_timestamp",
  "implausible_timestamp",
  "missing_medication",
  "unreadable_dosage",
  "unreadable_row",
] as const;

export type MedicationImportSkipReason =
  (typeof MEDICATION_IMPORT_SKIP_REASONS)[number];

/** Skip counts keyed by reason. A reason with no skips is absent, not zero. */
export type MedicationImportSkipCounts = Partial<
  Record<MedicationImportSkipReason, number>
>;

/** Maximum source rows returned through the background-job status response. */
export const MEDICATION_IMPORT_SKIP_DETAIL_LIMIT = 200;
export const MEDICATION_IMPORT_MAX_SOURCE_LINE = 30_001;

/**
 * Safe per-row detail. The allowlisted reason and ordinal are enough to find a
 * row in the person's own file without persisting health data from that row.
 */
export interface MedicationImportSkipDetail {
  line: number;
  reason: MedicationImportSkipReason;
}

export interface MedicationImportProgress {
  processed: number;
  total: number;
  imported: number;
  skippedByReason: MedicationImportSkipCounts;
  /** First bounded source-row details; absent on legacy jobs. */
  skipDetails?: MedicationImportSkipDetail[];
  /** Details beyond the hard cap, counted without retaining their contents. */
  skippedDetailsOmitted?: number;
  /**
   * Wire fields of the dropped compliance rollup's recompute phase. A job
   * admitted now carries `[]` and `0` and the worker never advances them;
   * they stay on the published progress shape for clients that decode it.
   */
  touchedDays: string[];
  rollupProcessed: number;
}

export interface MedicationImportSkipGroup {
  reason: MedicationImportSkipReason;
  count: number;
}

export interface MedicationImportResult {
  imported: number;
  /** Total entries that did not become a row. */
  skipped: number;
  /**
   * One entry per reason, count descending then reason — never the same
   * sentence repeated per row. Empty when nothing was skipped.
   */
  skipReasons: MedicationImportSkipGroup[];
  /** Bounded, redacted source-row details. */
  skipDetails?: MedicationImportSkipDetail[];
  /** Number of additional skipped rows not retained in `skipDetails`. */
  skippedDetailsOmitted?: number;
}

export interface MedicationImportSkipDetailAccumulator {
  skipDetails: MedicationImportSkipDetail[];
  skippedDetailsOmitted: number;
}

/**
 * Append safe row details without ever letting the persisted/status payload
 * grow with the input file. Callers must already have reduced rows to the
 * allowlisted ordinal + reason shape.
 */
export function appendMedicationImportSkipDetails(
  current: MedicationImportSkipDetailAccumulator,
  incoming: readonly MedicationImportSkipDetail[],
): MedicationImportSkipDetailAccumulator {
  const capacity = Math.max(
    0,
    MEDICATION_IMPORT_SKIP_DETAIL_LIMIT - current.skipDetails.length,
  );
  const retained = incoming.slice(0, capacity);
  return {
    skipDetails: [...current.skipDetails, ...retained],
    skippedDetailsOmitted:
      current.skippedDetailsOmitted + incoming.length - retained.length,
  };
}

/** Collapse the running counts into the wire shape, in a stable order. */
export function groupMedicationImportSkips(
  counts: MedicationImportSkipCounts,
): MedicationImportSkipGroup[] {
  return MEDICATION_IMPORT_SKIP_REASONS.map((reason) => ({
    reason,
    count: counts[reason] ?? 0,
  }))
    .filter((group) => group.count > 0)
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** Total skipped across every reason. */
export function totalMedicationImportSkips(
  counts: MedicationImportSkipCounts,
): number {
  return MEDICATION_IMPORT_SKIP_REASONS.reduce(
    (sum, reason) => sum + (counts[reason] ?? 0),
    0,
  );
}

export interface MedicationIntakeImportQueuePayload {
  jobId: string;
}

export interface MedicationImportChunkResult {
  from: number;
  processed: number;
  imported: number;
  skippedByReason: MedicationImportSkipCounts;
  skipDetails?: MedicationImportSkipDetail[];
}

let workerPrismaSingleton: PrismaClient | null = null;

export function _setMedicationIntakeImportPrismaForTests(
  client: PrismaClient | null,
): void {
  workerPrismaSingleton = client;
}

function getWorkerPrisma(): PrismaClient {
  return workerPrismaSingleton ?? prisma;
}

export function medicationImportChunk<T>(
  entries: readonly T[],
  cursor: number,
): T[] {
  const start = Math.max(0, Math.trunc(cursor));
  return entries.slice(start, start + MEDICATION_INTAKE_IMPORT_CHUNK_SIZE);
}

export function advanceMedicationImportProgress(
  previous: MedicationImportProgress,
  chunk: MedicationImportChunkResult,
): MedicationImportProgress {
  if (chunk.from !== previous.processed) return previous;

  const processed = Math.min(
    previous.total,
    previous.processed + Math.max(0, Math.trunc(chunk.processed)),
  );
  const skippedByReason: MedicationImportSkipCounts = {
    ...previous.skippedByReason,
  };
  for (const reason of MEDICATION_IMPORT_SKIP_REASONS) {
    const added = Math.max(0, Math.trunc(chunk.skippedByReason[reason] ?? 0));
    if (added === 0) continue;
    skippedByReason[reason] = (skippedByReason[reason] ?? 0) + added;
  }

  const detailAccumulator = appendMedicationImportSkipDetails(
    {
      skipDetails: previous.skipDetails ?? [],
      skippedDetailsOmitted: previous.skippedDetailsOmitted ?? 0,
    },
    chunk.skipDetails ?? [],
  );
  const includeDetails =
    previous.skipDetails !== undefined ||
    previous.skippedDetailsOmitted !== undefined ||
    (chunk.skipDetails?.length ?? 0) > 0;

  return {
    processed,
    total: previous.total,
    imported: previous.imported + Math.max(0, Math.trunc(chunk.imported)),
    skippedByReason,
    ...(includeDetails
      ? {
          skipDetails: detailAccumulator.skipDetails,
          skippedDetailsOmitted: detailAccumulator.skippedDetailsOmitted,
        }
      : {}),
    rollupProcessed: previous.rollupProcessed,
    touchedDays: previous.touchedDays,
  };
}

export function sanitiseMedicationImportFailure(error: unknown): string {
  void error;
  return "Medication intake import failed";
}

function parsePayload(value: Prisma.JsonValue): MedicationImportPayload {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("entries" in value) ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("Medication intake import payload is malformed");
  }

  const entries = value.entries.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      typeof entry.idempotencyKey !== "string" ||
      entry.idempotencyKey.length === 0
    ) {
      throw new Error("Medication intake import entry is malformed");
    }
    const takenAt = entry.takenAt;
    if (
      takenAt !== null &&
      (typeof takenAt !== "string" || !Number.isFinite(Date.parse(takenAt)))
    ) {
      throw new Error("Medication intake import entry is malformed");
    }
    // `scheduledFor` was added when the importer learnt to read an export that
    // states the scheduled time and the time taken as two separate facts. A job
    // row enqueued before that carries only `takenAt`, and such a row is an
    // ad-hoc dose anchored on itself — which is what the absence means. This is
    // for rows already in the database, not for a caller.
    const rawScheduledFor =
      entry.scheduledFor === undefined ? takenAt : entry.scheduledFor;
    if (
      typeof rawScheduledFor !== "string" ||
      !Number.isFinite(Date.parse(rawScheduledFor))
    ) {
      throw new Error("Medication intake import entry is malformed");
    }
    if (
      entry.medicationId !== undefined &&
      (typeof entry.medicationId !== "string" ||
        entry.medicationId.length === 0)
    ) {
      throw new Error("Medication intake import entry is malformed");
    }
    if (entry.doseTaken !== undefined && typeof entry.doseTaken !== "string") {
      throw new Error("Medication intake import entry is malformed");
    }
    if (
      entry.sourceLine !== undefined &&
      (typeof entry.sourceLine !== "number" ||
        !Number.isInteger(entry.sourceLine) ||
        entry.sourceLine < 1 ||
        entry.sourceLine > MEDICATION_IMPORT_MAX_SOURCE_LINE)
    ) {
      throw new Error("Medication intake import entry is malformed");
    }
    return {
      scheduledFor: rawScheduledFor,
      takenAt: takenAt as string | null,
      idempotencyKey: entry.idempotencyKey,
      ...(entry.medicationId === undefined
        ? {}
        : { medicationId: entry.medicationId }),
      ...(entry.doseTaken === undefined ? {} : { doseTaken: entry.doseTaken }),
      ...(entry.sourceLine === undefined
        ? {}
        : { sourceLine: entry.sourceLine }),
    };
  });
  return { entries };
}

/**
 * Read the persisted skip counts. Strict, like every other field of the
 * progress blob: an unknown reason key or a non-integer count means the row was
 * not written by this code, and the job fails rather than reporting a number it
 * cannot stand behind. Returns null on anything malformed.
 */
function parseSkipCounts(
  value: Prisma.JsonValue | undefined,
): MedicationImportSkipCounts | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const counts: MedicationImportSkipCounts = {};
  for (const [key, raw] of Object.entries(value)) {
    if (
      !(MEDICATION_IMPORT_SKIP_REASONS as readonly string[]).includes(key) ||
      typeof raw !== "number" ||
      !Number.isInteger(raw) ||
      raw < 0
    ) {
      return null;
    }
    counts[key as MedicationImportSkipReason] = raw;
  }
  return counts;
}

function parseProgress(
  value: Prisma.JsonValue,
  total: number,
): MedicationImportProgress {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Medication intake import progress is malformed");
  }
  const processed = Number(value.processed);
  const imported = Number(value.imported);
  const skippedByReason = parseSkipCounts(value.skippedByReason);
  const rawTouchedDays = value.touchedDays;
  const touchedDays =
    Array.isArray(rawTouchedDays) &&
    rawTouchedDays.every((day): day is string => typeof day === "string")
      ? [...new Set(rawTouchedDays)]
      : null;
  const rollupProcessed =
    value.rollupProcessed === undefined ? 0 : Number(value.rollupProcessed);
  const rawSkipDetails = value.skipDetails;
  const skipDetails =
    rawSkipDetails === undefined
      ? undefined
      : parseMedicationImportSkipDetails(rawSkipDetails);
  const skippedDetailsOmitted =
    value.skippedDetailsOmitted === undefined
      ? undefined
      : Number(value.skippedDetailsOmitted);
  if (
    !Number.isInteger(processed) ||
    processed < 0 ||
    processed > total ||
    !Number.isInteger(imported) ||
    imported < 0 ||
    skippedByReason === null ||
    touchedDays === null ||
    !Number.isInteger(rollupProcessed) ||
    rollupProcessed < 0 ||
    rollupProcessed > (touchedDays?.length ?? 0) ||
    (rawSkipDetails !== undefined && skipDetails === null) ||
    (skippedDetailsOmitted !== undefined &&
      (!Number.isInteger(skippedDetailsOmitted) || skippedDetailsOmitted < 0))
  ) {
    throw new Error("Medication intake import progress is malformed");
  }
  return {
    processed,
    total,
    imported,
    skippedByReason,
    ...(skipDetails === undefined || skipDetails === null
      ? {}
      : { skipDetails }),
    ...(skippedDetailsOmitted === undefined ? {} : { skippedDetailsOmitted }),
    touchedDays,
    rollupProcessed,
  };
}

/** Strictly parse only the two safe fields permitted in a row detail. */
export function parseMedicationImportSkipDetails(
  value: Prisma.JsonValue,
): MedicationImportSkipDetail[] | null {
  if (
    !Array.isArray(value) ||
    value.length > MEDICATION_IMPORT_SKIP_DETAIL_LIMIT
  ) {
    return null;
  }
  const details: MedicationImportSkipDetail[] = [];
  for (const detail of value) {
    if (
      typeof detail !== "object" ||
      detail === null ||
      Array.isArray(detail) ||
      !Number.isInteger(detail.line) ||
      Number(detail.line) < 1 ||
      Number(detail.line) > MEDICATION_IMPORT_MAX_SOURCE_LINE ||
      typeof detail.reason !== "string" ||
      !(MEDICATION_IMPORT_SKIP_REASONS as readonly string[]).includes(
        detail.reason,
      )
    ) {
      return null;
    }
    details.push({
      line: Number(detail.line),
      reason: detail.reason as MedicationImportSkipReason,
    });
  }
  return details;
}

interface ProcessChunkOutcome {
  terminal: boolean;
  finalized: boolean;
  result: MedicationImportResult | null;
  userId: string | null;
}

async function processNextChunk(
  client: PrismaClient,
  jobId: string,
): Promise<ProcessChunkOutcome> {
  return client.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "medication_intake_import_jobs"
        WHERE "id" = ${jobId}
        FOR UPDATE
      `;
      if (locked.length === 0) {
        return {
          terminal: true,
          finalized: false,
          result: null,
          userId: null,
        };
      }

      const row = await tx.medicationIntakeImportJob.findUnique({
        where: { id: jobId },
      });
      if (!row || row.status === "done" || row.status === "failed") {
        return {
          terminal: true,
          finalized: false,
          result: null,
          userId: row?.recordUserId ?? null,
        };
      }

      const payload = parsePayload(row.payload);
      const progress = parseProgress(row.progress, payload.entries.length);
      if (progress.processed >= progress.total) {
        const result: MedicationImportResult = {
          imported: progress.imported,
          skipped: totalMedicationImportSkips(progress.skippedByReason),
          skipReasons: groupMedicationImportSkips(progress.skippedByReason),
          ...(progress.skipDetails === undefined
            ? {}
            : { skipDetails: progress.skipDetails }),
          ...(progress.skippedDetailsOmitted === undefined
            ? {}
            : { skippedDetailsOmitted: progress.skippedDetailsOmitted }),
        };
        const completedAt = new Date();
        await auditLog("medication.intake.import", {
          client: tx,
          userId: row.recordUserId,
          actorUserId: row.actorUserId,
          details: {
            jobId: row.id,
            recordUserId: row.recordUserId,
            actorUserId: row.actorUserId,
            imported: result.imported,
            skipped: result.skipped,
            total: progress.total,
          },
        });
        await tx.medicationIntakeImportJob.update({
          where: { id: row.id },
          data: {
            status: "done",
            result: toJson(result),
            progress: toJson(progress),
            failureReason: null,
            heartbeatAt: completedAt,
            completedAt,
          },
        });
        return {
          terminal: true,
          finalized: true,
          result,
          userId: row.recordUserId,
        };
      }

      const entries = medicationImportChunk(
        payload.entries,
        progress.processed,
      );
      const uniqueByKey = new Map<string, MedicationImportEntry>();
      const duplicateDetails: MedicationImportSkipDetail[] = [];
      for (const entry of entries) {
        if (uniqueByKey.has(entry.idempotencyKey)) {
          if (entry.sourceLine !== undefined) {
            duplicateDetails.push({
              line: entry.sourceLine,
              reason: "duplicate_in_file",
            });
          }
          continue;
        }
        uniqueByKey.set(entry.idempotencyKey, entry);
      }
      const uniqueEntries = [...uniqueByKey.values()];
      // An entry names its own medication when the job came from an export file
      // covering a whole regimen; the per-medication route's jobs name it on the
      // job row instead. One of the two must be there, and a payload with
      // neither is a malformed job rather than a row to write against a guess.
      const resolveMedicationId = (entry: MedicationImportEntry): string => {
        const medicationId = entry.medicationId ?? row.medicationId;
        if (!medicationId) {
          throw new Error("Medication intake import entry names no medication");
        }
        return medicationId;
      };

      const created = await tx.medicationIntakeEvent.createManyAndReturn({
        data: uniqueEntries.map((entry) => {
          const scheduledFor = new Date(entry.scheduledFor);
          const takenAt =
            entry.takenAt === null ? null : new Date(entry.takenAt);
          return {
            userId: row.recordUserId,
            medicationId: resolveMedicationId(entry),
            // The scheduled slot and the time taken are two separate facts, and
            // the export states both. Writing the take into both columns — which
            // is all the old two-field payload could express — asserts every
            // dose landed exactly on time, and no later edit recovers what that
            // overwrote.
            scheduledFor,
            takenAt,
            // A null take on an imported row is a deliberate skip: the source
            // recorded that the person chose not to take that dose.
            skipped: takenAt === null,
            source: "IMPORT" as const,
            idempotencyKey: entry.idempotencyKey,
            ...(entry.doseTaken === undefined
              ? {}
              : { doseTaken: entry.doseTaken }),
          };
        }),
        skipDuplicates: true,
        select: {
          id: true,
          medicationId: true,
          takenAt: true,
          scheduledFor: true,
          idempotencyKey: true,
        },
      });
      const createdKeys = new Set(created.map((event) => event.idempotencyKey));
      const alreadyRecordedDetails: MedicationImportSkipDetail[] = [];
      for (const entry of uniqueEntries) {
        if (
          !createdKeys.has(entry.idempotencyKey) &&
          entry.sourceLine !== undefined
        ) {
          alreadyRecordedDetails.push({
            line: entry.sourceLine,
            reason: "already_recorded",
          });
        }
      }

      // Inventory is per medication and a skip consumes nothing, so the created
      // rows are grouped and the skips left out. `consumeImportedIntakesBatch`
      // asserts it claimed every event handed to it, which only holds for rows
      // that actually carry a take.
      const consumedByMedication = new Map<
        string,
        Array<{ eventId: string; intakeAt: Date }>
      >();
      for (const event of created) {
        if (event.takenAt === null) continue;
        const bucket = consumedByMedication.get(event.medicationId);
        const entry = { eventId: event.id, intakeAt: event.takenAt };
        if (bucket) bucket.push(entry);
        else consumedByMedication.set(event.medicationId, [entry]);
      }
      for (const [medicationId, events] of consumedByMedication) {
        await consumeImportedIntakesBatch({
          client: tx,
          userId: row.recordUserId,
          medicationId,
          events,
        });
      }

      // Two different facts, counted apart. The Map collapse above is entries
      // of this submission that resolve to the same instant; `skipDuplicates`
      // then drops whatever the ledger already holds for that instant, from an
      // earlier import or any other intake surface. Reporting both as one
      // "duplicates" number is what let a whole month of distinct doses read
      // as duplicates of each other.
      const nextProgress = advanceMedicationImportProgress(progress, {
        from: progress.processed,
        processed: entries.length,
        imported: created.length,
        skippedByReason: {
          duplicate_in_file: entries.length - uniqueEntries.length,
          already_recorded: uniqueEntries.length - created.length,
        },
        skipDetails: [...duplicateDetails, ...alreadyRecordedDetails],
      });
      const heartbeatAt = new Date();
      await tx.medicationIntakeImportJob.update({
        where: { id: row.id },
        data: {
          status: "running",
          progress: toJson(nextProgress),
          heartbeatAt,
          startedAt: row.startedAt ?? heartbeatAt,
          failureReason: null,
        },
      });
      return {
        terminal: false,
        finalized: false,
        result: null,
        userId: row.recordUserId,
      };
    },
    { timeout: 60_000 },
  );
}

/**
 * Work the import chunk by chunk until it is finished. `shouldStop` is the
 * job's time budget: between chunks, once it is spent, the run returns
 * `"stopped"` and leaves the job row as it is. Every chunk commits its own
 * progress under the row lock, so the retry that follows picks up at the next
 * chunk, and a second delivery running beside this one waits on that lock and
 * continues from the progress this one wrote.
 */
async function workMedicationIntakeImport(
  jobId: string,
  shouldStop: () => boolean,
): Promise<MedicationImportResult | null | "stopped"> {
  const client = getWorkerPrisma();
  for (;;) {
    const outcome = await processNextChunk(client, jobId);
    if (!outcome.terminal) {
      if (shouldStop()) return "stopped";
      continue;
    }
    if (outcome.finalized && outcome.userId && outcome.result) {
      if (outcome.result.imported > 0) {
        invalidateUserMedications(outcome.userId, { evict: true });
        queueMedicationIntakeSync({ userId: outcome.userId });
        // v1.43 — the chunks recomputed their compliance days inside their
        // own transactions; the supplement nutrient rows follow once, now
        // that every imported dose is committed.
        await enqueueSupplementNutrientRecompute(outcome.userId);
      }
      return outcome.result;
    }
    return null;
  }
}

/** The whole import in one go, with no time budget. */
export async function processMedicationIntakeImportJob(
  jobId: string,
): Promise<MedicationImportResult | null> {
  const result = await workMedicationIntakeImport(jobId, () => false);
  return result === "stopped" ? null : result;
}

async function recordWorkerFailure(
  job: Job<MedicationIntakeImportQueuePayload>,
  error: unknown,
): Promise<void> {
  const client = getWorkerPrisma();
  const metadata = job as Partial<
    JobWithMetadata<MedicationIntakeImportQueuePayload>
  >;
  const retryCount = metadata.retryCount ?? 0;
  const retryLimit = metadata.retryLimit ?? 0;
  const terminal = retryCount >= retryLimit;
  const now = new Date();
  // account-deletion: the one import this job runs, by id.
  await client.medicationIntakeImportJob.updateMany({
    where: {
      id: job.data.jobId,
      status: { notIn: ["done", "failed"] },
    },
    data: terminal
      ? {
          status: "failed",
          failureReason: sanitiseMedicationImportFailure(error),
          heartbeatAt: now,
          completedAt: now,
        }
      : {
          status: "queued",
          failureReason: null,
          heartbeatAt: now,
        },
  });
}

export async function handleMedicationIntakeImport(
  job: Job<MedicationIntakeImportQueuePayload>,
): Promise<JobOutcome> {
  try {
    const result = await workMedicationIntakeImport(
      job.data.jobId,
      jobBudget([job]),
    );
    // Out of time before the last chunk: fail the delivery so pg-boss
    // retries it, and the retry resumes from the committed progress.
    if (result === "stopped") {
      return jobFailed(
        "stopped before the last chunk; the retry resumes",
        undefined,
        { stopped_early: true },
      );
    }
    // A null result is a delivery that found the row already terminal or gone.
    // There was nothing left to import, which is an absence of work rather
    // than a failure to do it.
    return result === null
      ? jobDone({ finalized: false })
      : jobDone({
          finalized: true,
          imported: result.imported,
          skipped: result.skipped,
        });
  } catch (error) {
    await recordWorkerFailure(job, error);
    throw error;
  }
}
