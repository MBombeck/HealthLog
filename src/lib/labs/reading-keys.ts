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
import { dateOnlyKey } from "@/lib/tz/date-only";
import { normaliseLabUnit } from "@/lib/labs/unit-normalise";

export const LAB_TEXT_LIMITS = {
  analyte: 200,
  valueText: 200,
  unit: 80,
  panel: 100,
  note: 1000,
} as const;

/**
 * A censored result (`<5`, `>= 90 mL/min`): the number it is bounded by, and
 * the unit printed after it, trimmed, when there is one. Null for any other
 * text. Migration 0513 reads the same shape in SQL.
 */
const CENSORED = /^\s*(?:<=|>=|≤|≥|<|>)\s*(-?\d+(?:\.\d+)?)(?:\s+(\S.*?))?\s*$/;

export function censoredBound(
  text: string,
): { value: number; unit: string | null } | null {
  const match = CENSORED.exec(text);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  return { value, unit: match[2] ? match[2].trim() : null };
}

const DAY_MS = 86_400_000;
const NOON_MS = 43_200_000;

/**
 * When a reading was taken, as precisely as it says: a date-only reading
 * (stored at UTC midnight or noon, see `labReadingDay`) is its date, any
 * other is its exact instant.
 */
function effectiveInstant(takenAt: Date): string {
  const ms = takenAt.getTime();
  const msOfDay = ((ms % DAY_MS) + DAY_MS) % DAY_MS;
  return msOfDay === 0 || msOfDay === NOON_MS
    ? `d:${dateOnlyKey(takenAt)}`
    : `t:${ms}`;
}

/** The columns of a stored reading `readingKeys` reads. */
export const READING_KEY_SELECT = {
  biomarkerId: true,
  analyte: true,
  takenAt: true,
  value: true,
  valueText: true,
  sourceValue: true,
  sourceUnit: true,
  unit: true,
} as const;

/**
 * The keys a reading is a duplicate under, mirroring the scan commit's
 * `isDuplicate`: the marker (or the name, for a reading filed without one),
 * the reading's calendar day, and the value as stored, as printed, or as text.
 *
 * A censored text result also answers to the number it is bounded by (#1421):
 * a report's `<5` and the 5 already typed from the same report are one
 * reading, whichever arrived first. That match is narrower than the day: the
 * two must have been taken at the same effective instant (the same date when
 * both state a date only, the same moment otherwise) and state the number in
 * the same unit. Serial draws on one day (a troponin at 0 h `<5`, at 3 h `5`)
 * stay two readings, and a bound in the printed unit never meets a value
 * stored in another.
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
    /** The unit `value` is stored in, when the reading has been stored. */
    unit?: string | null;
  },
  tz: string,
): string[] {
  const who = reading.biomarkerId
    ? `bm:${reading.biomarkerId}`
    : `an:${reading.analyte.trim().toLowerCase()}`;
  const day = labReadingDay(reading.takenAt, tz);
  const at = effectiveInstant(reading.takenAt);
  const bounded = (value: number, unit: string | null | undefined) =>
    `${who}|${at}|c:${value}:${normaliseLabUnit(unit ?? "")}`;
  const keys: string[] = [];
  if (reading.value !== null) {
    keys.push(`${who}|${day}|n:${reading.value}`);
    if (reading.unit !== undefined && reading.unit !== null) {
      keys.push(bounded(reading.value, reading.unit));
    }
  }
  if (
    reading.sourceValue !== null &&
    reading.sourceValue !== undefined &&
    reading.sourceUnit
  ) {
    keys.push(
      `${who}|${day}|s:${reading.sourceValue}:${reading.sourceUnit.trim().toLowerCase()}`,
    );
    keys.push(bounded(reading.sourceValue, reading.sourceUnit));
  }
  if (reading.valueText !== null) {
    keys.push(`${who}|${day}|t:${reading.valueText.trim().toLowerCase()}`);
    const bound = censoredBound(reading.valueText);
    if (bound) {
      keys.push(
        bounded(bound.value, bound.unit ?? reading.sourceUnit ?? reading.unit),
      );
    }
  }
  return keys;
}
