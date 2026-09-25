/**
 * Units-per-dose buttons for the web editor.
 *
 * The editor offers a CURATED set as buttons: the split-pill fractions
 * (¼ ⅓ ½ ⅔ ¾) plus a few whole numbers. Anything else (1½, 2¼, 0.8) goes
 * through the "Other" field, parsed by `parseUnitsPerDoseInput`. The payload
 * and the API carry the DECIMAL value; the button shows the glyph. The
 * fractions come from the same table the server rule and the formatter read
 * (`@/lib/medications/units-per-dose`), so a button can never offer a value
 * the server would refuse.
 */
import {
  UNITS_PER_DOSE_FRACTIONS,
  formatUnitsPerDose,
} from "@/lib/medications/units-per-dose";

/** The curated whole-number doses shown alongside the fractions. */
const WHOLE_OPTIONS = [1, 2, 3, 4] as const;

export interface UnitsPerDoseOption {
  /** Numeric value (e.g. 0.5). */
  value: number;
  /** The string stored in the wizard payload + sent to the API. */
  raw: string;
  /** Display glyph / number (e.g. "½", "2"). */
  label: string;
}

/** Curated button options: fractions first (½ reads naturally before 1), then wholes. */
export const UNITS_PER_DOSE_OPTIONS: UnitsPerDoseOption[] = [
  ...UNITS_PER_DOSE_FRACTIONS.map((f) => ({
    value: f.value,
    raw: String(f.value),
    label: f.glyph,
  })),
  ...WHOLE_OPTIONS.map((n) => ({
    value: n,
    raw: String(n),
    label: formatUnitsPerDose(n),
  })),
];

/** True when a payload string is exactly one of the curated buttons. */
export function isCuratedUnitsPerDose(raw: string): boolean {
  return UNITS_PER_DOSE_OPTIONS.some((o) => o.raw === raw);
}

/**
 * Round a unit count for display — drops the float noise a ⅓-dose
 * (0.3333/dose) leaves in a running remainder (29.6667 → 29.67). Whole
 * and ½ counts pass through unchanged.
 */
export function formatUnitCount(n: number): number {
  return Math.round(n * 100) / 100;
}
