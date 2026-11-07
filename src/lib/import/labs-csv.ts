/**
 * CSV import of lab results (#1215).
 *
 * A row becomes a lab reading the way a scanned report's confirmed row does
 * (`/api/labs/ocr/commit`): the name resolves to the account's marker by the
 * same index (name, alias, catalog), a marker is minted from the first row
 * that names a new analyte, a reading in another unit is converted when the
 * conversion is known and kept beside what the file said, and a reading the
 * record already holds is skipped. Nothing about a row is guessed: an
 * ambiguous number or date, a numeric value without a unit, or a unit that
 * does not convert into the marker's is refused with its reason and line.
 *
 * Memory: the file is read record by record (`readCsvRecords`) and written in
 * chunks of `CHUNK_ROWS`; what is held across chunks is the marker index, the
 * duplicate keys of rows already accepted and the bounded report.
 *
 * Writes: one `createMany` per chunk, so a chunk lands whole or not at all.
 * An import cut off part way (the client went away, a proxy timed out) leaves
 * whole chunks behind, and uploading the same file again skips them as
 * duplicates and writes the rest: a retry is idempotent. `onWritten` reports
 * each committed chunk so the caller can audit a partial import.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  readCsvRecords,
  type CsvDelimiter,
  type CsvRecord,
} from "@/lib/import/csv-stream";
import { parseCsvDate, parseLocaleNumber } from "@/lib/import/csv-values";
import { RecordImportReport } from "@/lib/import/record-import-report";
import { matchAnalyteKey } from "@/lib/labs/analyte-match";
import {
  addToIndex,
  loadMarkerIndex,
  resolveInIndex,
  unitFitsMarker,
  type IndexedMarker,
  type MarkerIndex,
} from "@/lib/labs/biomarker-resolve";
import { resolveOrMintBiomarker } from "@/lib/labs/biomarker-store";
import { mintedBounds } from "@/lib/labs/minted-bounds";
import { parseReferenceRange } from "@/lib/labs/parse-reference-range";
import { readingInMarkerUnit } from "@/lib/labs/reading-conversion";
import {
  labReadingDay,
  labReadingDaySearchRange,
} from "@/lib/labs/reading-day";
import { encryptNoteToBytes } from "@/lib/labs/store";
import type {
  LabsCsvQuery,
  RecordImportResult,
  RecordImportRowReason,
} from "@/lib/validations/record-import";

export const LABS_CSV_MAX_ROWS = 20_000;
const CHUNK_ROWS = 200;
const MAX_LISTED_MARKERS = 200;
/** A reading dated more than a day ahead is a typing mistake, not a result. */
const FUTURE_SLACK_MS = 86_400_000;
const EARLIEST = Date.UTC(1900, 0, 1);

export const LAB_TEXT_LIMITS = {
  analyte: 200,
  valueText: 200,
  unit: 80,
  panel: 100,
  note: 1000,
} as const;

export interface LabCsvRow {
  line: number;
  analyte: string;
  value: number | null;
  valueText: string | null;
  unit: string | null;
  takenAt: Date;
  /** The file's window. On a text result it only seeds a new marker: the
   * reading itself records no window. */
  sourceReferenceLow: number | null;
  sourceReferenceHigh: number | null;
  sourceReferenceText: string | null;
  panel: string | null;
  note: string | null;
}

export type LabRowResult =
  | { ok: true; row: LabCsvRow }
  | { ok: false; reason: RecordImportRowReason; field: string };

function cell(fields: string[], index: number | undefined): string {
  if (index === undefined) return "";
  return (fields[index] ?? "").trim();
}

/** One CSV record → a lab row, or the first reason it cannot be one. Pure. */
export function normaliseLabRow(
  record: Pick<CsvRecord, "line" | "fields">,
  query: LabsCsvQuery,
  timezone: string,
  now: Date = new Date(),
): LabRowResult {
  const f = record.fields;
  const fail = (
    reason: RecordImportRowReason,
    field: string,
  ): LabRowResult => ({ ok: false, reason, field });

  const analyte = cell(f, query.analyte);
  if (!analyte) return fail("missing_value", "analyte");
  if (analyte.length > LAB_TEXT_LIMITS.analyte)
    return fail("text_too_long", "analyte");

  const rawValue = cell(f, query.value);
  if (!rawValue) return fail("missing_value", "value");
  let value: number | null = null;
  let valueText: string | null = null;
  const parsed = parseLocaleNumber(rawValue, query.decimal);
  if (parsed.ok) {
    value = parsed.value;
  } else if (parsed.reason === "ambiguous_number") {
    return fail("ambiguous_number", "value");
  } else if (/^[+-]?[\d.,\s]+$/.test(rawValue)) {
    // Digits and marks that still do not read as a number: a broken number,
    // not a qualitative result.
    return fail("invalid_number", "value");
  } else {
    if (rawValue.length > LAB_TEXT_LIMITS.valueText)
      return fail("text_too_long", "value");
    valueText = rawValue;
  }

  const unit = cell(f, query.unit) || null;
  if (value !== null && !unit) return fail("missing_unit", "unit");
  if (unit && unit.length > LAB_TEXT_LIMITS.unit)
    return fail("text_too_long", "unit");

  const date = parseCsvDate(
    cell(f, query.date),
    query.time === undefined ? undefined : cell(f, query.time),
    {
      order: query.dateOrder,
      timezone,
    },
  );
  if (!date.ok) return fail(date.reason, "date");
  if (date.instant.getTime() > now.getTime() + FUTURE_SLACK_MS)
    return fail("future_date", "date");
  if (date.instant.getTime() < EARLIEST) return fail("invalid_date", "date");

  let low: number | null = null;
  let high: number | null = null;
  let rangeText: string | null = null;
  for (const [key, index] of [
    ["referenceLow", query.referenceLow],
    ["referenceHigh", query.referenceHigh],
  ] as const) {
    const raw = cell(f, index);
    if (!raw) continue;
    const n = parseLocaleNumber(raw, query.decimal);
    if (!n.ok)
      return fail(
        n.reason === "ambiguous_number"
          ? "ambiguous_number"
          : "invalid_reference_range",
        key,
      );
    if (key === "referenceLow") low = n.value;
    else high = n.value;
  }
  const rawRange = cell(f, query.referenceRange);
  if (rawRange) {
    // A comma-decimal file writes ranges as "4,0 - 5,6"; the range reader
    // speaks the dot, so the marks are swapped first for such a file.
    const forReader =
      query.decimal === "comma"
        ? rawRange.replace(/(\d),(\d)/g, "$1.$2")
        : rawRange;
    const printed = parseReferenceRange(forReader, unit);
    if (printed) {
      low ??= printed.low;
      high ??= printed.high;
      rangeText = rawRange.replace(/\s+/g, " ").slice(0, 120);
    }
  }
  if (low !== null && high !== null && low > high) {
    return fail("invalid_reference_range", "referenceRange");
  }

  const panel = cell(f, query.panel) || null;
  if (panel && panel.length > LAB_TEXT_LIMITS.panel)
    return fail("text_too_long", "panel");
  const note = cell(f, query.note) || null;
  if (note && note.length > LAB_TEXT_LIMITS.note)
    return fail("text_too_long", "note");

  return {
    ok: true,
    row: {
      line: record.line,
      analyte,
      value,
      valueText,
      unit,
      takenAt: date.instant,
      sourceReferenceLow: low,
      sourceReferenceHigh: high,
      sourceReferenceText: valueText === null ? rangeText : null,
      panel,
      note,
    },
  };
}

/**
 * The keys a reading is a duplicate under, mirroring the scan commit's
 * `isDuplicate`: the marker (or the name, for a reading filed without one),
 * the reading's calendar day, and the value as stored, as printed, or as text.
 */
export function readingKeys(
  reading: {
    biomarkerId: string | null;
    analyte: string;
    takenAt: Date;
    value: number | null;
    valueText: string | null;
    sourceValue?: number | null;
    sourceUnit?: string | null;
    unit?: string | null;
  },
  tz: string,
): string[] {
  const who = reading.biomarkerId
    ? `bm:${reading.biomarkerId}`
    : `an:${reading.analyte.trim().toLowerCase()}`;
  const day = labReadingDay(reading.takenAt, tz);
  const keys: string[] = [];
  if (reading.value !== null) keys.push(`${who}|${day}|n:${reading.value}`);
  if (
    reading.sourceValue !== null &&
    reading.sourceValue !== undefined &&
    reading.sourceUnit
  ) {
    keys.push(
      `${who}|${day}|s:${reading.sourceValue}:${reading.sourceUnit.trim().toLowerCase()}`,
    );
  }
  if (reading.valueText !== null) {
    keys.push(`${who}|${day}|t:${reading.valueText.trim().toLowerCase()}`);
  }
  return keys;
}

interface Planned {
  row: LabCsvRow;
  marker: IndexedMarker | null;
}

/**
 * The window the write keeps on the reading: the printed one for a number, none
 * for a text result (its range seeds a new marker, not the reading).
 */
function readingWindow(row: LabCsvRow): {
  low: number | null;
  high: number | null;
} {
  return row.valueText === null
    ? { low: row.sourceReferenceLow, high: row.sourceReferenceHigh }
    : { low: null, high: null };
}

function displayRow(row: LabCsvRow, marker: string) {
  const window = readingWindow(row);
  return {
    line: row.line,
    marker,
    value: row.value,
    valueText: row.valueText,
    unit: row.unit,
    takenAt: row.takenAt.toISOString(),
    referenceLow: window.low,
    referenceHigh: window.high,
    panel: row.panel,
    note: row.note !== null,
  };
}

/**
 * Read, check and (unless a dry run) write a lab CSV. Throws
 * `CsvTooLargeError` past the byte cap; everything else is reported per row.
 */
export async function importLabsCsv(args: {
  userId: string;
  tz: string;
  stream: ReadableStream<Uint8Array>;
  maxBytes: number;
  query: LabsCsvQuery;
  now?: Date;
  /** Called after each committed chunk with the rows it wrote. */
  onWritten?: (rows: number) => void;
}): Promise<RecordImportResult> {
  const { userId, tz, query } = args;
  const dryRun = query.dryRun;
  // One zone for everything: the file's times are read in it, and the
  // calendar day a reading is a duplicate on is cut in it too. Cutting the
  // days in the account's zone while reading the file in another split one
  // draw day in two, or folded two into one.
  const timezone = query.timezone ?? tz;
  const report = new RecordImportReport("labs", dryRun);
  const index: MarkerIndex = await loadMarkerIndex(prisma, userId);
  // A dry run works on a copy, so the markers it pretends to mint never leak.
  const working: MarkerIndex = dryRun
    ? { markers: [...index.markers], aliases: [...index.aliases] }
    : index;
  const matched = new Map<
    string,
    { name: string; marker: string; how: "name" | "alias" | "catalog" }
  >();
  const created = new Set<string>();
  const seen = new Set<string>();
  let chunk: LabCsvRow[] = [];
  let pendingId = 0;

  const delimiter: CsvDelimiter | "auto" =
    query.delimiter === "comma"
      ? ","
      : query.delimiter === "semicolon"
        ? ";"
        : query.delimiter === "tab"
          ? "\t"
          : "auto";

  const flush = async () => {
    if (chunk.length === 0) return;
    const rows = chunk;
    chunk = [];

    // 1. Resolve every row's marker; a dry run pretends to mint.
    const planned: Planned[] = [];
    for (const row of rows) {
      const hit = resolveInIndex(
        working,
        row.analyte,
        row.valueText === null ? row.unit : null,
      );
      let marker: IndexedMarker | null = hit?.marker ?? null;
      if (hit) {
        // Listed once per spelling, so the person sees which of the file's
        // names landed on which of their markers.
        const key = row.analyte.toLowerCase();
        if (!matched.has(key) && matched.size < MAX_LISTED_MARKERS) {
          matched.set(key, {
            name: row.analyte,
            marker: hit.marker.name,
            how: hit.matchKind,
          });
        }
      } else if (dryRun) {
        const unit = row.unit ?? "";
        marker = {
          id: `pending:${pendingId++}`,
          name: row.analyte,
          unit,
          ...mintedBounds(row.sourceReferenceLow, row.sourceReferenceHigh),
          panel: row.panel,
          analyteKey: matchAnalyteKey({ name: row.analyte, unit }),
          hidden: false,
          createdAt: new Date(),
        };
        addToIndex(working, marker);
        if (created.size < MAX_LISTED_MARKERS) created.add(row.analyte);
      }
      // The unit must fit the marker, or convert into it.
      if (
        marker &&
        row.value !== null &&
        // The key as the write derives it (`ensureAnalyteKey`), so the check
        // and the conversion the import then runs cannot disagree.
        !unitFitsMarker(
          {
            unit: marker.unit,
            analyteKey:
              matchAnalyteKey({ name: marker.name, unit: marker.unit }) ??
              marker.analyteKey,
          },
          row.unit,
          null,
        )
      ) {
        report.fail(row.line, "unit_mismatch", "unit");
        continue;
      }
      planned.push({ row, marker });
    }

    // 2. Duplicates against the record, one query for the chunk.
    //
    // The day is cut in the zone the file is read in. Only a reading with a
    // wall-clock time depends on it: a date alone is stored at the noon-UTC
    // anchor and a time with an offset is one instant, and both land on the
    // same day in every zone. A wall-clock time read in another zone on a
    // retry is a different instant, and near midnight a different day, so it
    // can be written twice. Matching on the exact instant would not catch it
    // (the instant moved with the zone), and widening the match by the zone
    // difference would also swallow a genuine reading of the same value on
    // the neighbouring day. The zone the earlier import read the file in is
    // not stored, so the record cannot tell those two apart; the day in the
    // current zone is the one rule that never drops a real reading.
    const days = planned
      .map((p) => labReadingDay(p.row.takenAt, timezone))
      .sort();
    const existingKeys = new Set<string>();
    if (planned.length > 0) {
      const from = labReadingDaySearchRange(days[0]).gte;
      const to = labReadingDaySearchRange(days[days.length - 1]).lt;
      const ids = [
        ...new Set(
          planned
            .map((p) => p.marker?.id)
            .filter((id): id is string => !!id && !id.startsWith("pending:")),
        ),
      ];
      const names = [...new Set(planned.map((p) => p.row.analyte))];
      const existing = await prisma.labResult.findMany({
        where: {
          userId,
          deletedAt: null,
          takenAt: { gte: from, lt: to },
          OR: [{ biomarkerId: { in: ids } }, { analyte: { in: names } }],
        },
        select: {
          biomarkerId: true,
          analyte: true,
          takenAt: true,
          value: true,
          valueText: true,
          sourceValue: true,
          sourceUnit: true,
        },
      });
      for (const e of existing) {
        for (const k of readingKeys(e, timezone)) existingKeys.add(k);
        // A reading filed under a marker also answers to its printed name.
        if (e.biomarkerId) {
          for (const k of readingKeys({ ...e, biomarkerId: null }, timezone))
            existingKeys.add(k);
        }
      }
    }

    // 3. Write (or count) what is new: rows are built here and written in
    // one statement for the chunk.
    const toWrite: Prisma.LabResultCreateManyInput[] = [];
    for (const { row, marker } of planned) {
      const probe = {
        biomarkerId:
          marker && !marker.id.startsWith("pending:") ? marker.id : null,
        analyte: row.analyte,
        takenAt: row.takenAt,
        value: row.value,
        valueText: row.valueText,
        sourceValue: row.value,
        sourceUnit: row.unit,
      };
      const keys = [
        ...readingKeys(probe, timezone),
        ...readingKeys({ ...probe, biomarkerId: null }, timezone),
        ...(marker
          ? readingKeys({ ...probe, biomarkerId: marker.id }, timezone)
          : []),
      ];
      if (keys.some((k) => existingKeys.has(k) || seen.has(k))) {
        report.duplicate(row.line);
        continue;
      }

      if (dryRun) {
        for (const k of keys) seen.add(k);
        report.valid += 1;
        report.inserted += 1;
        report.addPreview(displayRow(row, marker?.name ?? row.analyte));
        continue;
      }

      const biomarker =
        marker ??
        (await resolveOrMintBiomarker(
          userId,
          {
            analyte: row.analyte,
            unit: row.unit ?? "",
            referenceLow: row.sourceReferenceLow,
            referenceHigh: row.sourceReferenceHigh,
            panel: row.panel,
          },
          { index: working },
        ));
      if (!marker) created.add(row.analyte);

      let storedValue = row.value;
      let { low: storedLow, high: storedHigh } = readingWindow(row);
      let convertedFrom: { sourceValue: number; sourceUnit: string } | null =
        null;
      if (row.value !== null) {
        const reading = await readingInMarkerUnit(prisma, {
          marker: biomarker,
          value: row.value,
          unit: row.unit ?? undefined,
          sourceReferenceLow: storedLow,
          sourceReferenceHigh: storedHigh,
        });
        if (!reading.ok) {
          report.fail(row.line, "unit_mismatch", "unit");
          continue;
        }
        storedValue = reading.value;
        storedLow = reading.sourceReferenceLow;
        storedHigh = reading.sourceReferenceHigh;
        if (reading.converted) {
          convertedFrom = {
            sourceValue: reading.sourceValue,
            sourceUnit: reading.sourceUnit,
          };
        }
      }

      // Field by field, never a spread of the parsed row.
      toWrite.push({
        userId,
        biomarkerId: biomarker.id,
        panel: row.panel ?? biomarker.panel,
        analyte: biomarker.name,
        value: storedValue,
        valueText: row.valueText,
        unit: biomarker.unit,
        sourceValue: convertedFrom?.sourceValue ?? null,
        sourceUnit: convertedFrom?.sourceUnit ?? null,
        referenceLow: biomarker.lowerBound,
        referenceHigh: biomarker.upperBound,
        sourceReferenceLow: storedLow,
        sourceReferenceHigh: storedHigh,
        sourceReferenceText: row.sourceReferenceText,
        takenAt: row.takenAt,
        source: "IMPORT",
        noteEncrypted: row.note ? encryptNoteToBytes(row.note) : null,
      });
      for (const k of [
        ...keys,
        ...readingKeys({ ...probe, biomarkerId: biomarker.id }, timezone),
      ])
        seen.add(k);
      report.valid += 1;
    }
    if (toWrite.length > 0) {
      const { count } = await prisma.labResult.createMany({ data: toWrite });
      report.inserted += count;
      args.onWritten?.(count);
    }
  };

  let first = true;
  for await (const record of readCsvRecords(args.stream, {
    maxBytes: args.maxBytes,
    delimiter,
  })) {
    if (first && query.header) {
      first = false;
      continue;
    }
    first = false;
    report.rows += 1;
    if (report.rows > LABS_CSV_MAX_ROWS) {
      report.fail(record.line, "row_limit");
      continue;
    }
    if (record.oversized) {
      report.fail(record.line, "oversized_row");
      continue;
    }
    const result = normaliseLabRow(record, query, timezone, args.now);
    if (!result.ok) {
      report.fail(record.line, result.reason, result.field);
      continue;
    }
    chunk.push(result.row);
    if (chunk.length >= CHUNK_ROWS) await flush();
  }
  await flush();

  return report.toResult({
    markers: {
      matched: [...matched.values()],
      created: [...created].slice(0, MAX_LISTED_MARKERS),
    },
  });
}
