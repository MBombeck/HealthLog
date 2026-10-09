/**
 * Import a dose history exported from another medication tracker.
 *
 * The existing per-medication import takes a hand-written list of dates and
 * times for one medication. That is what a self-hoster with a ten-column,
 * 3,395-row export covering sixteen medications was left translating by hand,
 * guessing at what each field meant. This route reads that file's own shape, so
 * nobody has to.
 *
 * What the shape earns it: the export keeps the scheduled time and the time the
 * dose was actually taken in two separate columns, which is exactly the pair
 * `MedicationIntakeEvent` already models as `scheduledFor` + `takenAt`. That
 * distinction is the first casualty of translating a file by hand, and it is the
 * one that decides whether a dose reads as on time or late for the rest of its
 * life.
 *
 * Body is the file's raw text — `text/csv` for the ten-column export,
 * `application/json` for the documented JSON shape. Capped at 16 MB, the same
 * ceiling the measurement CSV import carries.
 *
 * `?dryRun=1` parses, matches every row against the record, and returns the
 * whole verdict WITHOUT writing: how many rows land, how many are refused and
 * for which reason, which medication names match nothing. A bulk import of years
 * of history should be inspectable before it happens.
 *
 * The write itself runs on the same background job the per-medication import
 * uses — chunked, heartbeated, resumable, with the rollup recompute chunked
 * behind it. A path that works on 28 rows and dies on 30,000 is not an import.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  readBodyText,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import {
  groupMedicationImportSkips,
  totalMedicationImportSkips,
  type MedicationImportPayload,
  type MedicationImportProgress,
} from "@/lib/jobs/medication-intake-import";
import { annotate } from "@/lib/logging/context";
import { admitIntakeImportJob } from "@/lib/medications/intake-import-admission";
import {
  parseAutoExportCsv,
  parseAutoExportJson,
} from "@/lib/medications/import/auto-export-parse";
import {
  planAutoExportImport,
  type AutoExportPlan,
} from "@/lib/medications/import/auto-export-plan";
import { checkRateLimit } from "@/lib/rate-limit";

/** Same ceiling as the measurement CSV import. */
const MAX_BYTES = 16 * 1024 * 1024;

/**
 * Rows the importer will queue in one submission.
 *
 * The write loop reads the whole payload out of the job row on every chunk, so
 * the cost of a submission grows with rows × chunks. At 30,000 rows that is a
 * few hundred megabytes of read across a couple of hundred short transactions —
 * slow but bounded, heartbeated, and resumable. Beyond it the shape stops being
 * the right one, and saying so is better than accepting a file that then crawls.
 */
const MAX_QUEUED_ROWS = 30_000;

/**
 * Names echoed back so the person can act on them. Bounded: an unmatched name is
 * a hint, and a file naming five hundred unknown medications needs a different
 * conversation than a longer list.
 */
const MAX_NAMES_REPORTED = 50;

/** Blast-radius bucket shared with every other bulk import surface. */
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

function cap(names: readonly string[]): string[] {
  return names.slice(0, MAX_NAMES_REPORTED);
}

/** The file-level verdict, identical for a dry run and a real submission. */
function describePlan(plan: AutoExportPlan) {
  return {
    rowsRead: plan.rowsRead,
    queued: plan.entries.length,
    refused: totalMedicationImportSkips(plan.skippedByReason),
    refusedByReason: groupMedicationImportSkips(plan.skippedByReason),
    unmatchedMedications: cap(plan.unmatchedMedications),
    ambiguousMedications: cap(plan.ambiguousMedications),
    mirroredMedications: cap(plan.mirroredMedications),
    unknownColumns: cap(plan.unknownColumns),
    codingsNotRead: plan.csvCodingsIgnored,
    fromArchivedMedications: plan.fromArchivedMedications,
  };
}

export const POST = apiHandler(async (request: NextRequest) => {
  // v1.37.0 — MANAGE. The whole-regimen form of the per-medication import:
  // same worker, same additive-with-skip-duplicates properties, same honest
  // `IMPORT` provenance. C9: the kickoff audit row below joins the job by id,
  // so work that outlives the grant is still attributable.
  const { user, actor } = await requireRecordAuth("manage", "medications");
  const dryRunParam = new URL(request.url).searchParams.get("dryRun");
  const dryRun = dryRunParam === "1" || dryRunParam === "true";
  annotate({
    action: { name: "medication.intake.history.import" },
    meta: { dry_run: dryRun },
  });

  // v1.37.0 — C1: keyed on the ACTOR. The bucket is shared with the other
  // import surfaces, so keying it on the record would let a manager consume
  // the owner's hourly import budget.
  const rl = await checkRateLimit(
    `import:${actor.id}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError(`Maximum ${RATE_LIMIT_MAX} imports per hour`, 429);
  }

  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  const isJson = contentType.includes("application/json");
  const isText =
    contentType.includes("text/csv") || contentType.includes("text/plain");
  if (!isJson && !isText) {
    return apiError("Content-Type must be text/csv or application/json", 415);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
    return apiError("File exceeds the 16 MB limit", 413);
  }
  // Counted while it is read, so a body without a Content-Length cannot run
  // past the cap before the check.
  let text: string;
  try {
    const read = await readBodyText(request, MAX_BYTES);
    if (read.tooLarge) return apiError("File exceeds the 16 MB limit", 413);
    text = read.text;
  } catch {
    return apiError("Could not read the request body", 400);
  }

  const parsed = isJson ? parseAutoExportJson(text) : parseAutoExportCsv(text);
  if (parsed.fatal) {
    annotate({
      action: { name: "medication.intake.history.import.refused" },
      meta: { reason: parsed.fatal.reason },
    });
    // The reason travels as a machine-readable code so the client can render the
    // sentence that names the actual problem — a JSON export that carries no
    // intake time needs a different answer than a truncated file.
    return apiError("The file could not be read", 422, {
      errorCode: parsed.fatal.reason,
      ...(parsed.fatal.detail === undefined
        ? {}
        : { detail: parsed.fatal.detail }),
    });
  }

  const medications = await prisma.medication.findMany({
    where: { userId: user.id },
    // Every medication, active or not: a dose taken in 2023 belongs to the
    // medication whether or not the person has since stopped taking it.
    select: { id: true, name: true, externalSource: true },
  });
  const plan = planAutoExportImport(parsed, medications);

  if (plan.entries.length > MAX_QUEUED_ROWS) {
    return apiError(
      `The file holds ${plan.entries.length} importable rows. The limit is ${MAX_QUEUED_ROWS} per import`,
      422,
      { errorCode: "too_many_rows" },
    );
  }

  const file = describePlan(plan);
  if (dryRun) {
    return apiSuccess({ dryRun: true, jobId: null, statusUrl: null, file });
  }

  const payload: MedicationImportPayload = { entries: plan.entries };
  // Rows refused before the queue are seeded into the progress the worker
  // advances, so the count the person reads at the end covers the whole file and
  // not just the part that reached the database.
  const progress: MedicationImportProgress = {
    processed: 0,
    total: plan.entries.length,
    imported: 0,
    skippedByReason: plan.skippedByReason,
    skipDetails: plan.skipDetails,
    skippedDetailsOmitted: plan.skippedDetailsOmitted,
    touchedDays: [],
    rollupProcessed: 0,
  };

  const admission = await admitIntakeImportJob({
    recordUserId: user.id,
    actorUserId: actor.id,
    medicationId: null,
    payload,
    progress,
    ipAddress: getClientIp(request),
  });
  if (!admission.admitted) {
    return apiError("A dose-history import is already in progress", 409);
  }
  if (!admission.enqueued) {
    return apiError("Background worker is not available", 503);
  }
  const { jobId, bossJobId } = admission;

  const statusUrl = `/api/medications/intake/dose-history-import/${jobId}/status`;

  await auditLog("medication.intake.history.import.kickoff", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      jobId,
      bossJobId,
      rowsRead: file.rowsRead,
      queued: file.queued,
      refused: file.refused,
    },
  });
  annotate({
    action: { name: "medication.intake.history.import.kickoff" },
    meta: {
      job_id: jobId,
      rows_read: file.rowsRead,
      queued: file.queued,
      refused: file.refused,
    },
  });

  return apiSuccess(
    {
      dryRun: false,
      jobId,
      status: "queued" as const,
      statusUrl,
      file,
    },
    202,
  );
});
