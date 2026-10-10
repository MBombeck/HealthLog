/**
 * Units that differ only by a power of ten.
 *
 * A pair of units inside one family cannot change the quantity, only the
 * prefix, so it needs no analyte: `mg/L` to `g/dL` is the same for every
 * marker. A pair across families (mass to amount, `mg/dL` to `mmol/L`) is NOT a
 * scale pair, because it needs the analyte's molar mass; those live only in the
 * registry, per analyte.
 *
 * Every unit is stored as its power of ten relative to its family's base unit,
 * computed from the prefix and the volume, not typed.
 */
import { normaliseLabUnit } from "../unit-normalise";

type FamilyName = "mass" | "amount" | "activity" | "count";

const MASS_PREFIX: ReadonlyArray<[string, number]> = [
  ["g", 0],
  ["mg", -3],
  ["µg", -6],
  ["ng", -9],
  ["pg", -12],
];
const AMOUNT_PREFIX: ReadonlyArray<[string, number]> = [
  ["mol", 0],
  ["mmol", -3],
  ["µmol", -6],
  ["nmol", -9],
  ["pmol", -12],
];
/** Litres per volume unit, as a power of ten. */
const VOLUME: Readonly<Record<string, number>> = {
  L: 0,
  dL: -1,
  mL: -3,
  µL: -6,
};

/** The mass-concentration units a lab prints, with the volumes they print on. */
const MASS_UNITS: ReadonlyArray<[string, string]> = [
  ["g", "L"],
  ["g", "dL"],
  ["mg", "L"],
  ["mg", "dL"],
  ["µg", "L"],
  ["µg", "dL"],
  ["ng", "L"],
  ["ng", "mL"],
  ["ng", "dL"],
  ["pg", "mL"],
];

const exponent = (table: ReadonlyArray<[string, number]>, prefix: string) =>
  table.find(([name]) => name === prefix)![1];

/** unit -> [family, power of ten relative to the family's base unit]. */
const SCALE_UNITS: ReadonlyMap<string, readonly [FamilyName, number]> = new Map<
  string,
  readonly [FamilyName, number]
>([
  // Base: g/L.
  ...MASS_UNITS.map(
    ([prefix, volume]) =>
      [
        `${prefix}/${volume}`,
        ["mass", exponent(MASS_PREFIX, prefix) - VOLUME[volume]],
      ] as const,
  ),
  // Base: mol/L.
  ...AMOUNT_PREFIX.map(
    ([prefix, power]) => [`${prefix}/L`, ["amount", power - VOLUME.L]] as const,
  ),
  // Base: IU/L. `µIU/mL` is `mIU/L`.
  ["IU/L", ["activity", 0]] as const,
  ["mIU/L", ["activity", -3]] as const,
  ["µIU/mL", ["activity", -6 - VOLUME.mL]] as const,
  // Base: 10^9/L. A blood count is printed either way.
  ["10⁹/L", ["count", 9]] as const,
  ["10^9/L", ["count", 9]] as const,
  ["G/L", ["count", 9]] as const,
  ["10³/µL", ["count", 3 - VOLUME.µL]] as const,
  ["10^3/µL", ["count", 3 - VOLUME.µL]] as const,
  ["10¹²/L", ["count", 12]] as const,
  ["10^12/L", ["count", 12]] as const,
  ["T/L", ["count", 12]] as const,
  ["10⁶/µL", ["count", 6 - VOLUME.µL]] as const,
  ["10^6/µL", ["count", 6 - VOLUME.µL]] as const,
]);

export interface ScaleUnit {
  family: FamilyName;
  /** Power of ten of one of this unit, in the family's base unit. */
  exponent: number;
}

/** The family a unit belongs to, or null for a unit that has none. */
export function scaleUnitOf(unit: string): ScaleUnit | null {
  const found = SCALE_UNITS.get(normaliseLabUnit(unit));
  return found ? { family: found[0], exponent: found[1] } : null;
}

/** Multiply by `10^power`, dividing for a negative power: `10^-3` is not exact. */
export function shiftPowerOfTen(value: number, power: number): number {
  if (power === 0) return value;
  return power > 0 ? value * 10 ** power : value / 10 ** -power;
}

/**
 * `value` in `from`, written in `to`, when both are in the same family;
 * null when either is in none or they are in different families.
 */
export function convertByScale(
  value: number,
  from: string,
  to: string,
): number | null {
  const a = scaleUnitOf(from);
  const b = scaleUnitOf(to);
  if (!a || !b || a.family !== b.family) return null;
  return shiftPowerOfTen(value, a.exponent - b.exponent);
}

/** Every unit that has a family, in its spelling here. */
export function scaleUnitsInFamilyOf(unit: string): string[] {
  const own = scaleUnitOf(unit);
  if (!own) return [];
  return [...SCALE_UNITS.entries()]
    .filter(([, [family]]) => family === own.family)
    .map(([spelling]) => spelling);
}
