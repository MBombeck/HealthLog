/**
 * The batched writer behind `POST /api/import/csv`.
 *
 * The route reads, parses and bounds the file; this module writes its
 * accepted rows. It pre-fetches the existing rows under the IMPORT source in
 * one query per dedup-key shape (per type and chunk), partitions the file
 * into insert and update sets, then writes them with `createManyAndReturn`
 * and grouped `updateMany` in bounded chunks. The per-line
 * inserted / updated / duplicate envelope is reconstructed from the
 * partition. Serial per-row upserts once approached the request timeout on a
 * few-thousand-row file; this is the shape `/measurements/batch` uses.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { encryptNote, readNote } from "@/lib/crypto/note-cipher";
import type { CsvRowResult } from "@/lib/import/csv-measurements";
import type { NormalisedMeasurementRow } from "@/lib/import/csv-measurements";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";
import type {
  GlucoseContext,
  MeasurementType,
  Prisma,
} from "@/generated/prisma/client";
import { emitInsertedMeasurementArrivals } from "@/lib/arrivals/measurement-emit";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";

/** Keys per dedup probe: well under Postgres's bind-parameter cap. */
const LOOKUP_CHUNK = 1000;
/** Rows per create call / per update batch transaction. */
const WRITE_CHUNK = 200;

/** A parse-`ok` line with its normalised row. */
export type CsvOkRow = CsvRowResult & {
  row: NonNullable<CsvRowResult["row"]>;
};

type WriteOutcome = "inserted" | "updated" | "duplicate";

interface StoredImportRow {
  value: number;
  unit: string;
  measuredAt: Date;
  glucoseContext: GlucoseContext | null;
  notes: string | null;
  notesEncrypted: Uint8Array | null;
  deletedAt: Date | null;
}

/** The counts and per-line outcomes of one import, filled as it plans. */
interface CsvTally {
  inserted: number;
  updated: number;
  skipped: number;
  /**
   * Per-line write outcome for rows that reached the DB. Keyed by source
   * line so the response envelope can surface `inserted` / `updated` /
   * `duplicate` distinctly without polluting the parse-time `CsvRowReason`.
   */
  outcome: Map<number, WriteOutcome>;
  touched: Array<{ type: MeasurementType; measuredAt: Date }>;
}

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
  stored: StoredImportRow,
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
 * Rows with an external id: idempotent upsert on
 * `(userId, type, source=IMPORT, externalId)`. One probe per type and chunk
 * fetches every pre-existing key with the columns an update would write, so
 * a row whose stored values already match is left alone.
 *
 * Partitioned in file order, honouring in-file repeats: the first sighting
 * of a brand-new key inserts, every later sighting (or any sighting of a key
 * already in the DB) updates in place. The last value for a key wins,
 * matching the old sequential-upsert overwrite. Insert / update maps are
 * keyed by (type, externalId) so a repeated key collapses to one write. A
 * key already in the DB whose stored row equals this line is a duplicate: no
 * write, reported like the natural-key duplicates. That is what makes
 * re-importing the same file cheap: a second upload of an unchanged
 * 9 000-row export writes nothing.
 */
async function planExternalIdRows(
  userId: string,
  extRows: CsvOkRow[],
  tally: CsvTally,
): Promise<{
  inserts: Map<string, NormalisedMeasurementRow>;
  updates: Map<string, NormalisedMeasurementRow>;
}> {
  const existing = new Map<string, StoredImportRow>();
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
        existing.set(`${type}::${row.externalId}`, row);
      }
    }
  }

  const seen = new Set<string>();
  const inserts = new Map<string, NormalisedMeasurementRow>();
  const updates = new Map<string, NormalisedMeasurementRow>();
  for (const result of extRows) {
    const m = result.row;
    const key = `${m.type}::${m.externalId}`;
    const stored = existing.get(key);
    if (stored && !updates.has(key) && sameStoredRow(stored, m)) {
      tally.skipped++;
      tally.outcome.set(result.line, "duplicate");
      continue;
    }
    if (stored) {
      updates.set(key, m);
      tally.updated++;
      tally.outcome.set(result.line, "updated");
    } else if (seen.has(key)) {
      // New-to-DB key seen again in this file: still a single create with
      // the latest value, but this line reads as an update just as the
      // sequential upsert did.
      inserts.set(key, m);
      tally.updated++;
      tally.outcome.set(result.line, "updated");
    } else {
      seen.add(key);
      inserts.set(key, m);
      tally.inserted++;
      tally.outcome.set(result.line, "inserted");
    }
    tally.touched.push({
      type: m.type as MeasurementType,
      measuredAt: m.measuredAt,
    });
    // An update that moves the reading to another instant leaves the day it
    // came from: that day is re-folded too, or the old day keeps a reading
    // that no longer exists there.
    if (stored && stored.measuredAt.getTime() !== m.measuredAt.getTime()) {
      tally.touched.push({
        type: m.type as MeasurementType,
        measuredAt: stored.measuredAt,
      });
    }
  }
  return { inserts, updates };
}

/**
 * Rows without an external id: create-only, deduped on the natural unique
 * key (userId, type, measuredAt, source=IMPORT, sleepStage=null). A
 * collision, against the DB or an earlier row in this same file, is a
 * duplicate, never an overwrite (each sample is a canonical reading).
 * Probed per type and chunk, like the external-id rows.
 */
async function planPlainRows(
  userId: string,
  plainRows: CsvOkRow[],
  tally: CsvTally,
): Promise<NormalisedMeasurementRow[]> {
  const existing = new Set<string>();
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
        existing.add(`${type}::${row.measuredAt.getTime()}`);
      }
    }
  }
  const seen = new Set<string>();
  const inserts: NormalisedMeasurementRow[] = [];
  for (const result of plainRows) {
    const m = result.row;
    const key = `${m.type}::${m.measuredAt.getTime()}`;
    if (existing.has(key) || seen.has(key)) {
      tally.skipped++;
      tally.outcome.set(result.line, "duplicate");
    } else {
      seen.add(key);
      inserts.push(m);
      tally.inserted++;
      tally.outcome.set(result.line, "inserted");
      tally.touched.push({
        type: m.type as MeasurementType,
        measuredAt: m.measuredAt,
      });
    }
  }
  return inserts;
}

/**
 * Under `skipDuplicates` a conflicting row is silently absorbed: the key is
 * present in the table either way, so the SPECIFIC raced lines cannot be
 * identified; only the counters and per-line statuses have to sum to the
 * truth. Downgrade enough `inserted` lines to `duplicate` so the envelope
 * matches the DB write count (the batch route's raced-duplicate downgrade).
 */
function downgradeRacedInserts(tally: CsvTally, raced: number): void {
  if (raced <= 0) return;
  let downgraded = 0;
  for (const [line, outcome] of tally.outcome) {
    if (downgraded >= raced) break;
    if (outcome === "inserted") {
      tally.outcome.set(line, "duplicate");
      tally.inserted--;
      tally.skipped++;
      downgraded++;
    }
  }
}

/**
 * Bulk write in bounded chunks, each its own short transaction.
 *
 * This used to be ONE interactive transaction around every create chunk AND
 * one `updateMany` per re-imported row. Re-importing a 9 000-row file with an
 * externalId column meant 9 000 serial updates inside it, which outlived
 * Prisma's 5 s interactive-transaction timeout and ended in a 500. A chunk
 * now commits on its own: creates go through `createManyAndReturn`
 * (skipDuplicates absorbs a concurrent double-submit), updates through one
 * batch transaction per chunk. A failure part-way leaves the earlier chunks
 * written, and that is safe to retry: a re-upload of the same file skips
 * what landed (unchanged externalId rows and natural-key duplicates are not
 * written again).
 */
async function writeRows(
  userId: string,
  toCreate: Prisma.MeasurementCreateManyInput[],
  updates: NormalisedMeasurementRow[],
  tally: CsvTally,
): Promise<void> {
  let createdCount = 0;
  const createdRows: Array<{
    id: string;
    type: MeasurementType;
    measuredAt: Date;
  }> = [];
  for (const chunk of chunked(toCreate, WRITE_CHUNK)) {
    const rows = await prisma.measurement.createManyAndReturn({
      data: chunk,
      skipDuplicates: true,
      select: { id: true, type: true, measuredAt: true },
    });
    createdRows.push(...rows);
    createdCount += rows.length;
  }
  for (const chunk of chunked(updates, WRITE_CHUNK)) {
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
            // No-op on a live row, a deliberate RESURRECTION on a tombstoned
            // one: IMPORT rows are re-importable by design, so a re-imported
            // externalId brings the row back (mirrors the source-owned sync
            // resurrect rule).
            deletedAt: null,
          },
        }),
      ),
    );
  }

  void emitInsertedMeasurementArrivals(userId, createdRows, "csv_import").catch(
    () => {},
  );
  void maybeEnqueueMorningRefresh(
    userId,
    createdRows
      .filter((row) => row.type === "SLEEP_DURATION")
      .map((row) => row.measuredAt),
  ).catch(() => {});

  downgradeRacedInserts(tally, toCreate.length - createdCount);
}

async function importRows(
  userId: string,
  okRows: CsvOkRow[],
  tally: CsvTally,
  ipAddress: string | null,
): Promise<void> {
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

  const ext = await planExternalIdRows(
    userId,
    okRows.filter((r) => r.row.externalId),
    tally,
  );
  const plainInserts = await planPlainRows(
    userId,
    okRows.filter((r) => !r.row.externalId),
    tally,
  );

  const toCreate: Prisma.MeasurementCreateManyInput[] = [
    ...[...ext.inserts.values()].map(buildCreateData),
    ...plainInserts.map(buildCreateData),
  ];
  // The re-fold runs whatever happens to the writes. A chunk that fails
  // part-way leaves the earlier chunks written, and a retry reads those rows
  // as duplicates and touches nothing: without the re-fold here their days
  // would keep the rollups from before the import for good. Re-folding a
  // (type, day) nothing landed on is harmless.
  try {
    await writeRows(userId, toCreate, [...ext.updates.values()], tally);
  } finally {
    // One bounded rollup re-fold per touched (type, day): a 10 000-row CSV
    // pays at most ~N (type, day) recomputes, not 10 000 per-row hooks, and
    // the status re-warm for the touched types. Best-effort: a populator
    // hiccup never fails the importer.
    await afterMeasurementMutation(userId, tally.touched, {
      source: "manual",
      label: "import.csv",
    });
  }

  await auditLog("import.csv.upload", {
    userId,
    ipAddress,
    details: {
      inserted: tally.inserted,
      updated: tally.updated,
      skipped: tally.skipped,
    },
  });
}

/**
 * Write (or, with `dryRun`, only project) one parsed CSV file and answer the
 * route's envelope: `{ inserted, updated, skipped, total, dryRun, rows }`.
 */
export async function runCsvImport(input: {
  userId: string;
  rows: CsvRowResult[];
  okRows: CsvOkRow[];
  dryRun: boolean;
  ipAddress: string | null;
}) {
  const { rows, okRows, dryRun } = input;
  const tally: CsvTally = {
    inserted: 0,
    updated: 0,
    skipped: rows.filter((r) => r.status === "skipped").length,
    outcome: new Map(),
    touched: [],
  };

  if (!dryRun) {
    await importRows(input.userId, okRows, tally, input.ipAddress);
  } else {
    // Dry-run preview: no write ran, so report the projected outcome: every
    // valid parse-`ok` row would insert (an externalId row could land as an
    // update, but that needs a DB read deliberately skipped here).
    tally.inserted = okRows.length;
  }

  const summary = {
    inserted: tally.inserted,
    updated: tally.updated,
    skipped: tally.skipped,
    total: rows.length,
    dryRun,
    // Per-row status, mirroring the batch route's per-entry envelope. The
    // normalised payload is stripped: the client only needs line + status.
    // Parse-time `ok` rows are refined by the write outcome: a row that hit
    // a unique-constraint duplicate becomes `skipped`/`duplicate`; an upsert
    // that landed on an existing row becomes `updated`. In `dryRun` mode no
    // write ran, so every parse-`ok` row stays `inserted` (the projected
    // outcome).
    rows: rows.map((r) => {
      if (r.status === "skipped") {
        return {
          line: r.line,
          status: "skipped" as const,
          ...(r.reason ? { reason: r.reason } : {}),
        };
      }
      const outcome = tally.outcome.get(r.line);
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
      import_csv_inserted: tally.inserted,
      import_csv_updated: tally.updated,
      import_csv_skipped: tally.skipped,
      import_csv_dry_run: dryRun,
    },
  });

  return summary;
}
