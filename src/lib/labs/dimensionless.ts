/**
 * The unit of a lab value that has none.
 *
 * A ratio (total cholesterol over HDL, albumin over globulin) or an index
 * (INR) is a number without a unit. It is stored and sent as the UCUM unity
 * `"1"`, never as an empty unit: an empty unit on a numeric reading is what an
 * extraction leaves behind when it dropped the unit, and every write path
 * refuses it for that reason. `"1"` is a choice somebody made on purpose.
 *
 * For every comparison `"1"` is an ordinary unit. It matches only itself, so
 * a reading without a unit is refused under a marker kept in mg/dL and the
 * other way round. Only the display differs: nobody wants "3.6 1", so the
 * helpers below render the unity as nothing beside a value.
 *
 * Pure and dependency-free.
 */

/** The UCUM unit of a dimensionless quantity. */
export const DIMENSIONLESS_UNIT = "1";

/** Whether a stored or stated unit is the explicit "no unit" choice. */
export function isDimensionlessUnit(unit: string | null | undefined): boolean {
  return typeof unit === "string" && unit.trim() === DIMENSIONLESS_UNIT;
}

/** The unit as it reads beside a value: trimmed, and empty for the unity. */
export function labUnitText(unit: string | null | undefined): string {
  if (typeof unit !== "string") return "";
  const trimmed = unit.trim();
  return trimmed === DIMENSIONLESS_UNIT ? "" : trimmed;
}

/** A formatted number followed by its unit, or the number alone. */
export function withLabUnit(
  number: string,
  unit: string | null | undefined,
): string {
  const shown = labUnitText(unit);
  return shown ? `${number} ${shown}` : number;
}

/**
 * The unit where it stands on its own (a column, a marker's subtitle, a
 * sentence naming it): the localised "no unit" label for the unity, the unit
 * itself otherwise.
 */
export function labUnitLabel(
  unit: string | null | undefined,
  t: (key: string) => string,
): string {
  return isDimensionlessUnit(unit) ? t("labs.unit.none") : labUnitText(unit);
}

/** How the API contract describes a lab unit field. */
export const LAB_UNIT_DESCRIPTION =
  'The unit the value is in, free-form as the report prints it (e.g. `mg/dL`). `"1"`, the UCUM unity, means the value has no unit: a ratio or an index such as INR or cholesterol/HDL. It is an explicit choice and a unit of its own: it matches only `"1"`, so a reading without a unit is refused under a marker kept in a real unit and the other way round. Clients show nothing beside such a value. An empty unit on a numeric value is never read as `"1"` and stays refused.';
