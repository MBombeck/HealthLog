/**
 * HealthKit unit normalisation (issue #944).
 *
 * Apple writes a `unit` attribute on every quantity `<Record>` of an
 * `export.xml` archive, and the string it writes is the account's OWN
 * display unit rather than the unit HealthLog's mapping table assumes:
 * a metric account exports walking distance as `km`, an imperial one as
 * `mi`, and the same split shows up on body mass (`kg` / `lb` / `st`),
 * energy (`kcal` / `kJ`) and temperature (`degC` / `degF`).
 *
 * Before this module the export import fed the raw number straight into
 * `AppleHealthMapping.convertToDbUnit`, which is written against the
 * table's fixed `hkUnit` — so a 2.484 km day was stored as 2.484 m. The
 * workout path had a hand-rolled km/mi→m branch of its own; both paths
 * now share `convertHkValue()`.
 *
 * Contract, deliberately conservative:
 *
 *   - Same unit in and out → the value is returned untouched, so an
 *     archive (or an iOS batch) that already speaks the table's unit is
 *     byte-for-byte unchanged.
 *   - Unknown unit, empty unit, or two units from different families →
 *     `null`, and every caller falls back to the raw value. A unit we
 *     cannot prove a factor for must never silently rescale a reading.
 *   - Only units Apple's `HKUnit` can actually emit are listed. A unit
 *     string is matched exactly (after trimming and after stripping the
 *     molar-mass annotation Apple writes on glucose), never lower-cased:
 *     `cal` (small calorie) and `Cal` (kilocalorie) are different units
 *     that differ only in case.
 */

interface HkUnitSpec {
  /** Units convert only within one family. */
  family: string;
  /** This unit → the family's base unit. */
  toBase: (value: number) => number;
  /** The family's base unit → this unit. */
  fromBase: (value: number) => number;
}

/** A unit that is a plain multiple of its family's base unit. */
function scaled(family: string, perBase: number): HkUnitSpec {
  return {
    family,
    toBase: (value) => value * perBase,
    fromBase: (value) => value / perBase,
  };
}

/**
 * Every unit string Apple emits that HealthLog can convert, keyed by the
 * exact `HKUnit.unitString` spelling. Base units: metre, kilogram,
 * kilocalorie, second, degree Celsius, mmHg, mg/dL, metres per second.
 */
const HK_UNITS: Record<string, HkUnitSpec> = {
  // ── Length (base: metre) ───────────────────────────────────
  m: scaled("length", 1),
  km: scaled("length", 1000),
  cm: scaled("length", 0.01),
  mm: scaled("length", 0.001),
  in: scaled("length", 0.0254),
  ft: scaled("length", 0.3048),
  yd: scaled("length", 0.9144),
  mi: scaled("length", 1609.344),

  // ── Mass (base: kilogram) ──────────────────────────────────
  kg: scaled("mass", 1),
  g: scaled("mass", 0.001),
  lb: scaled("mass", 0.45359237),
  oz: scaled("mass", 0.028349523125),
  st: scaled("mass", 6.35029318),

  // ── Energy (base: kilocalorie) ─────────────────────────────
  kcal: scaled("energy", 1),
  Cal: scaled("energy", 1), // Apple's large calorie == kilocalorie
  cal: scaled("energy", 0.001), // small calorie — case is load-bearing
  kJ: scaled("energy", 1 / 4.184),
  J: scaled("energy", 1 / 4184),

  // ── Time (base: second) ────────────────────────────────────
  s: scaled("time", 1),
  ms: scaled("time", 0.001),
  min: scaled("time", 60),
  hr: scaled("time", 3600),
  d: scaled("time", 86_400),

  // ── Pressure (base: mmHg) ──────────────────────────────────
  mmHg: scaled("pressure", 1),
  kPa: scaled("pressure", 7.500_616_827_041_698),
  Pa: scaled("pressure", 0.007_500_616_827_041_698),

  // ── Blood glucose (base: mg/dL) ────────────────────────────
  // Apple annotates the molar unit with glucose's molar mass, which the
  // normaliser strips before the lookup.
  "mg/dL": scaled("glucose", 1),
  "mmol/L": scaled("glucose", 18.0156), // 180.156 g/mol ÷ 10

  // ── Speed (base: metres per second) ────────────────────────
  "m/s": scaled("speed", 1),
  "km/hr": scaled("speed", 1000 / 3600),
  "mi/hr": scaled("speed", 1609.344 / 3600),

  // ── Temperature (base: degree Celsius) — affine, not scaled ─
  degC: {
    family: "temperature",
    toBase: (value) => value,
    fromBase: (value) => value,
  },
  degF: {
    family: "temperature",
    toBase: (value) => ((value - 32) * 5) / 9,
    fromBase: (value) => (value * 9) / 5 + 32,
  },
  K: {
    family: "temperature",
    toBase: (value) => value - 273.15,
    fromBase: (value) => value + 273.15,
  },
};

/**
 * Apple writes molar units with the substance's molar mass inline —
 * `mmol<180.156>/L` for blood glucose. The annotation is a number and
 * informational; strip exactly that shape so the lookup sees the plain
 * unit. Anything else between angle brackets is not a unit Apple writes
 * and stays unknown.
 */
const MOLAR_MASS_ANNOTATION = /<\d+(?:\.\d+)?>/g;

function normaliseUnitString(unit: string): string {
  return unit.trim().replace(MOLAR_MASS_ANNOTATION, "");
}

function lookup(unit: string | null | undefined): HkUnitSpec | null {
  if (typeof unit !== "string") return null;
  const normalised = normaliseUnitString(unit);
  if (!normalised) return null;
  return HK_UNITS[normalised] ?? null;
}

/**
 * `true` when this module knows a conversion factor for the unit — i.e.
 * a `<Record>` that carries a sibling unit from the same family will be
 * converted rather than trusted blindly. The mapping-table guard in
 * `src/__tests__/apple-health-unit-audit-guard.test.ts` uses this to
 * decide whether an entry's fixed `hkUnit` needs a written reason.
 */
export function isConvertibleHkUnit(unit: string | null | undefined): boolean {
  return lookup(unit) !== null;
}

/**
 * Convert a HealthKit value between two `HKUnit` strings. Returns `null`
 * — never a guess — when either unit is unknown or the two belong to
 * different families; callers keep the raw value in that case.
 */
export function convertHkValue(
  value: number,
  fromUnit: string | null | undefined,
  toUnit: string,
): number | null {
  if (!Number.isFinite(value)) return null;
  const from = lookup(fromUnit);
  if (!from) return null;
  const to = lookup(toUnit);
  if (!to) return null;
  if (from.family !== to.family) return null;
  // Same unit: return the reading untouched rather than round-tripping it
  // through the base and picking up a float error.
  if (normaliseUnitString(String(fromUnit)) === normaliseUnitString(toUnit)) {
    return value;
  }
  return to.fromBase(from.toBase(value));
}

/**
 * Convert a distance a HealthKit archive reports in its own unit into
 * metres, the canonical DB unit. Falls back to the raw number for a unit
 * this module cannot place (including the empty attribute an archive may
 * write) — the pre-#944 behaviour of the workout path, preserved.
 */
export function hkDistanceToMetres(
  value: number,
  unit: string | null | undefined,
): number {
  return convertHkValue(value, unit, "m") ?? value;
}
