/**
 * v1.18.9 — POST /api/labs/ocr/commit
 *
 * Writes ONLY the rows the human confirmed on the review screen. Each row
 * resolves-or-mints a user-scoped biomarker by `(userId, lower(analyte))` —
 * exactly like the manual lab-write path — then creates a `LabResult` with
 * `source: "OCR"`. A row that now duplicates a live reading (re-checked at
 * commit time) is skipped rather than written. Idempotent (Idempotency-Key).
 *
 * `userId` is always narrowed from the session — never a body field. The write
 * `data` object is built field-by-field (no mass assignment).
 *
 * The response carries the resolved `outcome` alongside the two lists. The
 * dialog used to raise a green toast on any 200, so a re-scan in which every
 * confirmed row turned out to be a duplicate reported "saved 0 readings" under
 * a tick. The verdict is the server's to compute; the dialog only renders it.
 */
import { NextRequest } from "next/server";
import { fireAndForget } from "@/lib/logging/fire-and-forget";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, getClientIp, sanitiseZodIssues } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { invalidateUserHealthScore } from "@/lib/cache/invalidate";
import { withIdempotency } from "@/lib/idempotency";
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import { emitDataArrival } from "@/lib/arrivals/emit-shared";
import { rememberImportAlias } from "@/lib/labs/biomarker-aliases";
import {
  addAliasToIndex,
  loadMarkerIndex,
  resolveInIndex,
  type IndexedMarker,
} from "@/lib/labs/biomarker-resolve";
import { resolveOrMintBiomarker } from "@/lib/labs/biomarker-store";
import { readingInMarkerUnit } from "@/lib/labs/reading-conversion";
import { sameLabUnit } from "@/lib/labs/unit-normalise";
import { parseReferenceRange } from "@/lib/labs/parse-reference-range";
import { serialiseLabResult } from "@/lib/labs/serialise";
import {
  linkOcrLabsToVaultDocument,
  type InsertedLabForLink,
} from "@/lib/labs/vault-link";
import { linkTargets } from "@/lib/links";
import { annotate } from "@/lib/logging/context";
import { classifyWrittenOutcome } from "@/lib/outcome/written-outcome";
import {
  ocrCommitSchema,
  type OcrCommitRow,
  type OcrSkippedRowDto,
} from "@/lib/validations/labs-ocr";
import {
  labReadingDay,
  labReadingDaySearchRange,
} from "@/lib/labs/reading-day";
import { resolveUserTimezone } from "@/lib/tz/resolver";

export const POST = apiHandler(withIdempotency<[NextRequest]>(commitOcrRows));

/**
 * True when a live reading already records this analyte+day+value. The day
 * is the reading's calendar day (`labReadingDay`), not its UTC day: a
 * hand-entered morning draw east of UTC sits on the previous UTC day, and the
 * UTC window let the scan of the same report write it again.
 */
async function isDuplicate(
  userId: string,
  row: OcrCommitRow,
  tz: string,
  /** The marker the row resolves to, when it resolves to one already. */
  biomarkerId: string | null,
): Promise<boolean> {
  const day = labReadingDay(new Date(row.takenAt), tz);
  const rows = await prisma.labResult.findMany({
    where: {
      userId,
      deletedAt: null,
      // The printed name, or a reading already filed under the marker this
      // name resolves to: an earlier report may have spelled it another way.
      OR: [
        { analyte: { equals: row.analyte.trim(), mode: "insensitive" } },
        ...(biomarkerId ? [{ biomarkerId }] : []),
      ],
      takenAt: labReadingDaySearchRange(day),
    },
    select: {
      value: true,
      valueText: true,
      sourceValue: true,
      sourceUnit: true,
      takenAt: true,
    },
    take: 100,
  });
  const candidates = rows.filter((c) => labReadingDay(c.takenAt, tz) === day);
  for (const c of candidates) {
    if (row.value !== undefined && c.value !== null && c.value === row.value) {
      return true;
    }
    // A reading stored converted holds the value in the marker's unit, so the
    // same scan committed again no longer equals it. What the report printed is
    // kept beside it: the same number in the same unit is the same reading.
    if (
      row.value !== undefined &&
      row.unit !== undefined &&
      c.sourceValue !== null &&
      c.sourceValue === row.value &&
      c.sourceUnit !== null &&
      sameLabUnit(c.sourceUnit, row.unit)
    ) {
      return true;
    }
    if (
      row.valueText !== undefined &&
      c.valueText !== null &&
      c.valueText.trim().toLowerCase() === row.valueText.trim().toLowerCase()
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Stable in-batch dedup key for a confirmed row: analyte (lower+trim) + the
 * reading's calendar day + the value dimension that `isDuplicate` matches on. Two rows in ONE document
 * that resolve to the same key are the same reading; only the first is written.
 * Mirrors the `isDuplicate` match semantics so in-batch dedup no longer depends
 * on a prior row autocommitting before the next row's live query runs.
 */
function inBatchKey(
  row: OcrCommitRow,
  tz: string,
  biomarkerId: string | null,
): string {
  // Two spellings of one marker in one document are one marker (D1223).
  const analyte = biomarkerId
    ? `bm:${biomarkerId}`
    : row.analyte.trim().toLowerCase();
  const dayKey = labReadingDay(new Date(row.takenAt), tz);
  const valuePart =
    row.value !== undefined
      ? `n:${row.value}`
      : row.valueText !== undefined
        ? `t:${row.valueText.trim().toLowerCase()}`
        : "∅";
  return `${analyte}|${dayKey}|${valuePart}`;
}

async function commitOcrRows(request: NextRequest) {
  const { user } = await requireAuth();

  // OCR_MAX_ROWS rows at every field's longest bound run past 256 KB; 512
  // keeps a full report in one body with room to spare.
  const parsed = await parseJsonBody(request, ocrCommitSchema, {
    maxBytes: 512 * 1024,
    action: "labs.ocr.commit.validation-failed",
    countIssues: true,
    onInvalid: (error) => {
      // Free-text analyte / unit could land in a Zod issue message — strip values.
      const auditIssues = sanitiseZodIssues(error.issues, {
        stripValuesFromMessage: true,
      });
      auditLog("labs.ocr.commit.validation-failed", {
        userId: user.id,
        details: { issues: auditIssues },
      }).catch(() => {});
    },
  });
  if (!parsed.ok) return parsed.error;

  const inserted: ReturnType<typeof serialiseLabResult>[] = [];
  const skipped: OcrSkippedRowDto[] = [];
  // The rows actually written, kept for the vault cross-link so a re-commit
  // (every row a duplicate → nothing inserted) links nothing new.
  const linkable: InsertedLabForLink[] = [];
  // Tracks the keys already written in THIS request so an in-document duplicate
  // is caught even before the prior row is visible to a live query. The
  // mint-then-create on a mid-row failure can leave an orphan biomarker, which
  // is benign and self-healing — the manual lab-write path mints the same way.
  const writtenInBatch = new Set<string>();

  const tz = await resolveUserTimezone(user.id);
  // v1.43 — the account's markers and aliases, loaded once: every row
  // resolves its name against them (name, alias, catalog abbreviation) the
  // way the review did, and a marker minted for one row is found by the next.
  const markerIndex = await loadMarkerIndex(prisma, user.id);
  let aliasesRemembered = 0;
  for (const row of parsed.data.rows) {
    const isQualitative = row.valueText !== undefined;

    // The marker the person picked on the review screen, if they picked one.
    let chosen: IndexedMarker | null = null;
    if (row.biomarkerId) {
      chosen =
        markerIndex.markers.find((m) => m.id === row.biomarkerId) ?? null;
      if (!chosen) {
        skipped.push({
          analyte: row.analyte.trim(),
          reason: "unknown_biomarker",
        });
        continue;
      }
      // The choice is remembered, so the next report spelled this way
      // matches on its own.
      if (row.rememberAlias !== false) {
        const wrote = await rememberImportAlias(
          prisma,
          user.id,
          chosen,
          row.analyte,
        );
        if (wrote) {
          addAliasToIndex(markerIndex, chosen.id, row.analyte);
          aliasesRemembered += 1;
        }
      }
    }
    const resolvedId =
      chosen?.id ??
      resolveInIndex(
        markerIndex,
        row.analyte,
        isQualitative ? null : (row.unit ?? null),
      )?.marker.id ??
      null;

    const key = inBatchKey(row, tz, resolvedId);
    if (
      writtenInBatch.has(key) ||
      (await isDuplicate(user.id, row, tz, resolvedId))
    ) {
      skipped.push({ analyte: row.analyte.trim(), reason: "duplicate" });
      continue;
    }

    // The window the scan read off the report. The confirmed numeric bounds
    // win over a re-parse of the string (the human may have corrected them on
    // the review screen); the string rides along either way.
    const printed = parseReferenceRange(row.referenceText, row.unit);
    const sourceLow = row.referenceLow ?? printed?.low ?? null;
    const sourceHigh = row.referenceHigh ?? printed?.high ?? null;
    const sourceText = printed?.text ?? null;
    const biomarker = chosen
      ? chosen
      : await resolveOrMintBiomarker(
          user.id,
          {
            analyte: row.analyte,
            // A qualitative reading has no numeric unit / range.
            unit: isQualitative ? (row.unit ?? "") : (row.unit as string),
            referenceLow: isQualitative ? null : sourceLow,
            referenceHigh: isQualitative ? null : sourceHigh,
            panel: row.panel ?? null,
          },
          { index: markerIndex },
        );

    // The marker's unit is the one the reading is stored under. A row that
    // states another unit is converted when the marker's analyte is known and
    // the registry has the pair, with what the report printed kept beside it;
    // otherwise it cannot be written: the number would be kept under a unit it
    // is not in. The review screen marks such a row before Save; this is the
    // backstop for a client that did not, and for a marker whose unit changed
    // between the scan and the commit. A freshly minted marker adopted this
    // row's unit, so it cannot disagree.
    let storedValue = row.value ?? null;
    let storedSourceLow = isQualitative ? null : sourceLow;
    let storedSourceHigh = isQualitative ? null : sourceHigh;
    let convertedFrom: { sourceValue: number; sourceUnit: string } | null =
      null;
    if (!isQualitative && row.value !== undefined) {
      const reading = await readingInMarkerUnit(prisma, {
        marker: biomarker,
        value: row.value,
        unit: row.unit,
        sourceReferenceLow: storedSourceLow,
        sourceReferenceHigh: storedSourceHigh,
      });
      if (!reading.ok) {
        skipped.push({ analyte: row.analyte.trim(), reason: "unit_mismatch" });
        continue;
      }
      storedValue = reading.value;
      storedSourceLow = reading.sourceReferenceLow;
      storedSourceHigh = reading.sourceReferenceHigh;
      if (reading.converted) {
        convertedFrom = {
          sourceValue: reading.sourceValue,
          sourceUnit: reading.sourceUnit,
        };
      }
    }

    // Field-by-field — never spread the parsed row. The row stamps the resolved
    // catalog name/unit/range as historical truth and keeps the FK.
    const created = await prisma.labResult.create({
      data: {
        userId: user.id,
        biomarkerId: biomarker.id,
        panel: biomarker.panel,
        analyte: biomarker.name,
        value: storedValue,
        valueText: row.valueText ?? null,
        unit: biomarker.unit,
        sourceValue: convertedFrom?.sourceValue ?? null,
        sourceUnit: convertedFrom?.sourceUnit ?? null,
        referenceLow: biomarker.lowerBound,
        referenceHigh: biomarker.upperBound,
        sourceReferenceLow: storedSourceLow,
        sourceReferenceHigh: storedSourceHigh,
        sourceReferenceText: isQualitative ? null : sourceText,
        takenAt: row.takenAt,
        source: "OCR",
        noteEncrypted: null,
      },
    });

    writtenInBatch.add(key);
    // A freshly minted marker is now the row's; key the batch on it too.
    writtenInBatch.add(inBatchKey(row, tz, biomarker.id));
    inserted.push(serialiseLabResult(created, biomarker));
    linkable.push({
      labResultId: created.id,
      analyte: created.analyte,
      value: created.value,
      valueText: created.valueText,
      unit: created.unit,
      referenceLow: created.referenceLow,
      referenceHigh: created.referenceHigh,
      takenAt: created.takenAt,
    });
  }
  if (inserted.length > 0) invalidateUserHealthScore(user.id);

  // Cross-link the freshly inserted labs to the vault document the client
  // filed the scanned bytes into. Best-effort: the labs are the authoritative
  // write, so a link failure (module off, foreign / missing document) never
  // fails the commit. Owner + module checks live inside the linker.
  if (parsed.data.documentId && linkable.length > 0) {
    await linkOcrLabsToVaultDocument(
      user.id,
      parsed.data.documentId,
      linkable,
    ).catch(() => {});
    // v1.43 — the stored relation as well: each written result points at the
    // report it was read from (`lab_result_document_links`), so the result's
    // and the document's `related` lists name each other. Best-effort for the
    // same reason; the service narrows both ends to this record.
    await linkTargets(prisma, {
      userId: user.id,
      sourceKind: "document",
      sourceId: parsed.data.documentId,
      targetKind: "labResult",
      targetIds: linkable.map((row) => row.labResultId),
    }).catch(() => {});
  }

  // The visit the review step offered, if it offered one. ONE LINK PER RESULT
  // ROW rather than one for the panel: a marker re-run on a different day
  // belongs to its own visit, which is exactly why the join is m:n and not a
  // scalar column on the result. Best-effort like the vault cross-link — the
  // readings are the authoritative write and must not be lost to a link that
  // could not be made. The link service narrows both ends to this record, so
  // an id naming nothing writes nothing.
  if (parsed.data.encounterId && linkable.length > 0) {
    await linkTargets(prisma, {
      userId: user.id,
      sourceKind: "encounter",
      sourceId: parsed.data.encounterId,
      targetKind: "labResult",
      targetIds: linkable.map((row) => row.labResultId),
    }).catch(() => {});
  }

  await auditLog("labs.ocr.commit", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      count: inserted.length,
      skipped: skipped.length,
      aliasesRemembered,
    },
  });

  annotate({
    action: { name: "labs.ocr.committed" },
    meta: {
      inserted: inserted.length,
      skipped: skipped.length,
      linkedVisit: parsed.data.encounterId ? 1 : 0,
    },
  });

  // A lab panel just landed — resolve any "annual blood panel" reminders now
  // rather than waiting on the cron. Fire-and-forget.
  if (inserted.length > 0) {
    fireAndForget(() => enqueueReminderSatisfy(user.id), {
      action: "reminder.satisfy.enqueue",
    });

    // v1.31.0 — the labs arm of the data-arrival spine. This seam DOES know
    // its whole panel (the commit builds a per-row `linkable` list), so it
    // emits once with the newest draw date and the true inserted count rather
    // than leaning on the singleton key to collapse per-row emits.
    const newestTakenAt = linkable.reduce<Date | null>(
      (acc, r) => (!acc || r.takenAt > acc ? r.takenAt : acc),
      null,
    );
    if (newestTakenAt) {
      void emitDataArrival({
        userId: user.id,
        kind: "labs_panel",
        newestSampleAt: newestTakenAt,
        insertedCount: inserted.length,
        source: "ocr",
      }).catch(() => {});
    }
  }

  return apiSuccess({
    inserted,
    skipped,
    outcome: classifyWrittenOutcome({
      written: inserted.length,
      skipped: skipped.length,
    }),
  });
}
