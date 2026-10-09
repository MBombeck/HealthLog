import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  readBodyText,
} from "@/lib/api-response";
import { encryptNote, readNote } from "@/lib/crypto/note-cipher";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextRequest } from "next/server";

import {
  parseCsvMeasurements,
  type CsvRowResult,
} from "@/lib/import/csv-measurements";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";
import type {
  MeasurementType,
  GlucoseContext,
} from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";
import type { NormalisedMeasurementRow } from "@/lib/import/csv-measurements";
import { emitInsertedMeasurementArrivals } from "@/lib/arrivals/measurement-emit";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";

/** Keys per dedup probe: well under Postgres's bind-parameter cap. */
const LOOKUP_CHUNK = 1000;
/** Rows per create call / per update batch transaction. */
const WRITE_CHUNK = 200;

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Group rows' probe keys by measurement type, de-duplicated. */
function groupByType<K>(
  rows: ReadonlyArray<{ row: NormalisedMeasurementRow }>,
  keyOf: (r: { row: NormalisedMeasurementRow }) => K,
): Map<MeasurementType, K[]> {
  const byType = new Map<MeasurementType, Map<string, K>>();
  for (const r of rows) {
    const type = r.row.type as MeasurementType;
    const key = keyOf(r);
    const bucket = byType.get(type) ?? new Map<string, K>();
    bucket.set(key instanceof Date ? String(key.getTime()) : String(key), key);
    byType.set(type, bucket);
  }
  return new Map([...byType].map(([type, keys]) => [type, [...keys.values()]]));
}

/**
 * True when a stored IMPORT row already holds exactly what this line would
 * write: same value, unit, instant, glucose context and note, and live. Such
 * a line is a duplicate, not an update.
 */
function sameStoredRow(
  stored: {
    value: number;
    unit: string;
    measuredAt: Date;
    glucoseContext: GlucoseContext | null;
    notes: string | null;
    notesEncrypted: Uint8Array | null;
    deletedAt: Date | null;
  },
  m: NormalisedMeasurementRow,
): boolean {
  return (
    stored.deletedAt === null &&
    stored.value === m.value &&
    stored.unit === m.unit &&
    stored.measuredAt.getTime() === m.measuredAt.getTime() &&
    stored.glucoseContext ===
      ((m.glucoseContext as GlucoseContext | undefined) ?? null) &&
    readNote(stored.notesEncrypted, stored.notes) === (m.notes || null)
  );
}

/**
 * CSV measurement import (v1.17.1).
 *
 * The cold-start escape hatch for self-hosters migrating from a spreadsheet
 * or another tracker. Reuses the `/api/import` write loop + rollup re-fold;
 * the parse + per-row validation + unit conversion lives in the pure
 * `parseCsvMeasurements` module so it is unit-tested without a database.
 *
 * Body is `text/csv` (or `text/plain`) raw text — NOT JSON. Capped at 16 MB
 * (the same ceiling as the JSON import; a 16 MB CSV is > 100 000 rows). Rows
 * beyond the 10 000 ceiling are rejected so the rollup re-fold stays bounded.
 *
 * `?dryRun=1` parses + validates + returns the per-row status envelope
 * WITHOUT writing — a trust win for a bulk cold-start import.
 *
 * Response: `{ inserted, updated, skipped, total, dryRun, rows: [{line,
 * status, reason}] }`, mirroring the batch route's per-entry envelope.
 */

const MAX_CSV_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 10000;

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "import.csv.upload" } });

  const dryRun =
    new URL(request.url).searchParams.get("dryRun") === "1" ||
    new URL(request.url).searchParams.get("dryRun") === "true";

  // Same blast-radius reasoning as the JSON import — share the bucket so a
  // CSV upload counts against the same 5/hour quota.
  const rl = await checkRateLimit(`import:${user.id}`, 5, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 5 imports per hour", 429);
  }

  // Raw text read with an explicit byte cap — `safeJson` is JSON-only, so we
  // enforce the same `maxBytes` ceiling here against the Content-Length and
  // the materialised body.
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CSV_BYTES) {
    return apiError("CSV exceeds the 16 MB limit", 413);
  }
  // Counted while it is read, so a body without a Content-Length cannot run
  // past the cap before the check.
  let text: string;
  try {
    const read = await readBodyText(request, MAX_CSV_BYTES);
    if (read.tooLarge) return apiError("CSV exceeds the 16 MB limit", 413);
    text = read.text;
  } catch {
    return apiError("Could not read the request body", 400);
  }

  const parsed = parseCsvMeasurements(text);
  if (parsed.fatal) {
    return apiError(parsed.fatal.message, 422);
  }

  const okRows = parsed.rows.filter(
    (r): r is CsvRowResult & { row: NonNullable<CsvRowResult["row"]> } =>
      r.status === "ok" && r.row !== undefined,
  );
  if (okRows.length > MAX_ROWS) {
    return apiError(
      `CSV has ${okRows.length} valid rows. The limit is ${MAX_ROWS} per import`,
      422,
    );
  }

  const userId = user.id;
  let inserted = 0;
  let updated = 0;
  let skipped = parsed.rows.filter((r) => r.status === "skipped").length;

  const touchedMeasurements: Array<{
    type: MeasurementType;
    measuredAt: Date;
  }> = [];

  // Per-line write outcome for rows that reached the DB. Keyed by source line
  // so the response envelope can surface `inserted` / `updated` / `duplicate`
  // distinctly without polluting the parse-time `CsvRowReason`.
  const writeOutcome = new Map<number, "inserted" | "updated" | "duplicate">();

  if (!dryRun) {
    // Batched write. The previous shape ran one serial `upsert` (or `create`)
    // per accepted row — N round-trips for an N-row file, which on a
    // few-thousand-row import approaches the request timeout. This adopts the
    // fast shape `/measurements/batch` uses: pre-fetch the existing rows under
    // the IMPORT source in one query per dedup-key shape, partition into bulk
    // insert / update sets, then `createMany` + grouped `updateMany`. The
    // per-line inserted/updated/duplicate envelope is reconstructed from the
    // partition, so the response contract is unchanged.

    const buildCreateData = (
      m: NormalisedMeasurementRow,
    ): Prisma.MeasurementCreateManyInput => ({
      userId,
      type: m.type as MeasurementType,
      value: m.value,
      unit: m.unit,
      source: "IMPORT",
      ...(m.externalId ? { externalId: m.externalId } : {}),
      measuredAt: m.measuredAt,
      notes: null,
      notesEncrypted: encryptNote(m.notes ?? null),
      glucoseContext: (m.glucoseContext as GlucoseContext | undefined) ?? null,
    });

    const extRows = okRows.filter((r) => r.row.externalId);
    const plainRows = okRows.filter((r) => !r.row.externalId);

    // --- externalId rows: idempotent upsert on
    // (userId, type, source=IMPORT, externalId). One probe per type and chunk
    // fetches every pre-existing key with the columns an update would write,
    // so a row whose stored values already match is left alone.
    const extExisting = new Map<
      string,
      {
        value: number;
        unit: string;
        measuredAt: Date;
        glucoseContext: GlucoseContext | null;
        notes: string | null;
        notesEncrypted: Uint8Array | null;
        deletedAt: Date | null;
      }
    >();
    for (const [type, ids] of groupByType(
      extRows,
      (r) => r.row.externalId as string,
    )) {
      for (const chunk of chunked(ids, LOOKUP_CHUNK)) {
        const found = await prisma.measurement.findMany({
          where: {
            userId,
            source: "IMPORT",
            type,
            externalId: { in: chunk },
          },
          select: {
            externalId: true,
            value: true,
            unit: true,
            measuredAt: true,
            glucoseContext: true,
            notes: true,
            notesEncrypted: true,
            deletedAt: true,
          },
        });
        for (const row of found) {
          extExisting.set(`${type}::${row.externalId}`, row);
        }
      }
    }

    // Partition in file order, honouring in-file repeats: the first sighting
    // of a brand-new key inserts, every later sighting (or any sighting of a
    // key already in the DB) updates in place. The last value for a key wins,
    // matching the old sequential-upsert overwrite. Insert/update maps are
    // keyed by (type, externalId) so a repeated key collapses to one write.
    // A key already in the DB whose stored row equals this line is a
    // duplicate: no write, reported like the natural-key duplicates below.
    // That is what makes re-importing the same file cheap — a second upload
    // of an unchanged 9 000-row export writes nothing.
    const seenExt = new Set<string>();
    const extInserts = new Map<string, NormalisedMeasurementRow>();
    const extUpdates = new Map<string, NormalisedMeasurementRow>();
    for (const result of extRows) {
      const m = result.row;
      const key = `${m.type}::${m.externalId}`;
      const stored = extExisting.get(key);
      if (stored && !extUpdates.has(key) && sameStoredRow(stored, m)) {
        skipped++;
        writeOutcome.set(result.line, "duplicate");
        continue;
      }
      if (stored) {
        extUpdates.set(key, m);
        updated++;
        writeOutcome.set(result.line, "updated");
      } else if (seenExt.has(key)) {
        // New-to-DB key seen again in this file: still a single create with
        // the latest value, but this line reads as an update just as the
        // sequential upsert did.
        extInserts.set(key, m);
        updated++;
        writeOutcome.set(result.line, "updated");
      } else {
        seenExt.add(key);
        extInserts.set(key, m);
        inserted++;
        writeOutcome.set(result.line, "inserted");
      }
      touchedMeasurements.push({
        type: m.type as MeasurementType,
        measuredAt: m.measuredAt,
      });
      // An update that moves the reading to another instant leaves the day
      // it came from: that day is re-folded too, or the old day keeps a
      // reading that no longer exists there.
      if (stored && stored.measuredAt.getTime() !== m.measuredAt.getTime()) {
        touchedMeasurements.push({
          type: m.type as MeasurementType,
          measuredAt: stored.measuredAt,
        });
      }
    }

    // --- externalId-less rows: create-only, deduped on the natural unique key
    // (userId, type, measuredAt, source=IMPORT, sleepStage=null). A collision
    // — against the DB or an earlier row in this same file — is a duplicate,
    // never an overwrite (each sample is a canonical reading). Probed per type
    // and chunk, like the externalId rows.
    const plainExistingSet = new Set<string>();
    for (const [type, instants] of groupByType(
      plainRows,
      (r) => r.row.measuredAt,
    )) {
      for (const chunk of chunked(instants, LOOKUP_CHUNK)) {
        const found = await prisma.measurement.findMany({
          where: {
            userId,
            source: "IMPORT",
            type,
            measuredAt: { in: chunk },
          },
          select: { measuredAt: true },
        });
        for (const row of found) {
          plainExistingSet.add(`${type}::${row.measuredAt.getTime()}`);
        }
      }
    }
    const seenPlain = new Set<string>();
    const plainInserts: NormalisedMeasurementRow[] = [];
    for (const result of plainRows) {
      const m = result.row;
      const key = `${m.type}::${m.measuredAt.getTime()}`;
      if (plainExistingSet.has(key) || seenPlain.has(key)) {
        skipped++;
        writeOutcome.set(result.line, "duplicate");
      } else {
        seenPlain.add(key);
        plainInserts.push(m);
        inserted++;
        writeOutcome.set(result.line, "inserted");
        touchedMeasurements.push({
          type: m.type as MeasurementType,
          measuredAt: m.measuredAt,
        });
      }
    }

    // Bulk write in bounded chunks, each its own short transaction.
    //
    // This used to be ONE interactive transaction around every create chunk
    // AND one `updateMany` per re-imported row. Re-importing a 9 000-row file
    // with an externalId column meant 9 000 serial updates inside it, which
    // outlived Prisma's 5 s interactive-transaction timeout and ended in a
    // 500. A chunk now commits on its own: creates go through
    // `createManyAndReturn` (skipDuplicates absorbs a concurrent
    // double-submit), updates through one batch transaction per chunk. A
    // failure part-way leaves the earlier chunks written, and that is safe to
    // retry: a re-upload of the same file skips what landed (unchanged
    // externalId rows and natural-key duplicates are not written again).
    const toCreate: Prisma.MeasurementCreateManyInput[] = [
      ...[...extInserts.values()].map(buildCreateData),
      ...plainInserts.map(buildCreateData),
    ];
    let createdCount = 0;
    const createdRows: Array<{
      id: string;
      type: MeasurementType;
      measuredAt: Date;
    }> = [];
    // The re-fold runs whatever happens to the writes. A chunk that fails
    // part-way leaves the earlier chunks written, and a retry reads those
    // rows as duplicates and touches nothing: without the re-fold here their
    // days would keep the rollups from before the import for good. Re-folding
    // a (type, day) nothing landed on is harmless.
    try {
      for (const chunk of chunked(toCreate, WRITE_CHUNK)) {
        const rows = await prisma.measurement.createManyAndReturn({
          data: chunk,
          skipDuplicates: true,
          select: { id: true, type: true, measuredAt: true },
        });
        createdRows.push(...rows);
        createdCount += rows.length;
      }
      for (const chunk of chunked([...extUpdates.values()], WRITE_CHUNK)) {
        await prisma.$transaction(
          chunk.map((m) =>
            prisma.measurement.updateMany({
              where: {
                userId,
                source: "IMPORT",
                type: m.type as MeasurementType,
                externalId: m.externalId as string,
              },
              data: {
                value: m.value,
                unit: m.unit,
                measuredAt: m.measuredAt,
                notes: null,
                notesEncrypted: encryptNote(m.notes ?? null),
                glucoseContext:
                  (m.glucoseContext as GlucoseContext | undefined) ?? null,
                // No-op on a live row, a deliberate RESURRECTION on a
                // tombstoned one — IMPORT rows are re-importable by design, so
                // a re-imported externalId brings the row back (mirrors the
                // source-owned sync resurrect rule).
                deletedAt: null,
              },
            }),
          ),
        );
      }

      void emitInsertedMeasurementArrivals(
        userId,
        createdRows,
        "csv_import",
      ).catch(() => {});
      void maybeEnqueueMorningRefresh(
        userId,
        createdRows
          .filter((row) => row.type === "SLEEP_DURATION")
          .map((row) => row.measuredAt),
      ).catch(() => {});

      // Reconcile `inserted` against what `createMany` actually wrote
      // (mirrors the batch route's raced-duplicate downgrade). Under
      // `skipDuplicates` a conflicting row is silently absorbed — the key is
      // present in the table either way, so we cannot identify the SPECIFIC
      // raced lines; we only need the counters and per-line statuses to sum
      // to the truth. Downgrade enough `inserted` lines to `duplicate` so
      // the envelope matches the DB write count.
      const racedDuplicates = toCreate.length - createdCount;
      if (racedDuplicates > 0) {
        let downgraded = 0;
        for (const [line, outcome] of writeOutcome) {
          if (downgraded >= racedDuplicates) break;
          if (outcome === "inserted") {
            writeOutcome.set(line, "duplicate");
            inserted--;
            skipped++;
            downgraded++;
          }
        }
      }
    } finally {
      // One bounded rollup re-fold per touched (type, day) — a 10 000-row
      // CSV pays at most ~N (type, day) recomputes, not 10 000 per-row hooks
      // — and the status re-warm for the touched types. Best-effort: a
      // populator hiccup never fails the importer.
      await afterMeasurementMutation(userId, touchedMeasurements, "import.csv");
    }

    await auditLog("import.csv.upload", {
      userId,
      ipAddress: getClientIp(request),
      details: { inserted, updated, skipped },
    });
  } else {
    // Dry-run preview: no write ran, so report the projected outcome —
    // every valid parse-`ok` row would insert (an externalId row could land
    // as an update, but that needs a DB read we deliberately skip here).
    inserted = okRows.length;
  }

  const summary = {
    inserted,
    updated,
    skipped,
    total: parsed.rows.length,
    dryRun,
    // Per-row status, mirroring the batch route's per-entry envelope. The
    // normalised payload is stripped — the client only needs line + status.
    // Parse-time `ok` rows are refined by the write outcome: a row that hit a
    // unique-constraint duplicate becomes `skipped`/`duplicate`; an upsert
    // that landed on an existing row becomes `updated`. In `dryRun` mode no
    // write ran, so every parse-`ok` row stays `inserted` (the projected
    // outcome).
    rows: parsed.rows.map((r) => {
      if (r.status === "skipped") {
        return {
          line: r.line,
          status: "skipped" as const,
          ...(r.reason ? { reason: r.reason } : {}),
        };
      }
      const outcome = writeOutcome.get(r.line);
      if (outcome === "duplicate") {
        return {
          line: r.line,
          status: "skipped" as const,
          reason: "duplicate",
        };
      }
      if (outcome === "updated") {
        return { line: r.line, status: "updated" as const };
      }
      return { line: r.line, status: "inserted" as const };
    }),
  };

  annotate({
    meta: {
      import_csv_inserted: inserted,
      import_csv_updated: updated,
      import_csv_skipped: skipped,
      import_csv_dry_run: dryRun,
    },
  });

  return apiSuccess(summary);
});
