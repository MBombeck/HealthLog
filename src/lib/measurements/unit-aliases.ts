/**
 * v1.32.26 — shared inbound unit-alias resolver.
 *
 * Canonical storage is SI (`getUnitForType`). A few write paths accept a
 * caller-supplied unit string and must normalise it to the canonical unit
 * (converting the value) or refuse it outright — they must NEVER persist a
 * non-canonical unit verbatim, or the row's `unit` column stops being an
 * invariant and every display surface that trusts it silently mislabels.
 *
 * This is the single resolver behind both inbound paths that take a unit
 * string: the CSV importer (`csv-measurements.ts`) and the MCP
 * `log_measurement` tool (`mcp/writes.ts`). It recognises the canonical unit
 * (case-insensitively) and a closed set of common aliases (lb/lbs/pound(s),
 * in/inch(es), °F, mmol/L); anything else returns `null` so the caller can
 * skip / refuse rather than mis-store.
 *
 * Pure + side-effect-free; safe to import from an API route or a script.
 */
import { getUnitForType } from "@/lib/validations/measurement";
import { MGDL_PER_MMOL } from "@/lib/glucose";
/** Exact pound → kilogram (1 lb = 0.45359237 kg). */
const LB_TO_KG = 0.45359237;
/** Exact inch → centimetre (1 in = 2.54 cm). */
const IN_TO_CM = 2.54;

/** Body-mass metrics stored in kg — a lb value converts, all others skip. */
const MASS_TYPES: ReadonlySet<string> = new Set([
  "WEIGHT",
  "TOTAL_BODY_WATER",
  "BONE_MASS",
  "FAT_MASS",
  "FAT_FREE_MASS",
  "MUSCLE_MASS",
  "LEAN_BODY_MASS",
  "GRIP_STRENGTH",
]);

/** Absolute-temperature metrics stored in °C (canonical string "celsius"). */
const TEMPERATURE_TYPES: ReadonlySet<string> = new Set([
  "BODY_TEMPERATURE",
  "SKIN_TEMPERATURE",
  "WRIST_TEMPERATURE",
]);

const LB_ALIASES: ReadonlySet<string> = new Set([
  "lb",
  "lbs",
  "pound",
  "pounds",
]);
const IN_ALIASES: ReadonlySet<string> = new Set(["in", "inch", "inches", '"']);
const FAHRENHEIT_ALIASES: ReadonlySet<string> = new Set([
  "f",
  "°f",
  "fahrenheit",
]);
const CELSIUS_ALIASES: ReadonlySet<string> = new Set(["c", "°c", "celsius"]);
const MMOL_ALIASES: ReadonlySet<string> = new Set(["mmol/l", "mmol"]);

export interface CanonicalUnitResult {
  /** The value expressed in the canonical unit. */
  value: number;
  /** The canonical unit string (`getUnitForType(type)`). */
  unit: string;
}

/**
 * Resolve `(type, value, rawUnit)` to `{ value, unit }` in the canonical
 * unit, or `null` when `rawUnit` is neither the canonical unit nor a
 * recognised alias. Never mis-stores: an unknown unit is a hard `null`.
 */
export function resolveToCanonicalUnit(
  type: string,
  value: number,
  rawUnit: string,
): CanonicalUnitResult | null {
  const canonical = getUnitForType(type);
  const trimmed = rawUnit.trim();
  const lower = trimmed.toLowerCase();

  // Canonical match (case-insensitive: "mg/dL" vs "MG/DL", "kg" vs "KG").
  if (lower === canonical.toLowerCase()) {
    return { value, unit: canonical };
  }

  // Glucose: mmol/L → mg/dL.
  if (type === "BLOOD_GLUCOSE" && MMOL_ALIASES.has(lower)) {
    // Kept to a tenth of a mg/dL: a mmol/L figure carries no more than
    // that, and the unrounded product (5.55 × 18.0182 = 99.99999…) is not
    // the reading it was written from.
    return {
      value: Math.round(value * MGDL_PER_MMOL * 10) / 10,
      unit: canonical,
    };
  }

  // Body mass: lb → kg.
  if (MASS_TYPES.has(type) && LB_ALIASES.has(lower)) {
    return { value: value * LB_TO_KG, unit: canonical };
  }

  // Waist circumference: in → cm.
  if (type === "WAIST_CIRCUMFERENCE" && IN_ALIASES.has(lower)) {
    return { value: value * IN_TO_CM, unit: canonical };
  }

  // Absolute temperature: °F → °C (affine), or an explicit °C spelling.
  if (TEMPERATURE_TYPES.has(type)) {
    if (FAHRENHEIT_ALIASES.has(lower)) {
      return { value: (value - 32) / 1.8, unit: canonical };
    }
    if (CELSIUS_ALIASES.has(lower)) {
      return { value, unit: canonical };
    }
  }

  return null;
}
