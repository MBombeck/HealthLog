/**
 * Convert a lab value, or a reference range, between units. Pure, no I/O.
 *
 * The rules, in order:
 *
 *   1. The same unit written two ways (`mmol/l`, `mmol/L`) is the same unit and
 *      the value is returned as it is.
 *   2. Two units in one scale family (`mg/L`, `g/dL`) convert by their power of
 *      ten, for any analyte, with no key. This is `via: "scale"`.
 *   3. Anything else needs the analyte's entry in the registry (`via:
 *      "analyte"`): each unit is moved to a unit the entry lists by scale where
 *      needed, then unit -> hub -> unit.
 *
 * Everything else is a refusal, never a guess: an unknown unit, an analyte with
 * no entry, a value that is not finite. A mass to amount pair asked for without
 * an analyte key is an `unknown_analyte` refusal: it is never a scale pair.
 */
import { normaliseLabUnit } from "../unit-normalise";
import {
  analyteConversionFor,
  type Affine,
  type AnalyteConversion,
} from "./registry";
import { scaleUnitOf, scaleUnitsInFamilyOf, shiftPowerOfTen } from "./scale";

export type ConversionRefusal =
  "unknown_analyte" | "unknown_unit" | "not_finite";

export type ConvertedValue =
  | { ok: true; value: number; via: "analyte" | "scale" }
  | { ok: false; reason: ConversionRefusal };

export interface ConvertLabValueInput {
  /** Catalog slug or registry key of the marker's analyte; null when it has none. */
  analyteKey: string | null | undefined;
  value: number;
  from: string;
  to: string;
}

/** `unit` written as one of the entry's own units, by scale where it is not one. */
function intoEntryUnit(
  entry: AnalyteConversion,
  unit: string,
): { entryUnit: string; affine: Affine; shift: number } | null {
  const norm = normaliseLabUnit(unit);
  const direct = entry.units[norm];
  if (direct) return { entryUnit: norm, affine: direct, shift: 0 };
  const own = scaleUnitOf(norm);
  if (!own) return null;
  for (const [entryUnit, affine] of Object.entries(entry.units)) {
    const candidate = scaleUnitOf(entryUnit);
    if (candidate && candidate.family === own.family) {
      return { entryUnit, affine, shift: own.exponent - candidate.exponent };
    }
  }
  return null;
}

export function convertLabValue(input: ConvertLabValueInput): ConvertedValue {
  const { analyteKey, value, from, to } = input;
  if (!Number.isFinite(value)) return { ok: false, reason: "not_finite" };

  const fromNorm = normaliseLabUnit(from);
  const toNorm = normaliseLabUnit(to);
  if (fromNorm === toNorm) return { ok: true, value, via: "scale" };

  const a = scaleUnitOf(fromNorm);
  const b = scaleUnitOf(toNorm);
  if (a && b && a.family === b.family) {
    return {
      ok: true,
      value: shiftPowerOfTen(value, a.exponent - b.exponent),
      via: "scale",
    };
  }

  const entry = analyteConversionFor(analyteKey);
  if (!entry) {
    // Both units are real but of different families: it needs an analyte.
    return {
      ok: false,
      reason: a && b ? "unknown_analyte" : "unknown_unit",
    };
  }

  const source = intoEntryUnit(entry, fromNorm);
  const target = intoEntryUnit(entry, toNorm);
  if (!source || !target) return { ok: false, reason: "unknown_unit" };

  const inEntryUnit = shiftPowerOfTen(value, source.shift);
  const hub = source.affine.a * inEntryUnit + source.affine.b;
  const inTargetEntryUnit = (hub - target.affine.b) / target.affine.a;
  // `target.shift` moves the entry's unit to the one asked for: the reverse of
  // the way `from` was moved in.
  const result = shiftPowerOfTen(inTargetEntryUnit, -target.shift);
  return Number.isFinite(result)
    ? { ok: true, value: result, via: "analyte" }
    : { ok: false, reason: "not_finite" };
}

export type ConvertedRange =
  | {
      ok: true;
      low: number | null;
      high: number | null;
      via: "analyte" | "scale";
    }
  | { ok: false; reason: ConversionRefusal };

/**
 * Both bounds of a reference range, or the refusal. An open bound (null) stays
 * open. Every conversion has a positive slope, so the bounds keep their order.
 */
export function convertLabRange(input: {
  analyteKey: string | null | undefined;
  low: number | null;
  high: number | null;
  from: string;
  to: string;
}): ConvertedRange {
  const { analyteKey, from, to } = input;
  const bounds: Array<number | null> = [input.low, input.high];
  const converted: Array<number | null> = [];
  let via: "analyte" | "scale" = "scale";
  for (const bound of bounds) {
    if (bound === null) {
      converted.push(null);
      continue;
    }
    const result = convertLabValue({ analyteKey, value: bound, from, to });
    if (!result.ok) return result;
    if (result.via === "analyte") via = "analyte";
    converted.push(result.value);
  }
  // A range of nothing but open bounds still has to name a way: the units must
  // convert at all.
  if (input.low === null && input.high === null) {
    const probe = convertLabValue({ analyteKey, value: 1, from, to });
    if (!probe.ok) return probe;
    via = probe.via;
  }
  return { ok: true, low: converted[0], high: converted[1], via };
}

/**
 * The units a reading can arrive in and be converted to `to` for this marker:
 * every unit in the scale family of `to`, and, when the analyte has an entry,
 * every unit of that entry along with their scale families. `to` itself is not
 * listed.
 */
export function conversionsFor(input: {
  analyteKey: string | null | undefined;
  to: string;
}): string[] {
  const to = normaliseLabUnit(input.to);
  const found = new Set<string>(scaleUnitsInFamilyOf(to));
  const entry = analyteConversionFor(input.analyteKey);
  if (entry && (to in entry.units || intoEntryUnit(entry, to))) {
    for (const unit of Object.keys(entry.units)) {
      found.add(unit);
      for (const sibling of scaleUnitsInFamilyOf(unit)) found.add(sibling);
    }
  }
  found.delete(to);
  return [...found].filter((unit) => normaliseLabUnit(unit) !== to);
}
