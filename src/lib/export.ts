/**
 * Export utilities — CSV, JSON, and ZIP generation.
 *
 * v1.4.25 W7 — per-user timezone. Timestamps were emitted with
 * `.toISOString()` (UTC `Z` suffix), which Excel / LibreOffice
 * silently render in the viewer's local zone — issue #167. The
 * helpers now accept a `userTz` argument and write
 * `2026-05-11T11:05:00+02:00` instead, so the offset survives the
 * round-trip and the on-screen value is unambiguous regardless of
 * the spreadsheet's locale defaults.
 *
 * Backward compatibility: `userTz` is optional; when omitted the
 * helpers fall back to `.toISOString()` so callers that don't yet
 * thread a user context (admin tools, the backup-on-disk shape) keep
 * the old contract. Production routes always pass `userTz`.
 */
import { formatInUserTz } from "./tz/format";
import {
  reconstructSleepSessions,
  pickMainNightAndNaps,
  type SleepStageRow,
} from "./analytics/sleep-night";
import { convertGlucose, type GlucoseUnit } from "./glucose";
import type { SleepStage } from "@/generated/prisma/client";

export interface ExportableRecord {
  [key: string]: unknown;
}

/**
 * Convert records to CSV string.
 *
 * The first record's keys define the column order (callers should pass
 * a stable shape — see `buildAuditLogCsvRecords`). When `headerLabels`
 * is provided, those strings replace the object-key header row so the
 * exported CSV can carry translated column titles without changing
 * the record-key contract that drives the columns.
 *
 * Escapes RFC 4180 special characters: commas, double quotes, line
 * breaks (`\n` and `\r`). Values containing any of these are wrapped
 * in double quotes with embedded quotes doubled (`"` → `""`).
 *
 * Spreadsheet formula injection (CSV injection): free-TEXT cells whose
 * value starts with `=`, `+`, `-`, `@`, TAB, or CR get a leading `'`
 * (the OWASP single-quote neutralisation — Excel / LibreOffice /
 * Google Sheets treat the cell as text and hide the quote). The guard
 * is scoped to STRING-typed record values only: numeric columns
 * (measurement values, mood scores) stay typed `number` all the way to
 * this function, so a negative reading exports as `-5.2`, never
 * `'-5.2`. The text columns are where third-party content can land —
 * mood `note` originates from user input, measurement `notes`
 * from arbitrary clients — and a crafted `=HYPERLINK(...)` /
 * `=cmd|...` there must not execute when an operator opens the export.
 */
export function toCSV(
  records: ExportableRecord[],
  headerLabels?: Record<string, string>,
): string {
  if (records.length === 0) return "";

  const headers = Object.keys(records[0]);
  const headerLine = headerLabels
    ? headers
        .map((h) =>
          escapeCsvCell(neutraliseFormulaPrefix(headerLabels[h] ?? h)),
        )
        .join(",")
    : headers.map(escapeCsvCell).join(",");
  const lines = [headerLine];

  for (const record of records) {
    const values = headers.map((h) => {
      const val = record[h];
      if (val === null || val === undefined) return "";
      if (val instanceof Date) return escapeCsvCell(val.toISOString());
      // Only genuine TEXT cells get the formula-prefix guard; numbers /
      // booleans stringify verbatim so numeric columns are never mangled.
      const str = String(val);
      return escapeCsvCell(
        typeof val === "string" ? neutraliseFormulaPrefix(str) : str,
      );
    });
    lines.push(values.join(","));
  }

  return lines.join("\n");
}

/**
 * OWASP CSV-injection neutralisation: prefix a text cell that starts
 * with a formula trigger (`=`, `+`, `-`, `@`) or a control character
 * Excel interprets as a field continuation (TAB, CR) with a single
 * quote so the spreadsheet renders it as literal text. Applied to
 * string cells only — see `toCSV`.
 */
function neutraliseFormulaPrefix(str: string): string {
  return /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
}

/**
 * RFC 4180 cell escaping. `\r` is treated the same as `\n` so a
 * Windows-newline value (`\r\n`) inside a single field doesn't break
 * row alignment when Excel re-imports the CSV.
 */
function escapeCsvCell(str: string): string {
  if (
    str.includes(",") ||
    str.includes('"') ||
    str.includes("\n") ||
    str.includes("\r")
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatTimestamp(date: Date, userTz?: string): string {
  if (userTz) return formatInUserTz(date, userTz, "iso-with-offset");
  return date.toISOString();
}

interface ExportMeasurement {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  source: string;
  notes: string | null;
  glucoseContext?: string | null;
  sleepStage?: SleepStage | null;
  /** Writer tag for the per-night sleep collapse (watch vs phone). */
  deviceType?: string | null;
}

/**
 * Format measurements for export.
 *
 * `userTz` (optional) — when provided, `measuredAt` is emitted as
 * ISO-8601 with the user's UTC offset (e.g. `+02:00` in Berlin in
 * May) instead of the bare `Z` suffix. See module-level docstring
 * for the rationale (issue #167).
 *
 * v1.11.5 — SLEEP_DURATION is stored one row per STAGE per night. A flat
 * export emitted a wall of per-stage minutes with no night attribution.
 * By default sleep rows are now COLLAPSED to one record per night (the
 * main session's TIME ASLEEP per the nap convention) carrying the stage
 * breakdown in `notes` so the single uniform CSV reads as one night, not
 * many stages. Pass `granularity: "raw"` to keep the per-stage rows for
 * power users. Storage is untouched either way.
 */
export function formatMeasurementsForExport(
  measurements: ExportMeasurement[],
  userTz?: string,
  opts: {
    granularity?: "night" | "raw";
    sleepTz?: string;
    /**
     * The user's persisted `sourcePriorityJson` (or null for the defaults).
     * Threaded into `reconstructSleepSessions` so the CSV's per-night sleep
     * dedup picks the SAME canonical source the UI shows on a multi-source
     * night — without it the export silently fell back to the default ladder.
     */
    sourcePriorityJson?: unknown;
    /**
     * v1.16.16 — the user's resolved glucose display unit. BLOOD_GLUCOSE is
     * stored canonical mg/dL; when this is `"mmol/L"` the export converts the
     * value (1 decimal) and emits `mmol/L` in the `unit` column, matching the
     * FHIR export (`src/lib/fhir/resources.ts`) so the CSV reads in ONE unit.
     * Defaults to `"mg/dL"` (the canonical-stored unit) → byte-identical for
     * mg/dL-preference users.
     */
    glucoseUnit?: GlucoseUnit;
  } = {},
): ExportableRecord[] {
  const granularity = opts.granularity ?? "night";
  const glucoseUnit: GlucoseUnit = opts.glucoseUnit ?? "mg/dL";
  const toRecord = (m: ExportMeasurement): ExportableRecord => {
    // BLOOD_GLUCOSE is stored mg/dL; convert to the user's display unit at
    // serialization so the value + unit column agree and match FHIR.
    const isGlucose = m.type === "BLOOD_GLUCOSE";
    return {
      type: m.type,
      value: isGlucose ? convertGlucose(m.value, glucoseUnit) : m.value,
      unit: isGlucose ? glucoseUnit : m.unit,
      measuredAt: formatTimestamp(m.measuredAt, userTz),
      source: m.source,
      notes: m.notes ?? "",
      glucoseContext: m.glucoseContext ?? "",
    };
  };

  if (granularity === "raw") {
    return measurements.map(toRecord);
  }

  // Split sleep stage rows out, collapse them per night, and merge back
  // in chronological order with the non-sleep rows.
  const sleepRows = measurements.filter((m) => m.type === "SLEEP_DURATION");
  if (sleepRows.length === 0) {
    return measurements.map(toRecord);
  }
  const other = measurements.filter((m) => m.type !== "SLEEP_DURATION");
  // `reconstructSleepSessions` clusters by wake-day using the user's tz;
  // fall back to UTC when no tz is threaded (admin / on-disk shape).
  const tz = opts.sleepTz ?? userTz ?? "UTC";
  const stageRows: SleepStageRow[] = sleepRows.map((m) => ({
    value: m.value,
    measuredAt: m.measuredAt,
    sleepStage: m.sleepStage ?? null,
    source: m.source as SleepStageRow["source"],
    deviceType: m.deviceType ?? null,
  }));
  const sessions = reconstructSleepSessions(
    stageRows,
    tz,
    opts.sourcePriorityJson ?? null,
  );
  const byDay = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const list = byDay.get(s.night) ?? [];
    list.push(s);
    byDay.set(s.night, list);
  }
  const nightRecords: Array<{ at: Date; rec: ExportableRecord }> = [];
  for (const daySessions of byDay.values()) {
    const { main, naps } = pickMainNightAndNaps(daySessions);
    if (!main) continue;
    const stageParts = (Object.entries(main.stages) as Array<[string, number]>)
      .filter(([, mins]) => mins > 0)
      .map(([stage, mins]) => `${stage}=${Math.round(mins)}m`)
      .join(" ");
    const napNote =
      naps.length > 0
        ? ` naps=${naps.length}(${Math.round(
            naps.reduce((sum, n) => sum + n.asleepMinutes, 0),
          )}m)`
        : "";
    const awakeningNote =
      main.awakenings > 0 ? ` awakenings=${main.awakenings}` : "";
    nightRecords.push({
      at: main.end,
      rec: {
        type: "SLEEP_DURATION",
        // Headline value = the main night's TIME ASLEEP in minutes.
        value: Math.round(main.asleepMinutes),
        unit: "minutes",
        measuredAt: formatTimestamp(main.end, userTz),
        source: main.source ?? "",
        notes: `${stageParts}${napNote}${awakeningNote}`.trim(),
        glucoseContext: "",
      },
    });
  }

  // Merge: keep the same descending-by-time order the route reads in.
  const merged: Array<{ at: Date; rec: ExportableRecord }> = [
    ...other.map((m) => ({ at: m.measuredAt, rec: toRecord(m) })),
    ...nightRecords,
  ];
  merged.sort((a, b) => b.at.getTime() - a.at.getTime());
  return merged.map((x) => x.rec);
}

/**
 * Format medications for export.
 */
export function formatMedicationsForExport(
  medications: Array<{
    name: string;
    dose: string;
    active: boolean;
    /** v1.39.1 (#1033) — false: kept as a record, intake not tracked. */
    trackIntake: boolean;
    schedules: Array<{
      windowStart: string;
      windowEnd: string;
      label: string | null;
      dose: string | null;
    }>;
  }>,
): ExportableRecord[] {
  return medications.map((m) => ({
    name: m.name,
    dose: m.dose,
    active: m.active,
    trackIntake: m.trackIntake,
    schedules: m.schedules
      .map(
        (s) =>
          `${s.label ? s.label + ": " : ""}${s.windowStart}-${s.windowEnd}${s.dose ? " (" + s.dose + ")" : ""}`,
      )
      .join("; "),
  }));
}

/**
 * Format intake events for export.
 *
 * `userTz` (optional) — see `formatMeasurementsForExport`.
 */
export function formatIntakeEventsForExport(
  events: Array<{
    medication: { name: string };
    scheduledFor: Date;
    takenAt: Date | null;
    skipped: boolean;
    source: string;
  }>,
  userTz?: string,
): ExportableRecord[] {
  return events.map((e) => ({
    medication: e.medication.name,
    scheduledFor: formatTimestamp(e.scheduledFor, userTz),
    takenAt: e.takenAt ? formatTimestamp(e.takenAt, userTz) : "",
    skipped: e.skipped,
    source: e.source,
  }));
}

/**
 * Format mood entries for export.
 *
 * `userTz` (optional) — see `formatMeasurementsForExport`. The
 * `date` column is a Berlin-anchored `YYYY-MM-DD` string in the
 * stored data (`MoodEntry.date`); the migration risk discussed in
 * §6.3 of the timezone proposal applies to that column specifically.
 * We do NOT rewrite the `date` column here — the read-side
 * interpretation lives where the field is consumed, not in the
 * export. Only `loggedAt` (the timestamptz) carries the user-tz
 * offset.
 */
export function formatMoodEntriesForExport(
  entries: Array<{
    date: string;
    mood: string;
    score: number;
    tags: string | null;
    /** Free-text note — exported in full so the texts are readable offline. */
    note?: string | null;
    source: string;
    moodLoggedAt: Date;
    /** The five level-A values, absent on entries written before they existed. */
    moodA1?: number | null;
    stressA2?: number | null;
    energyA3?: number | null;
    connectionA4?: number | null;
    stabilityA5?: number | null;
  }>,
  userTz?: string,
): ExportableRecord[] {
  return entries.map((e) => ({
    date: e.date,
    mood: e.mood,
    score: e.score,
    tags: e.tags ?? "",
    note: e.note ?? "",
    source: e.source,
    loggedAt: formatTimestamp(e.moodLoggedAt, userTz),
    // Appended after the existing columns rather than slotted in beside
    // `score`, because this file lands in somebody's spreadsheet and a column
    // that moves breaks every formula pointed at it. An unanswered value is an
    // empty cell, not a zero: zero is a real answer on this scale.
    a1: e.moodA1 ?? "",
    a2: e.stressA2 ?? "",
    a3: e.energyA3 ?? "",
    a4: e.connectionA4 ?? "",
    a5: e.stabilityA5 ?? "",
  }));
}
