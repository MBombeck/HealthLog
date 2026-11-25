/**
 * CSV measurement import — parse + normalise + per-row validation (v1.17.1).
 *
 * A cold-start escape hatch for self-hosters migrating from a spreadsheet,
 * a glucose-meter export, or another tracker. The genuine import gap left
 * by the JSON (`/api/import`) and Apple-Health (`/api/import/apple-health-export`)
 * routes is plain CSV, which neither covers.
 *
 * This module is the pure, side-effect-free core: it turns raw CSV text
 * into a per-row result set carrying either a normalised measurement (ready
 * for the `/api/import` write loop) or a `skipped` status with a stable
 * machine-readable `reason`. The route (`/api/import/csv`) owns the DB write
 * + rollup re-fold; everything testable without a database lives here.
 *
 * Documented column schema (header row required, order-independent):
 *
 *   type,value,unit,measuredAt[,glucoseContext][,notes][,externalId]
 *
 *   - `type`        — a `measurementTypeEnum` value (e.g. WEIGHT). Unknown → skipped.
 *   - `value`       — a number in the row's `unit`.
 *   - `unit`        — the canonical unit for the type, OR a recognised alias
 *                     (glucose mmol/L → mg/dL, mass lb → kg, waist in → cm,
 *                     temperature °F → °C) via the shared
 *                     `resolveToCanonicalUnit` resolver. Any other
 *                     non-canonical unit → skipped (never silently mis-stored).
 *   - `measuredAt`  — ISO-8601 WITH an explicit offset (`Z` or ±HH:MM). A row
 *                     without an offset is skipped — the importer never guesses
 *                     a timezone. The instant is bounded by `validateEntryInstant`
 *                     (no future beyond a 5-min skew, no instant before 1900).
 *   - `glucoseContext` — optional on BLOOD_GLUCOSE, forbidden otherwise. A
 *                     blank cell stores NULL: a continuous sensor export
 *                     classifies nothing per reading, and an absent context
 *                     must read as absent rather than as a guessed one. A
 *                     non-empty cell is still checked against the enum.
 *   - `notes`       — free text, ≤ 200 chars.
 *   - `externalId`  — optional source-stable id. When present, the write loop
 *                     upserts on `(userId, type, source=IMPORT, externalId)` so a
 *                     re-upload is idempotent. Absent → re-upload duplicates.
 */
import {
  measurementTypeEnum,
  glucoseContextEnum,
  validateMeasurementRange,
} from "@/lib/validations/measurement";
import { MEASUREMENT_NOTES_MAX_LENGTH } from "@/lib/measurements/notes-limit";
import { isPlausibleEntryInstant } from "@/lib/validations/entry-instant";
import { isStableExternalId } from "@/lib/validations/external-id";
import { resolveToCanonicalUnit } from "@/lib/measurements/unit-aliases";

/** A normalised, write-ready row in the `/api/import` measurement shape. */
export interface NormalisedMeasurementRow {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  glucoseContext?: string;
  notes?: string;
  externalId?: string;
}

/** Stable machine-readable skip reasons, mirroring the batch route's vocabulary. */
export type CsvRowReason =
  | "missing_required_column"
  | "unknown_type"
  | "invalid_value"
  | "value_out_of_range"
  | "unknown_unit"
  | "missing_timezone_offset"
  | "invalid_timestamp"
  | "implausible_timestamp"
  | "unexpected_glucose_context"
  | "invalid_glucose_context"
  | "notes_too_long"
  | "external_id_too_long"
  | "unstable_external_id";

export type CsvRowStatus = "ok" | "skipped";

export interface CsvRowResult {
  /** 1-based source line number (header is line 1, first data row is line 2). */
  line: number;
  status: CsvRowStatus;
  reason?: CsvRowReason;
  /** Present only when `status === "ok"`. */
  row?: NormalisedMeasurementRow;
}

export interface CsvParseOutcome {
  /** A fatal, file-level error (e.g. missing required header). When set, `rows` is empty. */
  fatal?: { reason: CsvRowReason; message: string };
  rows: CsvRowResult[];
}

const REQUIRED_COLUMNS = ["type", "value", "unit", "measuredat"] as const;
const OPTIONAL_COLUMNS = ["glucosecontext", "notes", "externalid"] as const;

/**
 * Rows a whole-text CSV may hold, the header included, and cells one row may
 * hold. The text itself is capped by the routes (16 MB), but its shape was
 * not: sixteen megabytes of line breaks allocated a row array per line and
 * held several gigabytes of heap for most of a minute, and a file of short
 * junk lines answered with a status entry for each of eight million rows.
 * Past either bound the split stops and throws {@link CsvShapeLimitError}.
 */
export const CSV_MAX_ROWS = 100_001;
export const CSV_MAX_CELLS_PER_ROW = 1_000;

/** The CSV holds more rows or wider rows than one import reads. */
export class CsvShapeLimitError extends Error {
  constructor(readonly limit: "rows" | "cells") {
    super(
      limit === "rows"
        ? `The CSV has more than ${CSV_MAX_ROWS - 1} data rows`
        : `A CSV row has more than ${CSV_MAX_CELLS_PER_ROW} columns`,
    );
    this.name = "CsvShapeLimitError";
  }
}

/**
 * Split CSV text into rows of cells. Hand-rolled, zero-dependency, RFC-4180-ish:
 * handles quoted fields, escaped quotes (`""`), commas + newlines inside quotes,
 * a leading UTF-8 BOM, and CRLF / LF line endings. Blank lines are dropped as
 * they are read. Sufficient for the flat measurement schema; not a general CSV
 * engine. Throws {@link CsvShapeLimitError} past {@link CSV_MAX_ROWS} rows or
 * {@link CSV_MAX_CELLS_PER_ROW} cells in a row.
 */
export function splitCsvRows(text: string): string[][] {
  // Strip a leading BOM so the first header cell isn't "﻿type".
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let cell = "";
  let row: string[] = [];
  let inQuotes = false;
  let sawAnyChar = false;

  const pushCell = (): void => {
    if (row.length >= CSV_MAX_CELLS_PER_ROW) {
      throw new CsvShapeLimitError("cells");
    }
    row.push(cell);
  };
  // A fully-empty row (a blank line, or one holding only whitespace or `""`)
  // is dropped here rather than collected and filtered afterwards.
  const pushRow = (): void => {
    if (row.length === 1 && row[0].trim() === "") return;
    if (rows.length >= CSV_MAX_ROWS) throw new CsvShapeLimitError("rows");
    rows.push(row);
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      sawAnyChar = true;
      continue;
    }
    if (ch === ",") {
      pushCell();
      cell = "";
      sawAnyChar = true;
      continue;
    }
    if (ch === "\r") {
      // Swallow; the \n (if any) finalises the row.
      continue;
    }
    if (ch === "\n") {
      pushCell();
      pushRow();
      row = [];
      cell = "";
      sawAnyChar = false;
      continue;
    }
    cell += ch;
    sawAnyChar = true;
  }
  // Flush a trailing row that did not end in a newline.
  if (sawAnyChar || cell.length > 0 || row.length > 0) {
    pushCell();
    pushRow();
  }
  return rows;
}

/** True when an ISO-8601 datetime string carries an explicit offset (`Z` or ±HH:MM). */
function hasExplicitOffset(value: string): boolean {
  // Offset is in the time portion, after the `T`. Match a trailing Z or ±HH:MM.
  return /([zZ]|[+-]\d{2}:?\d{2})$/.test(value.trim());
}

const KNOWN_TYPES = new Set(measurementTypeEnum.options as readonly string[]);
const KNOWN_GLUCOSE_CONTEXTS = new Set(
  glucoseContextEnum.options as readonly string[],
);

/**
 * Parse + validate + normalise a CSV measurement file. Returns a per-row
 * result set: each data row is either `ok` with a normalised measurement or
 * `skipped` with a stable reason. A missing required header column is the
 * only fatal, file-level failure.
 *
 * `now` is injectable so tests pin the entry-instant clock.
 */
export function parseCsvMeasurements(
  text: string,
  opts: { now?: number } = {},
): CsvParseOutcome {
  const now = opts.now ?? Date.now();
  const grid = splitCsvRows(text);

  if (grid.length === 0) {
    return {
      fatal: {
        reason: "missing_required_column",
        message: "The CSV is empty — a header row is required.",
      },
      rows: [],
    };
  }

  const header = grid[0].map((h) => h.trim().toLowerCase());
  const colIndex = new Map<string, number>();
  header.forEach((name, idx) => {
    if (!colIndex.has(name)) colIndex.set(name, idx);
  });

  const missing = REQUIRED_COLUMNS.filter((c) => !colIndex.has(c));
  if (missing.length > 0) {
    return {
      fatal: {
        reason: "missing_required_column",
        message: `Missing required column(s): ${missing.join(", ")}. Required header: ${REQUIRED_COLUMNS.join(",")}[,${OPTIONAL_COLUMNS.join(",")}].`,
      },
      rows: [],
    };
  }

  const idxType = colIndex.get("type")!;
  const idxValue = colIndex.get("value")!;
  const idxUnit = colIndex.get("unit")!;
  const idxMeasuredAt = colIndex.get("measuredat")!;
  const idxContext = colIndex.get("glucosecontext");
  const idxNotes = colIndex.get("notes");
  const idxExternalId = colIndex.get("externalid");

  const rows: CsvRowResult[] = [];

  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    const line = r + 1; // 1-based, header is line 1.
    const cellAt = (idx: number | undefined): string =>
      idx === undefined ? "" : (cells[idx] ?? "").trim();

    const type = cellAt(idxType);
    const rawValue = cellAt(idxValue);
    const rawUnit = cellAt(idxUnit);
    const rawMeasuredAt = cellAt(idxMeasuredAt);
    const rawContext = cellAt(idxContext);
    const rawNotes = idxNotes === undefined ? "" : (cells[idxNotes] ?? "");
    const rawExternalId = cellAt(idxExternalId);

    const skip = (reason: CsvRowReason): void => {
      rows.push({ line, status: "skipped", reason });
    };

    if (!KNOWN_TYPES.has(type)) {
      skip("unknown_type");
      continue;
    }

    const value = Number(rawValue);
    if (rawValue === "" || !Number.isFinite(value)) {
      skip("invalid_value");
      continue;
    }

    const converted = resolveToCanonicalUnit(type, value, rawUnit);
    if (converted === null) {
      skip("unknown_unit");
      continue;
    }

    if (validateMeasurementRange(type, converted.value) !== null) {
      skip("value_out_of_range");
      continue;
    }

    if (!rawMeasuredAt) {
      skip("invalid_timestamp");
      continue;
    }
    if (!hasExplicitOffset(rawMeasuredAt)) {
      skip("missing_timezone_offset");
      continue;
    }
    const measuredAt = new Date(rawMeasuredAt);
    if (Number.isNaN(measuredAt.getTime())) {
      skip("invalid_timestamp");
      continue;
    }
    if (!isPlausibleEntryInstant(measuredAt, { now })) {
      skip("implausible_timestamp");
      continue;
    }

    // Glucose context: optional on BLOOD_GLUCOSE, forbidden otherwise. A
    // blank cell leaves the column NULL — the row is a reading either way,
    // and a sensor export carries no fasting / post-meal classification.
    let glucoseContext: string | undefined;
    if (type === "BLOOD_GLUCOSE") {
      if (rawContext && !KNOWN_GLUCOSE_CONTEXTS.has(rawContext)) {
        skip("invalid_glucose_context");
        continue;
      }
      glucoseContext = rawContext || undefined;
    } else if (rawContext) {
      skip("unexpected_glucose_context");
      continue;
    }

    const notes = rawNotes.trim();
    if (notes.length > MEASUREMENT_NOTES_MAX_LENGTH) {
      skip("notes_too_long");
      continue;
    }

    if (rawExternalId.length > 120) {
      skip("external_id_too_long");
      continue;
    }

    // The import upserts on `(userId, type, source, externalId)`, so an
    // id that cannot be stable across exports re-imports as a fresh row
    // every time instead of converging on the one it already wrote.
    if (rawExternalId.length > 0 && !isStableExternalId(rawExternalId)) {
      skip("unstable_external_id");
      continue;
    }

    rows.push({
      line,
      status: "ok",
      row: {
        type,
        value: converted.value,
        unit: converted.unit,
        measuredAt,
        ...(glucoseContext ? { glucoseContext } : {}),
        ...(notes ? { notes } : {}),
        ...(rawExternalId ? { externalId: rawExternalId } : {}),
      },
    });
  }

  return { rows };
}

/** Column order for the downloadable example + docs. */
export const CSV_EXAMPLE_COLUMNS = [
  "type",
  "value",
  "unit",
  "measuredAt",
  "glucoseContext",
  "notes",
  "externalId",
] as const;
