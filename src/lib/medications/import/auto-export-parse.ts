/**
 * The medication dose-history export, from file text to per-row facts.
 *
 * Pure and synchronous: no database, no clock beyond an injectable `now`.
 *
 * Every row is either a dose or a named refusal. There is no third outcome, and
 * nothing is dropped between the two: a test asserts that
 * `doses.length + refusals.length` equals the number of data rows read.
 *
 * Only the CSV shape carries a dose history. The documented JSON shape is read
 * too, and refused, for the reason set out in {@link parseAutoExportJson} — a
 * refusal that says why is worth more than a lossy import.
 */
import {
  ENTRY_INSTANT_FAR_PAST,
  isPlausibleEntryInstant,
} from "@/lib/validations/entry-instant";
import { splitCsvRows } from "@/lib/import/csv-measurements";

import {
  AUTO_EXPORT_CSV_COLUMNS,
  autoExportStatusDisposition,
  formatAutoExportDose,
  isAutoExportStatus,
} from "./auto-export-format";
import {
  parseAutoExportInstant,
  type AutoExportInstantFailure,
} from "./auto-export-instant";

/** One dose the file states, in HealthLog's own terms. */
export interface AutoExportDose {
  /** 1-based source line, so a refusal can be pointed at. */
  line: number;
  /** The name as written, kept verbatim for the unmatched-medication report. */
  medicationName: string;
  /** The export's optional second name for the same medication. */
  nickname: string | null;
  /**
   * The slot this dose belongs to. The file's `Scheduled Date` when it states
   * one; otherwise the actual instant, which is how HealthLog already anchors
   * an ad-hoc dose that belongs to no slot.
   */
  scheduledFor: Date;
  /** When the dose was actually taken. `null` for a deliberate skip. */
  takenAt: Date | null;
  skipped: boolean;
  /** Per-dose override, set only where the file records a real deviation. */
  doseTaken: string | null;
  /** The UTC offset the file stated for the actual instant, in minutes. */
  offsetMinutes: number;
  /** True when the row came from a medication archived in the source app. */
  fromArchivedMedication: boolean;
  /** True when the file named no slot, so this dose is ad-hoc. */
  adHoc: boolean;
}

/**
 * Why a row did not become a dose. Every one of these is surfaced with a count;
 * none of them is a silent drop.
 */
export const AUTO_EXPORT_REFUSAL_REASONS = [
  /** `Not Interacted` / `Not Logged` / `Unspecified` — an absence, not a dose. */
  "status_no_dose_information",
  /** `Snoozed` — something that happened to a reminder, not to a dose. */
  "status_reminder_event",
  /** `Notification Not Sent` — a fact about the app, not about the person. */
  "status_notification_not_sent",
  /** Status is not a value the format documents at all. */
  "status_unknown",
  /** `Date` is blank — there is no dose without an instant. */
  "missing_timestamp",
  /** A timestamp shaped right but carrying no UTC offset. */
  "missing_timezone_offset",
  /** A timestamp that does not match the documented shape. */
  "unreadable_timestamp",
  /** A timestamp naming no real instant, or one outside plausible capture. */
  "implausible_timestamp",
  /** `Medication` and `Nickname` both blank — the row names no medication. */
  "missing_medication",
  /** A dosage cell that is not a number. */
  "unreadable_dosage",
  /** A CSV line with fewer cells than the header declared. */
  "unreadable_row",
] as const;

export type AutoExportRefusalReason =
  (typeof AUTO_EXPORT_REFUSAL_REASONS)[number];

export interface AutoExportRefusal {
  line: number;
  reason: AutoExportRefusalReason;
}

/**
 * A file-level problem: nothing can be read at all.
 *
 * These values ship as `meta.errorCode` on the import route's 422, which is
 * why the constant is named for what they are on the wire rather than for the
 * field that carries them internally.
 */
export const AUTO_EXPORT_FATAL_ERROR_CODES = [
  "empty_file",
  "missing_required_columns",
  "unreadable_json",
  "json_not_an_array",
  /** The JSON shape records no time a dose was actually taken. */
  "json_carries_no_intake_time",
] as const;

export type AutoExportFatalErrorCode =
  (typeof AUTO_EXPORT_FATAL_ERROR_CODES)[number];

export interface AutoExportParseOutcome {
  fatal?: { reason: AutoExportFatalErrorCode; detail?: string };
  doses: AutoExportDose[];
  refusals: AutoExportRefusal[];
  /** Data rows read, refusals included. `doses + refusals` must equal it. */
  rowsRead: number;
  /**
   * Header cells the importer has no verdict for. Named rather than dropped: a
   * column nobody mentions is the defect this format work exists to remove.
   */
  unknownColumns: string[];
  /**
   * Rows whose `Codings` cell held something. Counted and left unread — the CSV
   * shape gives that column no documented encoding, and guessing one would be
   * the importer inventing a medication identity.
   */
  csvCodingsIgnored: number;
  /** Rows that came from a medication the source app has archived. */
  fromArchivedMedications: number;
}

/**
 * The past floor for an imported dose.
 *
 * HealthLog's own intake surfaces clamp a backdated dose to five years, which
 * would refuse most of a real export — the reported file starts in 2023 and a
 * longer history is ordinary. Importing years of history is the entire point of
 * this route, so the floor is the absolute 1900 bound the shared validator
 * carries and only the future side stays tight.
 */
const IMPORT_PAST_FLOOR_MS = Date.now() - ENTRY_INSTANT_FAR_PAST.getTime();

function refusalForInstantFailure(
  failure: AutoExportInstantFailure,
): AutoExportRefusalReason {
  switch (failure) {
    case "absent":
      return "missing_timestamp";
    case "missing_offset":
      return "missing_timezone_offset";
    case "out_of_range":
      return "implausible_timestamp";
    case "unreadable":
      return "unreadable_timestamp";
  }
}

/** `Yes` / `true` / `1`; anything else, blank included, reads as not archived. */
function readArchivedFlag(raw: string | null | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "yes" || value === "true" || value === "1";
}

type DosageRead =
  | { ok: true; amount: number | null }
  | { ok: false; reason: "unreadable_dosage" };

/** A blank dosage cell states nothing; a non-numeric one is a refusal. */
function readDosage(raw: string): DosageRead {
  const value = raw.trim();
  if (value.length === 0) return { ok: true, amount: null };
  if (!/^-?\d+(\.\d+)?$/.test(value)) {
    return { ok: false, reason: "unreadable_dosage" };
  }
  const amount = Number(value);
  return Number.isFinite(amount)
    ? { ok: true, amount }
    : { ok: false, reason: "unreadable_dosage" };
}

/**
 * The per-dose override, or `null`.
 *
 * Written only where the file records an actual amount that DIFFERS from the
 * amount the schedule expected — the only case where the dose taken is a fact
 * the schedule does not already carry. `doseTaken` is documented as "NULL = the
 * configured medication / schedule dose applies", so restating an unremarkable
 * amount on every one of three thousand rows would be noise dressed as
 * information. Where the file states no scheduled amount there is nothing to
 * compare against, and absence stays absence.
 */
function resolveDoseOverride(
  actual: number | null,
  scheduled: number | null,
  unit: string,
): string | null {
  if (actual === null || scheduled === null) return null;
  if (actual === scheduled) return null;
  return formatAutoExportDose(actual, unit);
}

interface RowInput {
  line: number;
  actual: string;
  scheduled: string;
  medication: string;
  nickname: string;
  dosage: string;
  scheduledDosage: string;
  unit: string;
  status: string;
  archived: string;
}

type RowOutcome =
  | { ok: true; dose: AutoExportDose }
  | { ok: false; reason: AutoExportRefusalReason };

/** The one place a row becomes a dose. */
function readRow(input: RowInput, now: number): RowOutcome {
  const status = input.status.trim();
  if (!isAutoExportStatus(status)) {
    return { ok: false, reason: "status_unknown" };
  }
  // Four kinds, four answers. Only the two that state a decision about a dose
  // become a row; the others are refused under the name of what they actually
  // are, so the person is told "this row is about a reminder" rather than being
  // left to read a total.
  const disposition = autoExportStatusDisposition(status);
  if (disposition === "no_dose_information") {
    return { ok: false, reason: "status_no_dose_information" };
  }
  if (disposition === "reminder_event") {
    return { ok: false, reason: "status_reminder_event" };
  }
  if (disposition === "app_event") {
    return { ok: false, reason: "status_notification_not_sent" };
  }

  const medicationName = input.medication.trim();
  const nickname = input.nickname.trim();
  if (medicationName.length === 0 && nickname.length === 0) {
    return { ok: false, reason: "missing_medication" };
  }

  const actual = parseAutoExportInstant(input.actual);
  if (!actual.ok) {
    return { ok: false, reason: refusalForInstantFailure(actual.failure) };
  }

  // A blank `Scheduled Date` is not a defect: the export writes it for a dose
  // logged outside any slot. HealthLog anchors exactly that case with
  // `scheduledFor === takenAt`, so the absence maps onto an existing notion
  // instead of being invented into one.
  const scheduledRead = parseAutoExportInstant(input.scheduled);
  let scheduledFor: Date;
  let adHoc: boolean;
  if (scheduledRead.ok) {
    scheduledFor = scheduledRead.instant;
    adHoc = false;
  } else if (scheduledRead.failure === "absent") {
    scheduledFor = actual.instant;
    adHoc = true;
  } else {
    return {
      ok: false,
      reason: refusalForInstantFailure(scheduledRead.failure),
    };
  }

  for (const instant of [actual.instant, scheduledFor]) {
    if (
      !isPlausibleEntryInstant(instant, { now, maxAgeMs: IMPORT_PAST_FLOOR_MS })
    ) {
      return { ok: false, reason: "implausible_timestamp" };
    }
  }

  const dosage = readDosage(input.dosage);
  if (!dosage.ok) return { ok: false, reason: dosage.reason };
  const scheduledDosage = readDosage(input.scheduledDosage);
  if (!scheduledDosage.ok) return { ok: false, reason: scheduledDosage.reason };

  const skipped = disposition === "dose_skipped";
  return {
    ok: true,
    dose: {
      line: input.line,
      medicationName: medicationName.length > 0 ? medicationName : nickname,
      nickname: nickname.length > 0 ? nickname : null,
      scheduledFor,
      // A skip is a dose that was deliberately not taken. The file's `Date` on
      // such a row is when the person pressed skip, which is not a take, so
      // `takenAt` stays null exactly as every other skip path writes it.
      takenAt: skipped ? null : actual.instant,
      skipped,
      doseTaken: skipped
        ? null
        : resolveDoseOverride(
            dosage.amount,
            scheduledDosage.amount,
            input.unit,
          ),
      offsetMinutes: actual.offsetMinutes,
      fromArchivedMedication: readArchivedFlag(input.archived),
      adHoc,
    },
  };
}

const CSV_HEADER_LOOKUP = new Map<string, string>(
  AUTO_EXPORT_CSV_COLUMNS.map((column) => [column.toLowerCase(), column]),
);

/** `Date`, `Medication` and `Status` are the file's irreducible content. */
const CSV_REQUIRED_COLUMNS = ["Date", "Medication", "Status"] as const;

export interface AutoExportParseOptions {
  /** Clock anchor for the plausibility bound. Injectable for tests. */
  now?: number;
}

const EMPTY_OUTCOME: Omit<AutoExportParseOutcome, "fatal"> = {
  doses: [],
  refusals: [],
  rowsRead: 0,
  unknownColumns: [],
  csvCodingsIgnored: 0,
  fromArchivedMedications: 0,
};

/** Parse the ten-column CSV export. */
export function parseAutoExportCsv(
  text: string,
  options: AutoExportParseOptions = {},
): AutoExportParseOutcome {
  const now = options.now ?? Date.now();
  const rows = splitCsvRows(text);
  if (rows.length === 0) {
    return { ...EMPTY_OUTCOME, fatal: { reason: "empty_file" } };
  }

  const header = rows[0];
  const index = new Map<string, number>();
  const unknownColumns: string[] = [];
  header.forEach((cell, position) => {
    const trimmed = cell.trim();
    const canonical = CSV_HEADER_LOOKUP.get(trimmed.toLowerCase());
    if (canonical) {
      if (!index.has(canonical)) index.set(canonical, position);
      return;
    }
    if (trimmed.length > 0) unknownColumns.push(trimmed);
  });

  // A slimmer export missing any of the other seven columns still imports, with
  // the facts those columns carry honestly absent.
  const missing = CSV_REQUIRED_COLUMNS.filter((column) => !index.has(column));
  if (missing.length > 0) {
    return {
      ...EMPTY_OUTCOME,
      unknownColumns,
      fatal: {
        reason: "missing_required_columns",
        detail: missing.join(", "),
      },
    };
  }

  const cellAt = (row: string[], column: string): string => {
    const position = index.get(column);
    if (position === undefined) return "";
    return row[position] ?? "";
  };

  const doses: AutoExportDose[] = [];
  const refusals: AutoExportRefusal[] = [];
  let csvCodingsIgnored = 0;
  let fromArchivedMedications = 0;

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const line = i + 1;
    // A row shorter than the header has lost cells to a malformed quote or a
    // hand edit, so the alignment is no longer trustworthy and no cell of it
    // can be read at face value.
    if (row.length < header.length) {
      refusals.push({ line, reason: "unreadable_row" });
      continue;
    }
    if (cellAt(row, "Codings").trim().length > 0) csvCodingsIgnored += 1;
    if (readArchivedFlag(cellAt(row, "Archived"))) fromArchivedMedications += 1;

    const outcome = readRow(
      {
        line,
        actual: cellAt(row, "Date"),
        scheduled: cellAt(row, "Scheduled Date"),
        medication: cellAt(row, "Medication"),
        nickname: cellAt(row, "Nickname"),
        dosage: cellAt(row, "Dosage"),
        scheduledDosage: cellAt(row, "Scheduled Dosage"),
        unit: cellAt(row, "Unit"),
        status: cellAt(row, "Status"),
        archived: cellAt(row, "Archived"),
      },
      now,
    );
    if (outcome.ok) doses.push(outcome.dose);
    else refusals.push({ line, reason: outcome.reason });
  }

  return {
    doses,
    refusals,
    rowsRead: rows.length - 1,
    unknownColumns,
    csvCodingsIgnored,
    fromArchivedMedications,
  };
}

/**
 * Read the documented JSON export — and refuse it, deliberately.
 *
 * The two shapes are not two encodings of the same thing. The CSV is a dose
 * log: `Date` is when a dose was actually taken and `Scheduled Date` is the slot
 * it belonged to, side by side. The documented JSON carries `scheduledDate`,
 * `status`, `dosage`, and the parent medication's `start` / `end` / `form` — and
 * no field for the time a dose was actually taken.
 *
 * So a `Taken` dose from the JSON shape could only be written by putting the
 * scheduled time in `takenAt`, which asserts every dose was taken to the minute
 * it was due. That is the exact flattening this whole path exists to undo: it
 * manufactures a spotless on-time history out of a file that never claimed one,
 * and no later correction can recover what was overwritten. A refusal that names
 * the missing field leaves the person able to export the CSV, which has it.
 *
 * The shape is still parsed far enough to tell a JSON medication export apart
 * from unreadable text, so the answer can be that sentence rather than a
 * generic failure.
 */
export function parseAutoExportJson(text: string): AutoExportParseOutcome {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { ...EMPTY_OUTCOME, fatal: { reason: "unreadable_json" } };
  }

  // The export wraps the array under a key in some of its output modes; both
  // the bare array and a single-key envelope are recognised.
  let list: unknown = decoded;
  if (!Array.isArray(list) && typeof list === "object" && list !== null) {
    const nested = Object.values(list as Record<string, unknown>).find(
      (value) => Array.isArray(value),
    );
    if (nested) list = nested;
  }
  if (!Array.isArray(list)) {
    return { ...EMPTY_OUTCOME, fatal: { reason: "json_not_an_array" } };
  }
  if (list.length === 0) {
    return { ...EMPTY_OUTCOME, fatal: { reason: "empty_file" } };
  }
  return {
    ...EMPTY_OUTCOME,
    rowsRead: list.length,
    fatal: { reason: "json_carries_no_intake_time" },
  };
}
