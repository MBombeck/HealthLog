/**
 * v1.4.25 W19a — GLP-1 EMA drug knowledge layer.
 *
 * Read-only static reference data for the five EMA-approved GLP-1
 * receptor agonists (and one dual GIP/GLP-1 agonist). Values are
 * extracted verbatim from EMA EPAR Product Information PDFs and
 * cross-validated against the journal-of-record population PK paper
 * for tirzepatide (Schneck & Urva 2024, DOI 10.1002/psp4.13099).
 *
 * Posture (per `.planning/research/glp1-feature-inspiration.md` §11):
 *   - Display only. No autonomous dose escalation, no individual
 *     weight-loss projection, no drug-drug interaction checking,
 *     no mixing/reconstitution math.
 *   - Coach must NEVER reason from these numbers as if they were
 *     individual predictions; GROUND RULE 9 still applies.
 *   - Retatrutide is deliberately excluded — no EMA approval as of
 *     2026-05; including it would imply endorsement of unauthorised
 *     use (N7).
 *
 * Sources:
 *   - EMA EPAR PDFs linked per drug below.
 *   - Schneck KB, Urva S. "Population pharmacokinetics of the GIP/GLP
 *     receptor agonist tirzepatide." CPT Pharmacometrics Syst
 *     Pharmacol. 2024;13(3):494-503. DOI 10.1002/psp4.13099.
 *
 * Numbers are pinned exactly per the research file's §1.1–§1.5 and
 * the psp4.13099 cross-validation in §2.6. Drift introduces clinical
 * risk; see `__tests__/glp1-knowledge-drift.test.ts` for the guard.
 */

/**
 * Internal drug ids — stable across schema migrations. Brand-aware
 * UI looks up by id, not by brand name.
 */
export type Glp1DrugId =
  | "tirzepatide"
  | "semaglutide"
  | "liraglutide"
  | "dulaglutide"
  | "exenatide";

/**
 * Route enum — most agonists are subcutaneous; Rybelsus is oral
 * semaglutide. The catalog records the default route on the drug
 * record AND a per-brand override map so a single drug-id can carry
 * mixed routes (semaglutide → Ozempic/Wegovy sc, Rybelsus oral).
 */
type Glp1Route = "subcutaneous" | "oral";

/**
 * Drug class descriptor — Tirzepatide is the only dual GIP/GLP-1
 * agonist among EMA-approved agents (2026-05); the rest are pure
 * GLP-1 receptor agonists.
 */
type Glp1DrugClass = "GIP-GLP1 dual agonist" | "GLP-1 receptor agonist";

type Glp1Pharmacology = {
  /** Terminal elimination half-life. Days for the long-acting agents,
   *  hours for liraglutide / short-acting exenatide. */
  halfLifeDays: number;
  /** Time to maximum concentration after a SC dose, hours. Liraglutide
   *  uses the EMA EPAR §5.2 mean (~11 h); the weekly agents use the
   *  pharmacology-text midpoint of their EMA-published 8–72 h range. */
  tmaxHours: number;
  /** First-order absorption rate constant. Populated from the
   *  journal-of-record where one exists (tirzepatide ←
   *  Schneck/Urva 2024); marked null where EMA does not publish a
   *  pop-PK Ka estimate (the EPARs cite only terminal half-life). */
  absorptionRateHourlyKa: number | null;
  /** SC bioavailability, fraction in [0,1]. EMA EPAR §5.2 values. */
  bioavailability: number;
  /** Volume of distribution per kg body weight. Derived from the
   *  EPAR's reported Vd at a 70 kg reference where the source gives
   *  an absolute litre value. */
  vdLitersPerKg: number;
  /** Apparent clearance at the 70 kg reference weight, L/h. From
   *  EPAR §5.2 or the journal-of-record where available. */
  clearanceLPerHour70kg: number;
  /** Weeks until steady-state plateau on the standard cadence. */
  steadyStateWeeks: number;
  /** Compartment model that best describes published PK. The
   *  research-view curve (R8, deferred to v1.5) will honour this. */
  compartmentModel: "one-compartment" | "two-compartment";
};

type Glp1Storage = {
  /** Refrigerated stability — every GLP-1 product is shipped 2–8 °C
   *  per EMA. */
  unopened: {
    temperatureCelsius: { min: number; max: number };
  };
  /** Post-opening / in-use window. EMA §6.3 caps every product at
   *  ≤ 30 °C; the day-count varies by product. */
  inUse: {
    temperatureCelsius: { min: number; max: number };
    maxDays: number;
  };
};

type Glp1Pen = {
  /** Pen device name as printed on the carton. */
  type: string;
  /** Doses per pen / per cartridge — drives W19b inventory
   *  depletion math. `null` means single-use (one pen per dose). */
  dosesPerPen: number | null;
};

type Glp1AdverseReactions = {
  /** ≥ 1/10 frequency per EMA §4.8. */
  veryCommon: readonly string[];
  /** 1/100 to <1/10 per EMA §4.8. */
  common: readonly string[];
  /** 1/1 000 to <1/100 per EMA §4.8. */
  uncommon: readonly string[];
  /** < 1/1 000 per EMA §4.8 — typically post-marketing signals. */
  rare: readonly string[];
};

type Glp1Indications = {
  t2dm: { firstLine: boolean };
  weightManagement: { bmiThreshold: number | null };
};

type Glp1SourceCitations = {
  /** Direct link to the EMA EPAR product-information PDF. */
  sourceEMA: string;
  /** Peer-reviewed pharmacometric citation where one exists. */
  sourceJournal?: {
    citation: string;
    doi: string;
  };
};

export type Glp1DrugRecord = {
  inn: string;
  brands: readonly string[];
  /** Default route for the drug; brand-specific overrides go in
   *  `brandRoutes`. */
  route: Glp1Route;
  /** Per-brand route override map. Only populated when at least one
   *  brand departs from the default route (e.g. Rybelsus is oral
   *  semaglutide while Ozempic / Wegovy are SC). */
  brandRoutes?: Readonly<Record<string, Glp1Route>>;
  drugClass: Glp1DrugClass;
  pharmacology: Glp1Pharmacology;
  /** Standard titration ladder in mg. Strictly ascending. The
   *  schedule is informational per EMA EPAR §4.2 — the UI surfaces
   *  it for context, never as autonomous escalation guidance (N1). */
  titrationStepsMg: readonly number[];
  /** Minimum interval between titration steps per EMA §4.2. */
  titrationIntervalWeeks: number;
  maxDoseMg: number;
  standardInjectionFrequency: "daily" | "twice-daily" | "weekly";
  indications: Glp1Indications;
  storage: Glp1Storage;
  pen: Glp1Pen;
  sideEffects: Glp1AdverseReactions;
  contraindications: readonly string[];
  warnings: readonly string[];
} & Glp1SourceCitations;

/**
 * The catalog. Five drug records keyed by stable id. Brand-name
 * lookup is one-to-many; route-mapping is exposed both as the
 * record default and the per-brand override.
 */
export const GLP1_DRUGS: Readonly<Record<Glp1DrugId, Glp1DrugRecord>> = {
  // §1.1 — Tirzepatide. EMA EPAR cross-validated against
  // Schneck & Urva 2024 (psp4.13099). Two-compartment first-order
  // absorption + elimination per the journal-of-record.
  tirzepatide: {
    inn: "Tirzepatide",
    brands: ["Mounjaro", "Zepbound"],
    route: "subcutaneous",
    drugClass: "GIP-GLP1 dual agonist",
    pharmacology: {
      halfLifeDays: 5.0,
      tmaxHours: 24,
      absorptionRateHourlyKa: 0.0373, // psp4.13099 Table 3
      bioavailability: 0.8, // EMA EPAR §5.2
      vdLitersPerKg: 0.09, // ~6.45 L / 70 kg per psp4.13099 (Vc + Vp)
      clearanceLPerHour70kg: 0.0329, // psp4.13099 Table 3
      steadyStateWeeks: 4, // EMA EPAR §5.2
      compartmentModel: "two-compartment", // psp4.13099 verbatim
    },
    titrationStepsMg: [2.5, 5, 7.5, 10, 12.5, 15], // EMA EPAR §4.2
    titrationIntervalWeeks: 4, // EMA EPAR §4.2
    maxDoseMg: 15,
    standardInjectionFrequency: "weekly",
    indications: {
      t2dm: { firstLine: false }, // adjunct, not first-line per §4.1
      weightManagement: { bmiThreshold: 30 }, // §4.1 (or ≥ 27 with comorbidity)
    },
    storage: {
      unopened: { temperatureCelsius: { min: 2, max: 8 } }, // §6.4
      inUse: { temperatureCelsius: { min: 2, max: 30 }, maxDays: 30 }, // §6.3 KwikPen
    },
    pen: {
      type: "KwikPen",
      dosesPerPen: 4, // §6.5
    },
    sideEffects: {
      veryCommon: [
        "nausea",
        "diarrhea",
        "vomiting",
        "abdominal_pain",
        "constipation",
        "decreased_appetite",
      ],
      common: [
        "hypoglycaemia",
        "hypersensitivity",
        "dizziness",
        "hypotension",
        "dyspepsia",
        "abdominal_distension",
        "eructation",
        "flatulence",
        "gerd",
        "hair_loss",
        "fatigue",
        "injection_site_reaction",
        "heart_rate_increased",
      ],
      uncommon: [
        "weight_decreased",
        "dysgeusia",
        "dysaesthesia",
        "cholelithiasis",
        "cholecystitis",
        "acute_pancreatitis",
        "delayed_gastric_emptying",
        "injection_site_pain",
      ],
      rare: ["anaphylactic_reaction", "angioedema"],
    },
    contraindications: ["hypersensitivity_active_substance_or_excipients"],
    warnings: [
      "pancreatitis_history",
      "severe_gi_disease",
      "diabetic_retinopathy_macular_oedema",
      "pulmonary_aspiration_risk_anaesthesia",
      "pregnancy_long_half_life_discontinue_one_month_before",
    ],
    sourceEMA:
      "https://www.ema.europa.eu/en/documents/product-information/mounjaro-epar-product-information_en.pdf",
    sourceJournal: {
      citation:
        "Schneck KB, Urva S. CPT Pharmacometrics Syst Pharmacol. 2024;13(3):494-503.",
      doi: "10.1002/psp4.13099",
    },
  },

  // §1.2–§1.3 — Semaglutide (Ozempic injectable, Wegovy injectable
  // weight-mgmt, Rybelsus oral). EMA EPAR §5.2: half-life ≈ 1 week.
  // Rybelsus is the one mixed-route brand — `brandRoutes` carries
  // the oral exception while the default stays SC.
  semaglutide: {
    inn: "Semaglutide",
    brands: ["Ozempic", "Wegovy", "Rybelsus"],
    route: "subcutaneous",
    brandRoutes: {
      Ozempic: "subcutaneous",
      Wegovy: "subcutaneous",
      Rybelsus: "oral",
    },
    drugClass: "GLP-1 receptor agonist",
    pharmacology: {
      halfLifeDays: 7.0, // EMA EPAR §5.2 (≈ 1 week)
      tmaxHours: 24, // EMA EPAR §5.2 (Tmax 1–3 d for SC)
      absorptionRateHourlyKa: null, // EMA EPAR does not publish a pop-PK Ka
      bioavailability: 0.89, // EMA Ozempic §5.2
      vdLitersPerKg: 0.18, // Wegovy §5.2 (~12.4 L / 70 kg)
      clearanceLPerHour70kg: 0.05, // EMA Ozempic §5.2
      steadyStateWeeks: 5, // EMA EPAR §5.2 (4–5 weeks)
      compartmentModel: "two-compartment", // EMA EPAR §5.2 pop-PK
    },
    titrationStepsMg: [0.25, 0.5, 1, 2], // Ozempic ladder §4.2
    titrationIntervalWeeks: 4,
    maxDoseMg: 2, // Ozempic; Wegovy max 2.4 (then 7.2)
    standardInjectionFrequency: "weekly",
    indications: {
      t2dm: { firstLine: false }, // Ozempic — adjunct
      weightManagement: { bmiThreshold: 30 }, // Wegovy ≥30 or ≥27 w/ comorbidity
    },
    storage: {
      unopened: { temperatureCelsius: { min: 2, max: 8 } }, // §6.4
      inUse: { temperatureCelsius: { min: 2, max: 30 }, maxDays: 56 }, // Ozempic §6.3
    },
    pen: {
      type: "FlexTouch",
      dosesPerPen: 4, // Ozempic 0.25/0.5 mg dose pen
    },
    sideEffects: {
      veryCommon: ["nausea", "diarrhea", "vomiting", "abdominal_pain"],
      common: [
        "hypoglycaemia",
        "decreased_appetite",
        "dizziness",
        "dyspepsia",
        "constipation",
        "eructation",
        "flatulence",
        "abdominal_distension",
        "gerd",
        "fatigue",
        "injection_site_reaction",
        "lipase_increased",
        "amylase_increased",
        "cholelithiasis",
      ],
      uncommon: [
        "hypersensitivity",
        "dysgeusia",
        "pulse_increased",
        "diabetic_retinopathy_complications",
        "acute_pancreatitis",
      ],
      rare: ["anaphylactic_reaction", "angioedema"],
    },
    contraindications: ["hypersensitivity_active_substance_or_excipients"],
    warnings: [
      "pancreatitis_history",
      "diabetic_retinopathy_macular_oedema",
      "dehydration_risk",
      "pregnancy_long_half_life_discontinue_two_months_before",
    ],
    sourceEMA:
      "https://www.ema.europa.eu/en/documents/product-information/ozempic-epar-product-information_en.pdf",
  },

  // §1.4 — Liraglutide (Saxenda weight-mgmt, Victoza T2DM). Daily
  // SC dosing — fundamentally different cadence from the weekly
  // agonists. Half-life ≈ 13 h per EMA EPAR §5.2.
  liraglutide: {
    inn: "Liraglutide",
    brands: ["Saxenda", "Victoza"],
    route: "subcutaneous",
    drugClass: "GLP-1 receptor agonist",
    pharmacology: {
      halfLifeDays: 13 / 24, // ≈ 13 h per EMA EPAR §5.2
      tmaxHours: 11, // EMA EPAR §5.2 (mean ~11 h)
      absorptionRateHourlyKa: null, // not published in EMA EPAR pop-PK
      bioavailability: 0.55, // EMA EPAR §5.2 (~55%)
      vdLitersPerKg: 0.22, // ~22 L / 100 kg per EMA EPAR §5.2
      clearanceLPerHour70kg: 1.2, // EMA EPAR §5.2 (~0.9–1.4 L/h)
      steadyStateWeeks: 1, // daily, plateau within ~3 days
      compartmentModel: "two-compartment",
    },
    titrationStepsMg: [0.6, 1.2, 1.8, 2.4, 3.0], // Saxenda §4.2
    titrationIntervalWeeks: 1, // Saxenda: +0.6 mg/week
    maxDoseMg: 3.0, // Saxenda; Victoza max 1.8
    standardInjectionFrequency: "daily",
    indications: {
      t2dm: { firstLine: false }, // Victoza — adjunct
      weightManagement: { bmiThreshold: 30 }, // Saxenda
    },
    storage: {
      unopened: { temperatureCelsius: { min: 2, max: 8 } },
      inUse: { temperatureCelsius: { min: 2, max: 30 }, maxDays: 30 },
    },
    pen: {
      type: "Pre-filled pen",
      dosesPerPen: null, // continuous-dial pen, doses vary
    },
    sideEffects: {
      veryCommon: ["nausea", "vomiting", "diarrhea", "constipation"],
      common: [
        "hypoglycaemia",
        "decreased_appetite",
        "headache",
        "dizziness",
        "dyspepsia",
        "abdominal_pain",
        "gerd",
        "abdominal_distension",
        "eructation",
        "flatulence",
        "fatigue",
        "injection_site_reaction",
        "asthenia",
      ],
      uncommon: [
        "dehydration",
        "cholelithiasis",
        "cholecystitis",
        "acute_pancreatitis",
        "tachycardia",
      ],
      rare: ["anaphylactic_reaction", "angioedema", "acute_renal_failure"],
    },
    contraindications: ["hypersensitivity_active_substance_or_excipients"],
    warnings: [
      "pancreatitis_history",
      "thyroid_disease",
      "dehydration_risk",
      "pregnancy_not_recommended",
    ],
    sourceEMA:
      "https://www.ema.europa.eu/en/documents/product-information/saxenda-epar-product-information_en.pdf",
  },

  // §1.5 — Dulaglutide (Trulicity). Weekly SC, half-life ~5 d per
  // EMA EPAR §5.2. SC bioavailability ~47–65%.
  dulaglutide: {
    inn: "Dulaglutide",
    brands: ["Trulicity"],
    route: "subcutaneous",
    drugClass: "GLP-1 receptor agonist",
    pharmacology: {
      halfLifeDays: 5.0, // EMA EPAR §5.2
      tmaxHours: 48, // EMA EPAR §5.2 (Tmax 24–72 h)
      absorptionRateHourlyKa: null, // not published in EMA EPAR pop-PK
      bioavailability: 0.47, // EMA EPAR §5.2 (47% min of 47–65% range)
      vdLitersPerKg: 0.27, // EMA EPAR §5.2 (Vc/F ~19.2 L → ~0.27 L/kg)
      clearanceLPerHour70kg: 0.107, // EMA EPAR §5.2 (~0.107 L/h)
      steadyStateWeeks: 2, // EMA EPAR §5.2 (~2 weeks)
      compartmentModel: "two-compartment",
    },
    titrationStepsMg: [0.75, 1.5, 3.0, 4.5], // EMA EPAR §4.2
    titrationIntervalWeeks: 4,
    maxDoseMg: 4.5,
    standardInjectionFrequency: "weekly",
    indications: {
      t2dm: { firstLine: false }, // adjunct
      weightManagement: { bmiThreshold: null }, // not approved for weight mgmt
    },
    storage: {
      unopened: { temperatureCelsius: { min: 2, max: 8 } },
      inUse: { temperatureCelsius: { min: 2, max: 30 }, maxDays: 14 }, // EMA §6.3
    },
    pen: {
      type: "Single-dose pen",
      dosesPerPen: 1, // disposable single-dose
    },
    sideEffects: {
      veryCommon: ["nausea", "diarrhea", "vomiting", "abdominal_pain"],
      common: [
        "hypoglycaemia",
        "decreased_appetite",
        "dyspepsia",
        "constipation",
        "flatulence",
        "abdominal_distension",
        "gerd",
        "eructation",
        "fatigue",
        "injection_site_reaction",
        "sinus_tachycardia",
        "first_degree_av_block",
      ],
      uncommon: ["cholelithiasis", "cholecystitis", "acute_pancreatitis"],
      rare: ["anaphylactic_reaction", "angioedema"],
    },
    contraindications: ["hypersensitivity_active_substance_or_excipients"],
    warnings: [
      "pancreatitis_history",
      "severe_gi_disease",
      "diabetic_retinopathy_macular_oedema",
      "dehydration_risk",
    ],
    sourceEMA:
      "https://www.ema.europa.eu/en/documents/product-information/trulicity-epar-product-information_en.pdf",
  },

  // Exenatide — twin product lines: Byetta (IR, twice-daily,
  // t½ ~2.4 h) and Bydureon (extended-release, weekly,
  // terminal t½ ~2 weeks). The record captures the IR profile as
  // the default; the brand list flags Bydureon as the ER variant.
  // The standard frequency reflects the IR formulation; Bydureon
  // consumers must consult the Bydureon-specific EPAR for cadence.
  exenatide: {
    inn: "Exenatide",
    brands: ["Byetta", "Bydureon"],
    route: "subcutaneous",
    drugClass: "GLP-1 receptor agonist",
    pharmacology: {
      halfLifeDays: 2.4 / 24, // Byetta IR — ~2.4 h per EMA EPAR §5.2
      tmaxHours: 2.1, // EMA Byetta §5.2 (median ~2 h)
      absorptionRateHourlyKa: null, // not published
      bioavailability: 0.65, // EMA Byetta §5.2 (~65%)
      vdLitersPerKg: 0.4, // EMA Byetta §5.2 (~28 L / 70 kg)
      clearanceLPerHour70kg: 9.1, // EMA Byetta §5.2 (~9.1 L/h)
      steadyStateWeeks: 1,
      compartmentModel: "two-compartment",
    },
    titrationStepsMg: [0.005, 0.01], // Byetta 5 µg → 10 µg twice daily
    titrationIntervalWeeks: 4, // Byetta §4.2 (escalate after ≥4 wk)
    maxDoseMg: 0.01,
    standardInjectionFrequency: "twice-daily",
    indications: {
      t2dm: { firstLine: false }, // adjunct only
      weightManagement: { bmiThreshold: null }, // not approved for weight mgmt
    },
    storage: {
      unopened: { temperatureCelsius: { min: 2, max: 8 } },
      inUse: { temperatureCelsius: { min: 2, max: 25 }, maxDays: 30 }, // Byetta §6.3
    },
    pen: {
      type: "Pre-filled pen (Byetta) / weekly suspension (Bydureon)",
      dosesPerPen: 60, // Byetta 60 doses per pen
    },
    sideEffects: {
      veryCommon: [
        "hypoglycaemia",
        "nausea",
        "vomiting",
        "diarrhea",
      ],
      common: [
        "decreased_appetite",
        "dizziness",
        "headache",
        "dyspepsia",
        "abdominal_pain",
        "gerd",
        "flatulence",
        "abdominal_distension",
        "constipation",
        "eructation",
        "hyperhidrosis",
        "injection_site_reaction",
        "fatigue",
      ],
      uncommon: [
        "dehydration",
        "cholelithiasis",
        "acute_pancreatitis",
        "renal_failure",
      ],
      rare: ["anaphylactic_reaction", "angioedema"],
    },
    contraindications: [
      "hypersensitivity_active_substance_or_excipients",
      "severe_renal_impairment_egfr_below_30",
    ],
    warnings: [
      "pancreatitis_history",
      "severe_gi_disease",
      "renal_impairment",
      "pregnancy_not_recommended",
    ],
    sourceEMA:
      "https://www.ema.europa.eu/en/documents/product-information/byetta-epar-product-information_en.pdf",
  },
} as const;

/**
 * Resolve the route for a given drug + brand. Falls back to the
 * record default when no per-brand override is registered. Read by
 * the glp1-knowledge test suite.
 */
export function routeForBrand(
  drugId: Glp1DrugId,
  brand: string,
): Glp1Route | null {
  const record = GLP1_DRUGS[drugId];
  if (!record) return null;
  if (!record.brands.includes(brand)) return null;
  if (record.brandRoutes && brand in record.brandRoutes) {
    return record.brandRoutes[brand];
  }
  return record.route;
}

/**
 * Lookup helper — given an arbitrary brand string, find the drug
 * record that lists it (case-insensitive). Returns null when the
 * brand is unknown; useful for connecting free-text medication
 * names to the catalog.
 */
export function findDrugByBrand(brand: string): Glp1DrugRecord | null {
  const needle = brand.trim().toLowerCase();
  if (!needle) return null;
  for (const record of Object.values(GLP1_DRUGS)) {
    if (record.brands.some((b) => b.toLowerCase() === needle)) {
      return record;
    }
  }
  return null;
}

/**
 * Lookup helper — given an arbitrary brand string, find the drug ID
 * (catalog key) that lists it. Combines `findDrugByBrand` with the
 * `GLP1_DRUGS` reverse-lookup pattern previously hand-rolled in the
 * DrugLevelChart and the titration route. Returns null when the brand
 * is unknown.
 */
export function findDrugIdByBrand(brand: string): Glp1DrugId | null {
  const record = findDrugByBrand(brand);
  if (!record) return null;
  for (const [id, candidate] of Object.entries(GLP1_DRUGS)) {
    if (candidate === record) return id as Glp1DrugId;
  }
  return null;
}

/**
 * The catalog's drug-ids in stable order. Read by the GLP-1 PK +
 * ladder test suites so a future drug addition flows through the
 * verification matrix without a hand-rolled list.
 */
export const GLP1_DRUG_IDS: readonly Glp1DrugId[] = [
  "tirzepatide",
  "semaglutide",
  "liraglutide",
  "dulaglutide",
  "exenatide",
] as const;

