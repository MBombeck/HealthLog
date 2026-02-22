/**
 * Export utilities — CSV, JSON, and ZIP generation.
 */

interface ExportableRecord {
  [key: string]: unknown;
}

/**
 * Convert records to CSV string.
 */
export function toCSV(records: ExportableRecord[]): string {
  if (records.length === 0) return "";

  const headers = Object.keys(records[0]);
  const lines = [headers.join(",")];

  for (const record of records) {
    const values = headers.map((h) => {
      const val = record[h];
      if (val === null || val === undefined) return "";
      const str = val instanceof Date ? val.toISOString() : String(val);
      // Escape CSV special characters
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    });
    lines.push(values.join(","));
  }

  return lines.join("\n");
}

/**
 * Format measurements for export.
 */
export function formatMeasurementsForExport(
  measurements: Array<{
    type: string;
    value: number;
    unit: string;
    measuredAt: Date;
    source: string;
    notes: string | null;
  }>,
): ExportableRecord[] {
  return measurements.map((m) => ({
    type: m.type,
    value: m.value,
    unit: m.unit,
    measuredAt: m.measuredAt.toISOString(),
    source: m.source,
    notes: m.notes ?? "",
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
 */
export function formatIntakeEventsForExport(
  events: Array<{
    medication: { name: string };
    scheduledFor: Date;
    takenAt: Date | null;
    skipped: boolean;
    source: string;
  }>,
): ExportableRecord[] {
  return events.map((e) => ({
    medication: e.medication.name,
    scheduledFor: e.scheduledFor.toISOString(),
    takenAt: e.takenAt?.toISOString() ?? "",
    skipped: e.skipped,
    source: e.source,
  }));
}

/**
 * Format mood entries for export.
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
): ExportableRecord[] {
  return entries.map((e) => ({
    date: e.date,
    mood: e.mood,
    score: e.score,
    tags: e.tags ?? "",
    source: e.source,
    loggedAt: e.moodLoggedAt.toISOString(),
  }));
}
