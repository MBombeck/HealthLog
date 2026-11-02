/**
 * Shared lab-value number formatting.
 *
 * Every surface that prints a lab reading (the list card, the detail history,
 * the chart tooltip, the doctor report PDF, the clinician share page) prints
 * it through here, so a reading reads the same everywhere. The precision rule
 * is the recorded-number rule in `src/lib/format/recorded-number.ts`: a
 * reading keeps every digit it was stored with (TSH 0.004, PSA 0.034, a
 * troponin of 0.0012 never shortened), and a reading converted from the unit
 * its report printed keeps the precision of the printed figure.
 *
 * The digits themselves come from the caller's locale number formatter, so a
 * German reader sees "1,8 mIU/L" where an English one sees "1.8 mIU/L". This
 * module only decides the precision.
 */
import { withLabUnit } from "@/lib/labs/dimensionless";
import {
  formatRecordedNumber,
  type FractionDigitsFormat,
} from "@/lib/format/recorded-number";

/**
 * A lab number in the reader's locale. `printed` is the figure the source
 * report printed when the number was converted from it (`sourceValue`).
 */
export type LabNumberFormat = (
  value: number,
  printed?: number | null,
) => string;

export function formatLabValue(
  value: number,
  formatNumber: FractionDigitsFormat,
  printed?: number | null,
): string {
  return formatRecordedNumber(value, formatNumber, printed);
}

/**
 * Render a reading's display value: a qualitative row (numeric `value` is
 * null) shows its `valueText` verbatim; a numeric row shows the formatted
 * number plus its unit (none for a dimensionless reading). One helper so the list card, the history rows, and
 * the detail header stay consistent.
 */
export function formatLabReading(
  reading: {
    value: number | null;
    valueText: string | null;
    unit: string;
    sourceValue?: number | null;
  },
  formatNumber: LabNumberFormat,
): string {
  if (reading.value === null) {
    return reading.valueText ?? "";
  }
  return withLabUnit(
    formatNumber(reading.value, reading.sourceValue),
    reading.unit,
  );
}
