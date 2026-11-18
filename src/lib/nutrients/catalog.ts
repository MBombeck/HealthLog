/**
 * Nutrient catalog — the closed code set for nutrient intake.
 *
 * 39 syncable codes: the HealthKit `Dietary*` vitamin and mineral quantity
 * types (sodium and potassium among them), water and caffeine, dietary energy
 * and the macronutrients (protein, carbohydrates, fat with its saturated,
 * monounsaturated and polyunsaturated parts, sugar, fiber, cholesterol), and
 * alcohol. Energy and the macros came in by maintainer decision on #1402, once
 * users asked to bring the day totals a food tracker already computes. "Syncable"
 * means the batch accepts the code; whether HealthKit carries it is a separate
 * question, answered by `hkIdentifier !== null`. Alcohol is the one syncable
 * code HealthKit has no dietary type for: only a bridge token posts it. Two
 * further codes (`dha`, `epa`) come only from a supplement's composition; they
 * appear in responses and never in the batch.
 *
 * This catalog is the single source of truth for:
 *   - the closed `nutrient` code enum on the wire and in storage;
 *   - the canonical storage unit per code, which is ALSO the pinned
 *     HealthKit query unit for iOS (mass types in g, mg or µg as listed,
 *     water in mL, energy in kcal — never IU, never kJ). The batch route
 *     rejects any entry whose echoed `unit` differs, because a silent µg/mg
 *     or kJ/kcal confusion corrupts the value and the one-string echo is the
 *     cheapest guard;
 *   - the generous per-day plausibility cap (ingest guard against
 *     unit-confused or corrupted writers, NOT a health judgement —
 *     values above high-dose supplement reality get skipped);
 *   - the dietary reference values the insights surfaces and the Coach
 *     compare against. Every reference names its authority, its value kind
 *     (PRI / AI / safeLevel) and a direction: `target` for reference intakes,
 *     `upperGuidance` for a do-not-exceed level (caffeine, sodium). Sex-split
 *     values resolve against the user profile at consumption time — a profile
 *     without sex omits the reference, never guesses;
 *   - the group a code belongs to (vitamin, mineral, energy and macros, …),
 *     which the surfaces read instead of listing codes by hand, and whether a
 *     supplement's composition may name it.
 *
 * Reference values are the EFSA DRV Finder adult values (Dietary Reference
 * Values for the EU population) wherever EFSA sets a value per day; each entry
 * cites its source verbatim in `reference.source`. Where EFSA expresses a
 * vitamin per energy unit (thiamin, niacin), the entry carries the value at the
 * 10 MJ/day reference energy intake and says so in the citation. Three codes
 * cite another authority, named in `reference.authority`: chromium (EFSA
 * concluded no DRV can be set; NIH ODS adequate intake), protein and
 * carbohydrates (EFSA states them per kilogram of body weight or as a share of
 * energy, never per day; the IOM recommended dietary allowance is the per-day
 * figure). Energy, the fats, sugar, cholesterol and alcohol carry no
 * reference: EFSA's energy requirement depends on age, sex and activity, fat
 * is a share of energy, saturated fat is "as low as possible" with no number,
 * EFSA set no value for cholesterol, and sugar and alcohol have no intake to
 * aim for.
 */

import type { BinaryReferenceSex } from "@/lib/profile/sex";

/**
 * The codes the nutrient batch accepts. `NUTRIENT_CODES` adds the
 * supplement-only codes below them; the batch validates against this tuple.
 */
export const SYNCABLE_NUTRIENT_CODES = [
  // 13 vitamins
  "vitamin_a",
  "thiamin",
  "riboflavin",
  "niacin",
  "pantothenic_acid",
  "vitamin_b6",
  "biotin",
  "folate",
  "vitamin_b12",
  "vitamin_c",
  "vitamin_d",
  "vitamin_e",
  "vitamin_k",
  // 13 minerals
  "calcium",
  "iron",
  "magnesium",
  "phosphorus",
  "zinc",
  "copper",
  "manganese",
  "selenium",
  "chromium",
  "molybdenum",
  "iodine",
  "sodium",
  "potassium",
  // taken substances with correlation value
  "water",
  "caffeine",
  // energy and macronutrients (#1402)
  "energy",
  "protein",
  "carbohydrates",
  "fat",
  "saturated_fat",
  "monounsaturated_fat",
  "polyunsaturated_fat",
  "sugar",
  "fiber",
  "cholesterol",
  // no HealthKit dietary type; a bridge token posts it
  "alcohol",
] as const;

/**
 * v1.43 — codes that come only from a supplement's composition. No HealthKit
 * quantity type carries them, so the batch never accepts them and they appear
 * in responses only.
 */
export const SUPPLEMENT_ONLY_NUTRIENT_CODES = ["dha", "epa"] as const;

export const NUTRIENT_CODES = [
  ...SYNCABLE_NUTRIENT_CODES,
  ...SUPPLEMENT_ONLY_NUTRIENT_CODES,
] as const;

export type NutrientCode = (typeof NUTRIENT_CODES)[number];
export type SyncableNutrientCode = (typeof SYNCABLE_NUTRIENT_CODES)[number];

/** Canonical storage units. `ug` is µg on the wire — ASCII on purpose. */
export type NutrientUnit = "mg" | "ug" | "ml" | "g" | "kcal";

/**
 * v1.43 — every unit an amount may be ENTERED in. The canonical units plus
 * gram, litre and the international unit. IU exists only where one IU maps to
 * one fixed mass (vitamin D, preformed vitamin A); vitamin E has none, because
 * its IU depends on whether the form is natural or synthetic.
 */
export type NutrientInputUnitCode = NutrientUnit | "l" | "IU";

/** The unit vocabulary, spelled once. Every other file reads it from here. */
export const NUTRIENT_UNIT = {
  mg: "mg",
  ug: "ug",
  ml: "ml",
  g: "g",
  l: "l",
  IU: "IU",
  kcal: "kcal",
} as const satisfies Record<NutrientInputUnitCode, NutrientInputUnitCode>;

export interface NutrientInputUnit {
  unit: NutrientInputUnitCode;
  /** Multiply an entered amount by this to get the canonical amount. */
  factorToCanonical: number;
}

/**
 * v1.43 — a tolerable upper intake level (UL): the highest daily intake not
 * expected to cause harm. `scope: "total"` applies to everything taken in a
 * day; `scope: "supplemental"` applies to the part from supplements only
 * (magnesium salts, folic acid), which the server reads as the SUPPLEMENT
 * source. `null` on a code where no UL is established.
 */
export interface NutrientUpperLimit {
  value: number;
  unit: NutrientUnit;
  scope: "total" | "supplemental";
  /**
   * The chemical form the level is set for, where it is narrower than the
   * nutrient: vitamin A's level covers preformed retinol only (beta-carotene
   * does not count), folate's the folic acid, magnesium's the dissociable
   * salts in supplements, vitamin E's alpha-tocopherol. `null` where the
   * level covers the nutrient as such. Clients phrase it in the reader's
   * language; `source` stays the bare citation.
   */
  form: NutrientUpperLimitForm | null;
  /** The citation (EFSA overview and the opinion it rests on), verbatim. */
  source: string;
}

export type NutrientUpperLimitForm =
  "retinol" | "folic_acid" | "magnesium_salts" | "alpha_tocopherol";

export interface NutrientReference {
  /**
   * The body that set the value. EFSA wherever it sets a per-day value; the
   * catalogue header names each exception and why.
   */
  authority: NutrientReferenceAuthority;
  /**
   * Value type in EFSA's vocabulary. An IOM recommended dietary allowance is
   * carried as `PRI`, the concept it matches.
   */
  kind: "PRI" | "AI" | "safeLevel";
  /** `target` = reference intake; `upperGuidance` = do-not-exceed. */
  direction: "target" | "upperGuidance";
  /** Uniform adult value where the source is uniform. */
  adult?: number;
  /** Sex-split values where the source splits (e.g. iron 11 / 16). */
  male?: number;
  female?: number;
  /** Citation, quoted verbatim wherever the reference surfaces. */
  source: string;
}

export type NutrientReferenceAuthority = "EFSA" | "IOM" | "NIH ODS";

/**
 * Which family a code belongs to. The surfaces group by it (the micronutrient
 * card lists vitamins and minerals, the energy card the `energy_macro` codes)
 * instead of listing codes by hand.
 */
export type NutrientGroup =
  | "vitamin"
  | "mineral"
  | "water"
  | "caffeine"
  | "energy_macro"
  | "alcohol"
  | "omega3";

export interface NutrientDefinition {
  code: NutrientCode;
  /**
   * HealthKit quantity type identifier iOS reads this code from. `null` for a
   * supplement-only code (`dha`, `epa`).
   */
  hkIdentifier: string | null;
  /**
   * Whether the nutrient batch accepts this code. HealthKit carries it only
   * when `hkIdentifier` is set; alcohol is syncable through a token alone.
   */
  syncable: boolean;
  /** The family the code belongs to. */
  group: NutrientGroup;
  /**
   * Whether a supplement's composition may name this code. False for water,
   * energy and the macros, and alcohol: what a capsule contains is a substance
   * taken, not a meal.
   */
  ingredient: boolean;
  /** Canonical storage unit AND the pinned HK query unit. */
  unit: NutrientUnit;
  /** i18n key for the display name (settings card + exports). */
  labelKey: string;
  /**
   * Generous per-day ingest cap in the canonical unit. Entries above it
   * are skipped `value_out_of_range` — sized well above high-dose
   * supplement reality so only unit confusion / corruption trips it.
   */
  plausibleDailyMax: number;
  /** The reference intake, or `null` where none is set per code. */
  reference: NutrientReference | null;
  /** v1.43 — the units an amount may be entered in, canonical first. */
  inputUnits: ReadonlyArray<NutrientInputUnit>;
  /** v1.43 — the tolerable upper intake level, or `null`. */
  upperLimit: NutrientUpperLimit | null;
}

/**
 * The input units each canonical unit offers by default: the unit itself and
 * its neighbours in the metric ladder. A code adds IU on top where one exists.
 */
const METRIC_INPUT_UNITS: Readonly<
  Record<NutrientUnit, ReadonlyArray<NutrientInputUnit>>
> = {
  mg: [
    { unit: NUTRIENT_UNIT.mg, factorToCanonical: 1 },
    { unit: NUTRIENT_UNIT.ug, factorToCanonical: 0.001 },
    { unit: NUTRIENT_UNIT.g, factorToCanonical: 1000 },
  ],
  ug: [
    { unit: NUTRIENT_UNIT.ug, factorToCanonical: 1 },
    { unit: NUTRIENT_UNIT.mg, factorToCanonical: 1000 },
  ],
  ml: [
    { unit: NUTRIENT_UNIT.ml, factorToCanonical: 1 },
    { unit: NUTRIENT_UNIT.l, factorToCanonical: 1000 },
  ],
  g: [
    { unit: NUTRIENT_UNIT.g, factorToCanonical: 1 },
    { unit: NUTRIENT_UNIT.mg, factorToCanonical: 0.001 },
  ],
  // No kJ: a value typed in kilojoules and read as kilocalories is off by a
  // factor of 4.184 and still looks plausible, so energy is entered in one unit.
  kcal: [{ unit: NUTRIENT_UNIT.kcal, factorToCanonical: 1 }],
};

/**
 * The international unit where one IU is one fixed mass of the canonical unit.
 * Vitamin D: 1 IU = 0.025 µg cholecalciferol. Vitamin A: 1 IU = 0.3 µg
 * retinol (preformed vitamin A, the form supplements state in IU).
 */
const IU_FACTOR: Partial<Record<NutrientCode, number>> = {
  vitamin_d: 0.025,
  vitamin_a: 0.3,
};

/**
 * The tolerable upper intake levels for adults, from EFSA's overview of the
 * tolerable upper intake levels (2024 edition), each citing the opinion it
 * rests on. A code that is absent has no established UL: EFSA set none
 * (vitamin C, K, B1, B2, B5, B12, biotin, phosphorus, chromium), set a safe
 * level of intake instead of a UL (iron 2024, manganese 2023), or set one that
 * depends on a chemical form the composition cannot say (niacin: nicotinic
 * acid 10 mg, nicotinamide 900 mg). EPA and DHA have none: EFSA (2012) found
 * supplemental intakes up to 5 g a day of both combined raise no concern, which
 * is a statement about the pair, not a per-nutrient limit.
 */
const UPPER_LIMITS: Partial<Record<NutrientCode, NutrientUpperLimit>> = {
  vitamin_a: {
    value: 3000,
    unit: "ug",
    scope: "total",
    form: "retinol",
    source: "EFSA UL overview 2024 (SCF 2002)",
  },
  vitamin_b6: {
    value: 12,
    unit: "mg",
    scope: "total",
    form: null,
    source: "EFSA UL overview 2024 (NDA Panel 2023)",
  },
  folate: {
    value: 1000,
    unit: "ug",
    scope: "supplemental",
    form: "folic_acid",
    source: "EFSA UL overview 2024 (NDA Panel 2023)",
  },
  vitamin_d: {
    value: 100,
    unit: "ug",
    scope: "total",
    form: null,
    source: "EFSA UL overview 2024 (NDA Panel 2023)",
  },
  vitamin_e: {
    value: 300,
    unit: "mg",
    scope: "total",
    form: "alpha_tocopherol",
    source: "EFSA UL overview 2024 (NDA Panel 2024)",
  },
  calcium: {
    value: 2500,
    unit: "mg",
    scope: "total",
    form: null,
    source: "EFSA UL overview 2024 (NDA Panel 2012)",
  },
  magnesium: {
    value: 250,
    unit: "mg",
    scope: "supplemental",
    form: "magnesium_salts",
    source: "EFSA UL overview 2024 (SCF 2001)",
  },
  zinc: {
    value: 25,
    unit: "mg",
    scope: "total",
    form: null,
    source: "EFSA UL overview 2024 (SCF 2003)",
  },
  copper: {
    value: 5,
    unit: "mg",
    scope: "total",
    form: null,
    source: "EFSA UL overview 2024 (SCF 2003)",
  },
  selenium: {
    value: 255,
    unit: "ug",
    scope: "total",
    form: null,
    source: "EFSA UL overview 2024 (NDA Panel 2023)",
  },
  molybdenum: {
    value: 600,
    unit: "ug",
    scope: "total",
    form: null,
    source: "EFSA UL overview 2024 (SCF 2000)",
  },
  iodine: {
    value: 600,
    unit: "ug",
    scope: "total",
    form: null,
    source: "EFSA UL overview 2024 (SCF 2002)",
  },
};

function inputUnitsFor(
  code: NutrientCode,
  unit: NutrientUnit,
): ReadonlyArray<NutrientInputUnit> {
  const iu = IU_FACTOR[code];
  return iu === undefined
    ? METRIC_INPUT_UNITS[unit]
    : [
        ...METRIC_INPUT_UNITS[unit],
        { unit: NUTRIENT_UNIT.IU, factorToCanonical: iu },
      ];
}

/** Groups whose codes a supplement's composition may not name. */
const NON_INGREDIENT_GROUPS: ReadonlySet<NutrientGroup> = new Set([
  "water",
  "energy_macro",
  "alcohol",
]);

function def(
  code: NutrientCode,
  group: NutrientGroup,
  hkSuffix: string,
  unit: NutrientUnit,
  plausibleDailyMax: number,
  reference: NutrientReference | null,
): NutrientDefinition {
  return {
    code,
    hkIdentifier: `HKQuantityTypeIdentifierDietary${hkSuffix}`,
    syncable: true,
    group,
    ingredient: !NON_INGREDIENT_GROUPS.has(group),
    unit,
    labelKey: `nutrients.names.${code}`,
    plausibleDailyMax,
    reference,
    inputUnits: inputUnitsFor(code, unit),
    upperLimit: UPPER_LIMITS[code] ?? null,
  };
}

/**
 * A code the batch accepts that no HealthKit dietary type carries, so only a
 * bridge token posts it. It names no reference.
 */
function tokenOnly(
  code: NutrientCode,
  group: NutrientGroup,
  unit: NutrientUnit,
  plausibleDailyMax: number,
): NutrientDefinition {
  return {
    code,
    hkIdentifier: null,
    syncable: true,
    group,
    ingredient: !NON_INGREDIENT_GROUPS.has(group),
    unit,
    labelKey: `nutrients.names.${code}`,
    plausibleDailyMax,
    reference: null,
    inputUnits: inputUnitsFor(code, unit),
    upperLimit: UPPER_LIMITS[code] ?? null,
  };
}

/** A code that only a supplement's composition produces. */
function supplementOnly(
  code: NutrientCode,
  unit: NutrientUnit,
  plausibleDailyMax: number,
): NutrientDefinition {
  return {
    code,
    hkIdentifier: null,
    syncable: false,
    group: "omega3",
    ingredient: true,
    unit,
    labelKey: `nutrients.names.${code}`,
    plausibleDailyMax,
    // EFSA's adequate intake for these (250 mg a day) is set for EPA and DHA
    // combined, so neither code carries a reference of its own.
    reference: null,
    inputUnits: inputUnitsFor(code, unit),
    upperLimit: UPPER_LIMITS[code] ?? null,
  };
}

export const NUTRIENT_CATALOG: Readonly<
  Record<NutrientCode, NutrientDefinition>
> = Object.freeze({
  // ── Vitamins ─────────────────────────────────────────────────────
  vitamin_a: def("vitamin_a", "vitamin", "VitaminA", "ug", 15000, {
    authority: "EFSA",
    kind: "PRI",
    direction: "target",
    male: 750,
    female: 650,
    source: "EFSA DRV 2015 (retinol equivalents, adults)",
  }),
  // The cap is 500, not the 1000 the other B-vitamins carry, because thiamin's
  // PRI is exactly 1.0 mg: a µg-read-as-mg sample lands on exactly 1000, and
  // the ingest guard compares with `>`, so a 1000× error slipped through at
  // precisely this one analyte. 500 still clears any real supplement dose
  // (high-dose thiamin tops out around 300 mg) while catching that collision.
  thiamin: def("thiamin", "vitamin", "Thiamin", "mg", 500, {
    authority: "EFSA",
    kind: "PRI",
    direction: "target",
    adult: 1.0,
    source: "EFSA DRV 2016 (PRI 0.1 mg/MJ ≈ 1.0 mg/d at 10 MJ/d)",
  }),
  riboflavin: def("riboflavin", "vitamin", "Riboflavin", "mg", 1000, {
    authority: "EFSA",
    kind: "PRI",
    direction: "target",
    adult: 1.6,
    source: "EFSA DRV 2017 (adults)",
  }),
  niacin: def("niacin", "vitamin", "Niacin", "mg", 3000, {
    authority: "EFSA",
    kind: "PRI",
    direction: "target",
    adult: 16,
    source: "EFSA DRV 2014 (PRI 1.6 mg NE/MJ ≈ 16 mg NE/d at 10 MJ/d)",
  }),
  pantothenic_acid: def(
    "pantothenic_acid",
    "vitamin",
    "PantothenicAcid",
    "mg",
    2000,
    {
      authority: "EFSA",
      kind: "AI",
      direction: "target",
      adult: 5,
      source: "EFSA DRV 2014 (adults)",
    },
  ),
  vitamin_b6: def("vitamin_b6", "vitamin", "VitaminB6", "mg", 1000, {
    authority: "EFSA",
    kind: "PRI",
    direction: "target",
    male: 1.7,
    female: 1.6,
    source: "EFSA DRV 2016 (adults)",
  }),
  biotin: def("biotin", "vitamin", "Biotin", "ug", 20000, {
    authority: "EFSA",
    kind: "AI",
    direction: "target",
    adult: 40,
    source: "EFSA DRV 2014 (adults)",
  }),
  folate: def("folate", "vitamin", "Folate", "ug", 5000, {
    authority: "EFSA",
    kind: "PRI",
    direction: "target",
    adult: 330,
    source: "EFSA DRV 2014 (dietary folate equivalents, adults)",
  }),
  vitamin_b12: def("vitamin_b12", "vitamin", "VitaminB12", "ug", 5000, {
    authority: "EFSA",
    kind: "AI",
    direction: "target",
    adult: 4,
    source: "EFSA DRV 2015 (cobalamin, adults)",
  }),
  vitamin_c: def("vitamin_c", "vitamin", "VitaminC", "mg", 10000, {
    authority: "EFSA",
    kind: "PRI",
    direction: "target",
    male: 110,
    female: 95,
    source: "EFSA DRV 2013 (adults)",
  }),
  vitamin_d: def("vitamin_d", "vitamin", "VitaminD", "ug", 1000, {
    authority: "EFSA",
    kind: "AI",
    direction: "target",
    adult: 15,
    source: "EFSA DRV 2016 (adults, assuming minimal cutaneous synthesis)",
  }),
  vitamin_e: def("vitamin_e", "vitamin", "VitaminE", "mg", 2000, {
    authority: "EFSA",
    kind: "AI",
    direction: "target",
    male: 13,
    female: 11,
    source: "EFSA DRV 2015 (alpha-tocopherol, adults)",
  }),
  vitamin_k: def("vitamin_k", "vitamin", "VitaminK", "ug", 10000, {
    authority: "EFSA",
    kind: "AI",
    direction: "target",
    adult: 70,
    source: "EFSA DRV 2017 (phylloquinone, adults)",
  }),
  // ── Minerals ─────────────────────────────────────────────────────
  calcium: def("calcium", "mineral", "Calcium", "mg", 5000, {
    authority: "EFSA",
    kind: "PRI",
    direction: "target",
    adult: 950,
    source: "EFSA DRV 2015 (adults ≥ 25 y)",
  }),
  iron: def("iron", "mineral", "Iron", "mg", 500, {
    authority: "EFSA",
    kind: "PRI",
    direction: "target",
    male: 11,
    female: 16,
    source: "EFSA DRV 2015 (adults; 16 mg premenopausal women)",
  }),
  magnesium: def("magnesium", "mineral", "Magnesium", "mg", 2000, {
    authority: "EFSA",
    kind: "AI",
    direction: "target",
    male: 350,
    female: 300,
    source: "EFSA DRV 2015 (adults)",
  }),
  phosphorus: def("phosphorus", "mineral", "Phosphorus", "mg", 5000, {
    authority: "EFSA",
    kind: "AI",
    direction: "target",
    adult: 550,
    source: "EFSA DRV 2015 (adults)",
  }),
  zinc: def("zinc", "mineral", "Zinc", "mg", 200, {
    authority: "EFSA",
    kind: "PRI",
    direction: "target",
    male: 9.4,
    female: 7.5,
    source: "EFSA DRV 2014 (adults, at 300 mg/d phytate intake)",
  }),
  copper: def("copper", "mineral", "Copper", "mg", 20, {
    authority: "EFSA",
    kind: "AI",
    direction: "target",
    male: 1.6,
    female: 1.3,
    source: "EFSA DRV 2015 (adults)",
  }),
  manganese: def("manganese", "mineral", "Manganese", "mg", 50, {
    authority: "EFSA",
    kind: "AI",
    direction: "target",
    adult: 3,
    source: "EFSA DRV 2013 (adults)",
  }),
  selenium: def("selenium", "mineral", "Selenium", "ug", 1000, {
    authority: "EFSA",
    kind: "AI",
    direction: "target",
    adult: 70,
    source: "EFSA DRV 2014 (adults)",
  }),
  chromium: def("chromium", "mineral", "Chromium", "ug", 2000, {
    authority: "NIH ODS",
    kind: "AI",
    direction: "target",
    male: 35,
    female: 25,
    source: "NIH ODS 2018 (adults 19–50 y; EFSA 2014 sets no DRV for chromium)",
  }),
  molybdenum: def("molybdenum", "mineral", "Molybdenum", "ug", 2000, {
    authority: "EFSA",
    kind: "AI",
    direction: "target",
    adult: 65,
    source: "EFSA DRV 2013 (adults)",
  }),
  iodine: def("iodine", "mineral", "Iodine", "ug", 2000, {
    authority: "EFSA",
    kind: "AI",
    direction: "target",
    adult: 150,
    source: "EFSA DRV 2014 (adults)",
  }),
  sodium: def("sodium", "mineral", "Sodium", "mg", 50000, {
    authority: "EFSA",
    kind: "safeLevel",
    direction: "upperGuidance",
    adult: 2000,
    source: "EFSA DRV 2019 (safe and adequate intake, adults)",
  }),
  potassium: def("potassium", "mineral", "Potassium", "mg", 30000, {
    authority: "EFSA",
    kind: "AI",
    direction: "target",
    adult: 3500,
    source: "EFSA DRV 2016 (adults)",
  }),
  // ── Taken substances with correlation value ──────────────────────
  water: def("water", "water", "Water", "ml", 20000, {
    authority: "EFSA",
    kind: "AI",
    direction: "target",
    male: 2500,
    female: 2000,
    source: "EFSA DRV 2010 (total water incl. food moisture, adults)",
  }),
  caffeine: def("caffeine", "caffeine", "Caffeine", "mg", 2000, {
    authority: "EFSA",
    kind: "safeLevel",
    direction: "upperGuidance",
    adult: 400,
    source: "EFSA 2015 scientific opinion on the safety of caffeine (adults)",
  }),
  // ── Energy and macronutrients (#1402) ────────────────────────────
  // EFSA's average energy requirement depends on age, sex and activity level
  // (EFSA 2013), so energy carries no single reference.
  energy: def("energy", "energy_macro", "EnergyConsumed", "kcal", 20000, null),
  protein: def("protein", "energy_macro", "Protein", "g", 1000, {
    authority: "IOM",
    kind: "PRI",
    direction: "target",
    male: 56,
    female: 46,
    source:
      "IOM 2005 DRI for macronutrients (RDA 0.8 g/kg/d, 56 g/d men, 46 g/d women; EFSA 2012 sets a PRI of 0.83 g/kg/d and no g/d value)",
  }),
  carbohydrates: def(
    "carbohydrates",
    "energy_macro",
    "Carbohydrates",
    "g",
    2000,
    {
      authority: "IOM",
      kind: "PRI",
      direction: "target",
      adult: 130,
      source:
        "IOM 2005 DRI for macronutrients (RDA 130 g/d, adults; EFSA 2010 sets 45–60 % of energy and no g/d value)",
    },
  ),
  // EFSA (2010) states fat as 20–35 % of energy; there is no per-day figure.
  fat: def("fat", "energy_macro", "FatTotal", "g", 1000, null),
  // The three parts of the total fat. EFSA (2010) asks for saturated fat "as
  // low as possible" within a nutritionally adequate diet and sets no amount;
  // the two unsaturated parts are shares of energy. Each part is capped like
  // the total, since no part can exceed it.
  saturated_fat: def(
    "saturated_fat",
    "energy_macro",
    "FatSaturated",
    "g",
    1000,
    null,
  ),
  monounsaturated_fat: def(
    "monounsaturated_fat",
    "energy_macro",
    "FatMonounsaturated",
    "g",
    1000,
    null,
  ),
  polyunsaturated_fat: def(
    "polyunsaturated_fat",
    "energy_macro",
    "FatPolyunsaturated",
    "g",
    1000,
    null,
  ),
  // EFSA (2022) set no safe level for added and free sugars.
  sugar: def("sugar", "energy_macro", "Sugar", "g", 1500, null),
  fiber: def("fiber", "energy_macro", "Fiber", "g", 500, {
    authority: "EFSA",
    kind: "AI",
    direction: "target",
    adult: 25,
    source: "EFSA DRV 2010 (dietary fibre, adults)",
  }),
  // In mg, as labels and HealthKit state it. EFSA (2010) set no reference
  // value; the cap is about ten times a day of eggs and offal.
  cholesterol: def(
    "cholesterol",
    "energy_macro",
    "Cholesterol",
    "mg",
    10000,
    null,
  ),
  // Grams of ethanol. HealthKit has no dietary type for it (its alcohol
  // quantity is the number of drinks), so only a bridge token posts it.
  alcohol: tokenOnly("alcohol", "alcohol", "g", 1000),
  // ── Supplement-only (v1.43) ──────────────────────────────────────
  // Omega-3 fatty acids from fish or algae oil capsules. The cap sits well
  // above the 5 g a day EFSA reviewed, so only a unit slip trips it.
  dha: supplementOnly("dha", "mg", 20000),
  epa: supplementOnly("epa", "mg", 20000),
});

/** Catalog rows in canonical display order (the tuple order above). */
export const NUTRIENT_DEFINITIONS: ReadonlyArray<NutrientDefinition> =
  NUTRIENT_CODES.map((code) => NUTRIENT_CATALOG[code]);

const NUTRIENT_CODE_SET: ReadonlySet<string> = new Set(NUTRIENT_CODES);

/** True when `code` is a known catalog code. */
export function isNutrientCode(code: string): code is NutrientCode {
  return NUTRIENT_CODE_SET.has(code);
}

const SYNCABLE_CODE_SET: ReadonlySet<string> = new Set(SYNCABLE_NUTRIENT_CODES);

/** True when HealthKit may send `code` in the nutrient batch. */
export function isSyncableNutrientCode(
  code: string,
): code is SyncableNutrientCode {
  return SYNCABLE_CODE_SET.has(code);
}

/**
 * A code's catalogue entry with its position in display order, or `null` for
 * a code the catalogue does not know.
 */
export function catalogEntryFor(
  code: string,
): (NutrientDefinition & { order: number }) | null {
  if (!isNutrientCode(code)) return null;
  return { ...NUTRIENT_CATALOG[code], order: NUTRIENT_CODES.indexOf(code) };
}

/** Round away binary noise from a unit factor (1000 IU × 0.025 = 25 µg). */
function roundAmount(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * v1.43 — convert an entered amount to the code's canonical unit. `null` when
 * `unit` is not one of the code's input units: the caller refuses, it never
 * guesses. This is the only unit conversion for nutrient amounts.
 */
export function toCanonicalNutrientAmount(
  code: NutrientCode,
  amount: number,
  unit: string,
): number | null {
  const input = NUTRIENT_CATALOG[code].inputUnits.find((u) => u.unit === unit);
  if (!input) return null;
  return roundAmount(amount * input.factorToCanonical);
}

/**
 * How labels print the input units, folded to lower case without dots or
 * spaces. A label says "mcg", "µg" or "μg" for microgram and "IE" (German),
 * "UI" (French, Spanish, Italian) or "j.m." (Polish) for the international
 * unit.
 */
const INPUT_UNIT_SPELLINGS: Readonly<Record<string, NutrientInputUnitCode>> = {
  kcal: NUTRIENT_UNIT.kcal,
  mg: NUTRIENT_UNIT.mg,
  ug: NUTRIENT_UNIT.ug,
  µg: NUTRIENT_UNIT.ug,
  μg: NUTRIENT_UNIT.ug,
  mcg: NUTRIENT_UNIT.ug,
  g: NUTRIENT_UNIT.g,
  ml: NUTRIENT_UNIT.ml,
  l: NUTRIENT_UNIT.l,
  iu: NUTRIENT_UNIT.IU,
  ie: NUTRIENT_UNIT.IU,
  ui: NUTRIENT_UNIT.IU,
  jm: NUTRIENT_UNIT.IU,
};

/**
 * v1.43 — read a unit as a label prints it into the catalogue's input-unit
 * code, or `null` when it is not one. Whether the code accepts it is a second
 * question ({@link toCanonicalNutrientAmount}).
 */
export function parseNutrientInputUnit(
  raw: string,
): NutrientInputUnitCode | null {
  const folded = raw.trim().toLowerCase().replace(/[\s.]/g, "");
  return INPUT_UNIT_SPELLINGS[folded] ?? null;
}

/** Whether `unit` is the code's canonical unit (nothing to convert). */
export function isCanonicalNutrientUnit(
  code: NutrientCode,
  unit: string,
): boolean {
  return NUTRIENT_CATALOG[code].unit === unit;
}

/**
 * v1.43 — whether a day is above the code's upper limit. `total` is the day's
 * sum across sources; `supplemental` the part from taken supplement doses.
 * `null` when the code has no upper limit, so "not above" and "no limit to be
 * above" stay two different answers.
 */
export function isAboveUpperLimit(
  code: NutrientCode,
  amounts: { total: number; supplemental: number },
): boolean | null {
  const limit = NUTRIENT_CATALOG[code].upperLimit;
  if (!limit) return null;
  const compared =
    limit.scope === "supplemental" ? amounts.supplemental : amounts.total;
  return compared > limit.value;
}

/** Whether a supplement's composition may name `code`. */
export function isIngredientNutrientCode(code: string): code is NutrientCode {
  return isNutrientCode(code) && NUTRIENT_CATALOG[code].ingredient;
}

/** The codes of one group, in catalogue order. */
export function nutrientCodesInGroup(
  ...groups: NutrientGroup[]
): NutrientCode[] {
  return NUTRIENT_CODES.filter((code) =>
    groups.includes(NUTRIENT_CATALOG[code].group),
  );
}

/** A catalog reference resolved to one concrete number for a profile. */
export interface ResolvedNutrientReference {
  authority: NutrientReferenceAuthority;
  kind: NutrientReference["kind"];
  direction: NutrientReference["direction"];
  value: number;
  source: string;
}

/**
 * Resolve a catalog reference against the user's profile sex (v1.29).
 *
 * `adult` values (uniform across sexes) resolve unconditionally. A
 * sex-split reference (`male` / `female`, no `adult`) resolves only
 * when `sex` is known — a profile without sex on file OMITS the
 * reference rather than guessing, the catalog's own documented
 * contract (see the module docblock). Every insights surface honours
 * this: no reference line, no meta sentence, nothing inferred.
 */
export function resolveNutrientReference(
  code: NutrientCode,
  sex: BinaryReferenceSex | null,
): ResolvedNutrientReference | null {
  const ref = NUTRIENT_CATALOG[code].reference;
  if (!ref) return null;
  const value =
    ref.adult ??
    (sex === "MALE" ? ref.male : sex === "FEMALE" ? ref.female : undefined);
  if (value === undefined) return null;
  return {
    authority: ref.authority,
    kind: ref.kind,
    direction: ref.direction,
    value,
    source: ref.source,
  };
}
