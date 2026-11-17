/**
 * A FHIR `Quantity` unit in the spelling the labs feature uses.
 *
 * FHIR systems write UCUM codes (`10*3/uL`, `m[IU]/L`, `mL/min/{1.73_m2}`);
 * the labs catalog, the unit normaliser and the conversion registry speak the
 * printed spellings a report uses (`10^3/µL`, `mIU/L`, `mL/min/1.73m²`). The
 * table below covers the UCUM forms lab results actually carry that the
 * normaliser would not read on its own; anything else passes through as
 * written, which is already the printed form for `mg/dL`, `mmol/L`, `g/L`,
 * `U/L`, `%` and the like.
 */

const UCUM_TO_LAB: ReadonlyMap<string, string> = new Map([
  ["10*3/uL", "10^3/µL"],
  ["10*3/ul", "10^3/µL"],
  ["10*6/uL", "10^6/µL"],
  ["10*6/ul", "10^6/µL"],
  ["10*9/L", "10^9/L"],
  ["10*9/l", "10^9/L"],
  ["10*12/L", "10^12/L"],
  ["10*12/l", "10^12/L"],
  ["[IU]/L", "IU/L"],
  ["m[IU]/L", "mIU/L"],
  ["m[IU]/mL", "mIU/mL"],
  ["u[IU]/mL", "µIU/mL"],
  ["meq/L", "mEq/L"],
  ["/uL", "/µL"],
  ["mL/min/{1.73_m2}", "mL/min/1.73m²"],
  ["mL/min/1.73.m2", "mL/min/1.73m²"],
]);

/** A UCUM annotation alone (`{INR}`, `{ratio}`) is the unity. */
const ANNOTATION_ONLY = /^\{[^{}]*\}$/u;

/**
 * The lab spelling of a FHIR quantity's unit: a UCUM form the table knows
 * (the `code` first, then the human `unit`), else the human `unit` as written,
 * else the `code`. Null when neither says anything. The unity (`1`, or an
 * annotation alone such as `{INR}`) becomes "1".
 */
export function labUnitFromFhirQuantity(quantity: {
  unit?: unknown;
  code?: unknown;
}): string | null {
  const text = (raw: unknown): string | null =>
    typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
  const code = text(quantity.code);
  const unit = text(quantity.unit);
  for (const candidate of [code, unit]) {
    if (candidate === null) continue;
    const mapped = UCUM_TO_LAB.get(candidate);
    if (mapped) return mapped;
    if (candidate === "1" || ANNOTATION_ONLY.test(candidate)) return "1";
  }
  return unit ?? code;
}

/**
 * LOINC codes of lab results that are numbers without a unit: specific
 * gravity, pH and the INR. A system often sends them as a bare number with
 * no unit at all, and for these analytes that is the value, the UCUM unity
 * ("1"), not a unit that was dropped. Kept to codes whose meaning is settled;
 * an analyte that is not listed keeps the refusal of a number without a unit.
 */
const DIMENSIONLESS_LOINC: ReadonlySet<string> = new Set([
  // Specific gravity of urine (test strip, unspecified, refractometry).
  "5811-5",
  "2965-2",
  "53326-5",
  // pH of urine (test strip, unspecified), of blood and of arterial blood.
  "5803-2",
  "2756-5",
  "11558-4",
  "2744-1",
  // INR (platelet-poor plasma, blood, capillary blood).
  "6301-6",
  "34714-6",
  "46418-0",
]);

/** Whether a LOINC code names an analyte whose value has no unit. */
export function isDimensionlessLoinc(code: string | null): boolean {
  return code !== null && DIMENSIONLESS_LOINC.has(code.trim());
}
