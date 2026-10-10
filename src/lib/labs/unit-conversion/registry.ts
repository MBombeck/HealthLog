/**
 * Which analytes can be moved between units, and how.
 *
 * Each analyte lists the units it knows as an affine map to one hub unit:
 * `hub = a * value + b`. Any pair then goes unit -> hub -> unit, so adding a
 * unit to an analyte is one line and nothing lists pairs.
 *
 * Three kinds of entry, by where the factor comes from:
 *
 *   - `molar-mass`: mass concentration to amount concentration, which needs the
 *     analyte's molar mass. The factor is DERIVED from the formula and the
 *     atomic weights, never typed.
 *   - `standard`: an equation a standards body publishes (HbA1c, IFCC to NGSP).
 *   - `convention`: a factor that rests on an assumed value (triglycerides take
 *     an average molecular weight). None is in the registry yet: a conversion
 *     that cannot cite a primary source stays a refusal.
 *
 * Every entry names its source, and an entry that does not, or whose hub is not
 * one of its units, or whose factor is not a finite positive number, makes this
 * module throw when it loads. A wrong factor is worse than no conversion, so an
 * uncited one cannot be added quietly.
 *
 * Left out on purpose, so the refusal stays: haemoglobin in mmol/L (the figure
 * depends on whether the monomer or the tetramer is meant, a factor of four),
 * ferritin and vitamin B12 in pmol/L (large-protein molecular weights that vary
 * by source), enzymes in µkat/L, and anything without a source. Urea and blood
 * urea nitrogen are separate analytes (about 2.14 apart), and so are total and
 * ionised calcium; only the total is here.
 */
import { MGDL_PER_MMOL } from "@/lib/glucose";

import { normaliseLabUnit } from "../unit-normalise";
import {
  ATOMIC_WEIGHTS_SOURCE,
  formulaLabel,
  molarMass,
  type Formula,
} from "./atomic-weights";
import { scaleUnitOf, shiftPowerOfTen } from "./scale";

export interface Affine {
  a: number;
  b: number;
}

export type ConversionKind = "molar-mass" | "standard" | "convention";

export interface AnalyteConversion {
  /** Stable identity: the catalog slug where one exists, a registry-only key otherwise. */
  key: string;
  /** Other catalog slugs that are this same analyte (LDL and HDL are cholesterol). */
  aliases: readonly string[];
  /** The unit every other unit of this analyte maps to. */
  hub: string;
  /** Units by their normalised spelling, each as an affine map to the hub. */
  units: Readonly<Record<string, Affine>>;
  kind: ConversionKind;
  /** Where the factor comes from; required. */
  source: string;
}

export function defineAnalyteConversion(
  entry: AnalyteConversion,
): AnalyteConversion {
  const where = `unit-conversion registry entry "${entry.key}"`;
  if (!entry.source.trim()) throw new Error(`${where} has no source`);
  const hub = normaliseLabUnit(entry.hub);
  if (!(hub in entry.units)) {
    throw new Error(`${where}: hub "${entry.hub}" is not one of its units`);
  }
  for (const [unit, { a, b }] of Object.entries(entry.units)) {
    if (normaliseLabUnit(unit) !== unit) {
      throw new Error(`${where}: unit "${unit}" is not in its normalised form`);
    }
    if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(b)) {
      throw new Error(`${where}: unit "${unit}" has no finite positive factor`);
    }
  }
  return { ...entry, hub };
}

/**
 * A mass concentration (the hub) and one amount concentration of the same
 * analyte. The factor is the molar mass moved by the powers of ten between the
 * two units: 1 mmol/L of glucose is 180.156 mg/L, which is 18.0156 mg/dL.
 */
function molarMassEntry(spec: {
  key: string;
  aliases?: readonly string[];
  formula: Formula;
  /** The mass concentration the analyte is tracked in; the hub. */
  mass: string;
  /** The amount concentration it is also printed in. */
  amount: string;
  /** Overrides the derived mmol/L factor with a constant the app already has. */
  factor?: number;
  note?: string;
}): AnalyteConversion {
  const mass = scaleUnitOf(spec.mass);
  const amount = scaleUnitOf(spec.amount);
  if (mass?.family !== "mass" || amount?.family !== "amount") {
    throw new Error(
      `molar-mass entry "${spec.key}" needs a mass and an amount unit`,
    );
  }
  const grams = molarMass(spec.formula);
  // mol/L -> g/L is x molar mass; g/L -> the mass unit and the amount unit's
  // own prefix are powers of ten.
  const derived = shiftPowerOfTen(grams, amount.exponent - mass.exponent);
  return defineAnalyteConversion({
    key: spec.key,
    aliases: spec.aliases ?? [],
    hub: spec.mass,
    units: {
      [normaliseLabUnit(spec.mass)]: { a: 1, b: 0 },
      [normaliseLabUnit(spec.amount)]: { a: spec.factor ?? derived, b: 0 },
    },
    kind: "molar-mass",
    source:
      `Molar mass of ${formulaLabel(spec.formula)} (${grams} g/mol), summed from ` +
      `${ATOMIC_WEIGHTS_SOURCE}.` +
      (spec.note ? ` ${spec.note}` : ""),
  });
}

const ENTRIES: readonly AnalyteConversion[] = [
  molarMassEntry({
    key: "fasting-glucose",
    formula: { C: 6, H: 12, O: 6 },
    mass: "mg/dL",
    amount: "mmol/L",
    // The factor the glucose screens and the CGM import already use, so the two
    // can never disagree; the guard test checks it against the derived one.
    factor: MGDL_PER_MMOL,
    note: "The factor is MGDL_PER_MMOL (src/lib/glucose.ts).",
  }),
  molarMassEntry({
    key: "total-cholesterol",
    aliases: ["ldl", "hdl"],
    formula: { C: 27, H: 46, O: 1 },
    mass: "mg/dL",
    amount: "mmol/L",
    note: "LDL and HDL cholesterol are the same molecule.",
  }),
  molarMassEntry({
    key: "creatinine",
    formula: { C: 4, H: 7, N: 3, O: 1 },
    mass: "mg/dL",
    amount: "µmol/L",
  }),
  molarMassEntry({
    key: "urea",
    formula: { C: 1, H: 4, N: 2, O: 1 },
    mass: "mg/dL",
    amount: "mmol/L",
    note: "Urea itself, not urea nitrogen.",
  }),
  molarMassEntry({
    key: "blood-urea-nitrogen",
    // Only the two nitrogen atoms of urea count: BUN is mg of nitrogen per dL.
    formula: { N: 2 },
    mass: "mg/dL",
    amount: "mmol/L",
    note: "BUN in mg/dL against urea in mmol/L; two nitrogen atoms per urea molecule.",
  }),
  molarMassEntry({
    key: "uric-acid",
    formula: { C: 5, H: 4, N: 4, O: 3 },
    mass: "mg/dL",
    amount: "µmol/L",
  }),
  molarMassEntry({
    key: "calcium-total",
    formula: { Ca: 1 },
    mass: "mg/dL",
    amount: "mmol/L",
    note: "Total calcium; ionised calcium is a different measurement.",
  }),
  molarMassEntry({
    key: "bilirubin-total",
    formula: { C: 33, H: 36, N: 4, O: 6 },
    mass: "mg/dL",
    amount: "µmol/L",
  }),
  molarMassEntry({
    key: "vitamin-d",
    formula: { C: 27, H: 44, O: 2 },
    mass: "ng/mL",
    amount: "nmol/L",
    note: "25-hydroxyvitamin D, taken as cholecalciferol (C27H44O2).",
  }),
  defineAnalyteConversion({
    key: "hba1c",
    aliases: [],
    hub: "%",
    units: {
      "%": { a: 1, b: 0 },
      // NGSP(%) = 0.09148 x IFCC(mmol/mol) + 2.152. Affine, not a factor.
      "mmol/mol": { a: 0.09148, b: 2.152 },
    },
    kind: "standard",
    source:
      "IFCC-NGSP master equation, Hoelzel W et al., Clin Chem 2004;50(1):166-174, " +
      "as published by the NGSP: NGSP (%) = 0.09148 x IFCC (mmol/mol) + 2.152.",
  }),
];

const BY_KEY: ReadonlyMap<string, AnalyteConversion> = (() => {
  const map = new Map<string, AnalyteConversion>();
  for (const entry of ENTRIES) {
    for (const key of [entry.key, ...entry.aliases]) {
      if (map.has(key)) {
        throw new Error(`unit-conversion registry: "${key}" appears twice`);
      }
      map.set(key, entry);
    }
  }
  return map;
})();

/** The conversion entry for an analyte key (or one of its aliases), if any. */
export function analyteConversionFor(
  analyteKey: string | null | undefined,
): AnalyteConversion | null {
  return analyteKey ? (BY_KEY.get(analyteKey) ?? null) : null;
}

/** Every entry, once each, for the guard test and for phase 3's key matching. */
export function allAnalyteConversions(): readonly AnalyteConversion[] {
  return ENTRIES;
}
