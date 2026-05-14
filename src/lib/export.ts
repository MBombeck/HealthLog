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
 */
export function toCSV(
  records: ExportableRecord[],
  headerLabels?: Record<string, string>,
): string {
  if (records.length === 0) return "";

  const headers = Object.keys(records[0]);
  const headerLine = headerLabels
    ? headers.map((h) => escapeCsvCell(headerLabels[h] ?? h)).join(",")
    : headers.map(escapeCsvCell).join(",");
  const lines = [headerLine];

  for (const record of records) {
    const values = headers.map((h) => {
      const val = record[h];
      if (val === null || val === undefined) return "";
      const str = val instanceof Date ? val.toISOString() : String(val);
      return escapeCsvCell(str);
    });
    lines.push(values.join(","));
  }

  return lines.join("\n");
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

/**
 * Format measurements for export.
 *
 * `userTz` (optional) — when provided, `measuredAt` is emitted as
 * ISO-8601 with the user's UTC offset (e.g. `+02:00` in Berlin in
 * May) instead of the bare `Z` suffix. See module-level docstring
 * for the rationale (issue #167).
 */
export function formatMeasurementsForExport(
  measurements: Array<{
    type: string;
    value: number;
    unit: string;
    measuredAt: Date;
    source: string;
    notes: string | null;
    glucoseContext?: string | null;
  }>,
  userTz?: string,
): ExportableRecord[] {
  return measurements.map((m) => ({
    type: m.type,
    value: m.value,
    unit: m.unit,
    measuredAt: formatTimestamp(m.measuredAt, userTz),
    source: m.source,
    notes: m.notes ?? "",
    glucoseContext: m.glucoseContext ?? "",
  }));
}

/**
 * Format medications for export.
 */
export function formatMedicationsForExport(
  medications: Array<{
    name: string;
    dose: string;
    active: boolean;
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
    source: string;
    moodLoggedAt: Date;
  }>,
  userTz?: string,
): ExportableRecord[] {
  return entries.map((e) => ({
    date: e.date,
    mood: e.mood,
    score: e.score,
    tags: e.tags ?? "",
    source: e.source,
    loggedAt: formatTimestamp(e.moodLoggedAt, userTz),
  }));
}
