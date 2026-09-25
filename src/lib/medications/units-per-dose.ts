/**
 * Units per dose: the one rule, the input parser and the display format.
 *
 * `Medication.unitsPerDose`, the per-schedule override and the intake stamp
 * are all `Decimal(10,4)`. The rule accepts exactly what that column stores
 * without rounding: a value above 0 and at most 100 with at most four
 * decimal places. That covers whole tablets (2), split tablets (½, ⅓), a
 * whole number plus a fraction (1½, 2¼, #1034) and a measured liquid dose
 * (0.8 or 2.4 mL when a bottle is tracked in millilitres).
 *
 * The inventory arithmetic is plain division and subtraction on these
 * numbers (`floor(unitsRemaining / unitsPerDose)`, the consumption loop's
 * `owed -= take`), and every write back to a Decimal(10,4) column rounds to
 * four places, so a free decimal behaves exactly like the thirds that were
 * already allowed.
 *
 * No imports: the web editor bundles this module, and the server validators
 * read the same rule from it.
 */

/** Largest units-per-dose value any write path accepts. */
export const UNITS_PER_DOSE_MAX = 100;

/** Decimal places the column keeps. */
const DECIMALS = 4;
const SCALE = 10 ** DECIMALS;

/**
 * The fractions with a glyph. The web editor offers them as buttons and the
 * formatter renders them; thirds are inexact in decimal and are stored as
 * 0.3333 / 0.6667.
 */
export const UNITS_PER_DOSE_FRACTIONS: ReadonlyArray<{
  value: number;
  glyph: string;
}> = [
  { value: 0.25, glyph: "¼" },
  { value: 0.3333, glyph: "⅓" },
  { value: 0.5, glyph: "½" },
  { value: 0.6667, glyph: "⅔" },
  { value: 0.75, glyph: "¾" },
];

export const UNITS_PER_DOSE_MESSAGE =
  "unitsPerDose must be above 0 and at most 100, with at most 4 decimal places (e.g. 1, 0.5, 1.5, 2.25)";

/** Round to the column's four decimal places. */
function roundToColumn(value: number): number {
  return Math.round(value * SCALE) / SCALE;
}

export function isSupportedUnitsPerDose(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (value <= 0 || value > UNITS_PER_DOSE_MAX) return false;
  // At most four decimal places. The tolerance absorbs binary float noise
  // (1.3333 * 10000 = 13332.999999999998), not a fifth digit.
  const scaled = value * SCALE;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

const GLYPH_VALUE = new Map(
  UNITS_PER_DOSE_FRACTIONS.map((f) => [f.glyph, f.value]),
);

/** "7", "7.5", "7,5" — one number, either decimal separator. */
function parsePlainNumber(raw: string): number | null {
  if (!/^\d+(?:[.,]\d+)?$|^[.,]\d+$/.test(raw)) return null;
  return Number(raw.replace(",", "."));
}

/** "3/4" — a simple fraction with a non-zero denominator. */
function parseSlashFraction(raw: string): number | null {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(raw);
  if (!m) return null;
  const denominator = Number(m[2]);
  if (denominator === 0) return null;
  return Number(m[1]) / denominator;
}

/**
 * Read what a person typed into the "Other" field: "1.5", "1,5" (either
 * separator, whatever the locale, since a value up to 100 never needs a
 * thousands separator), "1 1/2", "3/4", "1½" or "½". Returns the value
 * rounded to the column's four places, or `null` when it is not a number
 * the server would accept. Never falls back to `parseFloat`, which reads
 * "1,5" as 1.
 */
export function parseUnitsPerDoseInput(raw: string): number | null {
  const text = raw.trim();
  if (text === "") return null;

  let value: number | null = null;

  // A trailing glyph, optionally after a whole number: "½", "1½", "1 ½".
  const glyph = GLYPH_VALUE.get(text.slice(-1));
  if (glyph !== undefined) {
    const whole = text.slice(0, -1).trim();
    if (whole === "") value = glyph;
    else if (/^\d+$/.test(whole)) value = Number(whole) + glyph;
  } else {
    // "1 1/2" — a whole number, whitespace, a fraction.
    const mixed = /^(\d+)\s+(\d+\s*\/\s*\d+)$/.exec(text);
    if (mixed) {
      const fraction = parseSlashFraction(mixed[2]);
      if (fraction !== null) value = Number(mixed[1]) + fraction;
    } else {
      value = parseSlashFraction(text) ?? parsePlainNumber(text);
    }
  }

  if (value === null) return null;
  // A typed fraction such as 1/3 is rounded to the stored 0.3333; a typed
  // decimal with a fifth place is refused rather than silently rounded.
  const isTypedDecimal = parsePlainNumber(text) !== null;
  const candidate = isTypedDecimal ? value : roundToColumn(value);
  return isSupportedUnitsPerDose(candidate) ? roundToColumn(candidate) : null;
}

/**
 * Render a stored value: "½", "1½", "2¼", "1⅓" when the fractional part has
 * a glyph, "2" for a whole number, and otherwise the decimal in the reader's
 * locale ("1,2" in German). Without a locale the decimal uses a point.
 */
export function formatUnitsPerDose(value: number, locale?: string): string {
  const whole = Math.floor(value + 1e-9);
  const fraction = value - whole;
  if (fraction < 0.0005) return String(whole);
  const hit = UNITS_PER_DOSE_FRACTIONS.find(
    (f) => Math.abs(f.value - fraction) < 0.0005,
  );
  if (hit) return whole > 0 ? `${whole}${hit.glyph}` : hit.glyph;
  const rounded = roundToColumn(value);
  if (!locale) return String(rounded);
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: DECIMALS,
    useGrouping: false,
  }).format(rounded);
}
