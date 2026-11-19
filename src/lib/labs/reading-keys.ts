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
 * A censored result (`<5`, `>= 90 mL/min`): the number it is bounded by, and
 * the unit printed after it, lower-cased, when there is one. Null for any
 * other text. Migration 0513 reads the same shape in SQL.
 */
const CENSORED = /^\s*(?:<=|>=|≤|≥|<|>)\s*(-?\d+(?:\.\d+)?)(?:\s+(\S.*?))?\s*$/;

export function censoredBound(
  text: string,
): { value: number; unit: string | null } | null {
  const match = CENSORED.exec(text);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  return { value, unit: match[2] ? match[2].trim().toLowerCase() : null };
}

/**
 * The keys a reading is a duplicate under, mirroring the scan commit's
 * `isDuplicate`: the marker (or the name, for a reading filed without one),
 * the reading's calendar day, and the value as stored, as printed, or as text.
 *
 * A censored text result also answers to the number it is bounded by (#1421):
 * a report's `<5` and the 5 already typed from the same report are one
 * reading, whichever arrived first.
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
    const bound = censoredBound(reading.valueText);
    if (bound) {
      keys.push(`${who}|${day}|n:${bound.value}`);
      if (bound.unit) keys.push(`${who}|${day}|s:${bound.value}:${bound.unit}`);
    }
  }
  return keys;
}
