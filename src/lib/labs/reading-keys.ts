/**
 * What makes two lab readings the same reading, and the text ceilings every
 * bulk lab write shares.
 *
 * Used by the CSV import (`src/lib/import/labs-csv.ts`) and the FHIR import
 * (`src/lib/labs/fhir-import/write.ts`), so a reading typed by hand, scanned,
 * imported from a spreadsheet or arriving from Apple Health is recognised as
 * one reading whichever way it came in first.
 */
import { labReadingDay } from "@/lib/labs/reading-day";

export const LAB_TEXT_LIMITS = {
  analyte: 200,
  valueText: 200,
  unit: 80,
  panel: 100,
  note: 1000,
} as const;

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
