/**
 * Single source of truth for medical guideline citations.
 *
 * Every threshold, every range, every "ESC/ESH says…" statement in the
 * code or AI prompts MUST reference one of the entries below — either
 * by importing the constant directly or by quoting the same `name` and
 * `url` in a comment above the value.
 *
 * Adding a new citation:
 *   1. Verify the source against THREE independent reputable references
 *      (guideline document + WHO/fachgesellschaft + peer-reviewed paper
 *      or government publication is the gold standard).
 *   2. Capture the publication URL so the truthfulness drift-test can
 *      re-resolve it.
 *   3. Document any caveat ("BIA-derived, not DEXA-equivalent",
 *      "pediatric only", "treated cohort only") inline so consumers
 *      can decide whether the citation applies to their use case.
 *
 * Drift-test (`src/lib/__tests__/medical-citations.test.ts`) asserts
 * that every CITATIONS entry has a non-empty url + caveat field.
 */

export interface Citation {
  /** Stable id used to reference this citation in code. */
  readonly id: string;
  /** Human-readable name shown in UI ("source" attribution). */
  readonly name: string;
  /** Year of publication. */
  readonly year: number;
  /** Stable URL to the source document. */
  readonly url: string;
  /** One-sentence caveat about scope or limitation. */
  readonly caveat: string;
}

export const CITATIONS = {
  /**
   * 2023 ESH Guidelines for the management of arterial hypertension.
   * The last joint ESC/ESH guideline was 2018; ESH published 2023
   * standalone (ESC withdrew from the joint authoring). Targets that
   * HealthLog uses (SBP 120-129 / DBP 70-79 for <65; SBP 130-139 / DBP
   * 70-79 for ≥65) are unchanged from 2018 to 2023.
   */
  ESH_2023_HYPERTENSION: {
    id: "esh-2023-hypertension",
    name: "ESH 2023",
    year: 2023,
    url: "https://journals.lww.com/jhypertension/fulltext/2023/12000/2023_esh_guidelines_for_the_management_of_arterial.2.aspx",
    caveat: "Pure-hypertension guideline; not a joint ESC document since 2023.",
  },

  /**
   * Saint-Maurice PF, et al. "Association of daily step count and step
   * intensity with mortality among US adults." JAMA. 2020.
   * Mortality benefit plateaus 8 000–12 000 steps/day. WHO 2020 PA
   * guidelines publish minutes per week, NOT a step quota — DO NOT
   * cite WHO for a step number.
   */
  STEPS_SAINT_MAURICE_2020: {
    id: "steps-saint-maurice-2020",
    name: "Saint-Maurice JAMA 2020",
    year: 2020,
    url: "https://jamanetwork.com/journals/jama/fullarticle/2763292",
    caveat:
      "U.S. adult cohort, observational; benefit plateaus 8–12k steps/day.",
  },

  /**
   * WHO 2020 Guidelines on Physical Activity and Sedentary Behaviour.
   * Adults: 150-300 min/wk moderate OR 75-150 min/wk vigorous activity.
   * Cite this document for activity time, NOT for steps.
   */
  WHO_2020_PA: {
    id: "who-2020-physical-activity",
    name: "WHO 2020 Physical Activity",
    year: 2020,
    url: "https://www.who.int/publications/i/item/9789240015128",
    caveat: "Publishes minutes/week, not a step quota.",
  },

  /**
   * BTS Emergency Oxygen Guideline 2017 — explicit treatment target
   * 94-98% saturation (88-92% for chronic hypercapnia risk). Used as
   * comparison anchor for HealthLog's consumer band.
   */
  BTS_2017_OXYGEN: {
    id: "bts-2017-emergency-oxygen",
    name: "BTS 2017 Emergency Oxygen",
    year: 2017,
    url: "https://thorax.bmj.com/content/72/Suppl_1/ii1",
    caveat: "Hospital emergency context, not consumer monitoring.",
  },

  /**
   * NICE NG115 — Chronic obstructive pulmonary disease in over 16s:
   * diagnosis and management. Recommends ≤92% SpO2 as escalation
   * threshold ("call provider").
   */
  NICE_NG115_COPD: {
    id: "nice-ng115-copd",
    name: "NICE NG115",
    year: 2018,
    url: "https://www.nice.org.uk/guidance/ng115",
    caveat: "COPD-focused; useful as the 'call provider' floor.",
  },

  /**
   * ADA Standards of Medical Care in Diabetes — 2024 (§6 Glycemic
   * Targets). Pre-prandial 80-130 mg/dL, post-prandial <180 mg/dL.
   * No published adult bedtime target — ISPAD 2022 publishes 80-140
   * for pediatric T1D.
   */
  ADA_2024_GLYCEMIC: {
    id: "ada-2024-glycemic",
    name: "ADA 2024 Standards of Care",
    year: 2024,
    url: "https://diabetesjournals.org/care/article/47/Supplement_1/S111/153957",
    caveat:
      "Pre-prandial 80-130, post-prandial <180; no published adult bedtime target.",
  },

  /**
   * ISPAD Clinical Practice Consensus Guidelines 2022 — pediatric
   * T1D bedtime target 80-140 mg/dL. NOT validated for adults.
   */
  ISPAD_2022_PEDIATRIC: {
    id: "ispad-2022-pediatric",
    name: "ISPAD 2022",
    year: 2022,
    url: "https://onlinelibrary.wiley.com/doi/10.1111/pedi.13455",
    caveat: "Pediatric T1D context; not validated for adult use.",
  },

  /**
   * ACE (American Council on Exercise) body-fat percentage standards.
   * Essential fat: M 2-5% / F 10-13%. Athletes: M 6-13% / F 14-20%.
   * Fitness: M 14-17% / F 21-24%. Acceptable: M 18-24% / F 25-31%.
   * Obese: M 25%+ / F 32%+. Source widely cited; ACE bases the bands
   * on Heyward & Wagner "Applied Body Composition Assessment".
   */
  ACE_BODY_FAT: {
    id: "ace-body-fat-standards",
    name: "ACE Body-Fat Standards",
    year: 2009,
    url: "https://www.acefitness.org/resources/everyone/blog/112/what-are-the-guidelines-for-percentage-of-body-fat-loss/",
    caveat:
      "Reference categories; clinical decisions should use DEXA or hydrostatic.",
  },

  /**
   * AASM 2015 — adults need 7+ hours of sleep on a regular basis.
   * 9+ hours acceptable for young adults, less for older adults.
   */
  AASM_2015_SLEEP: {
    id: "aasm-2015-adult-sleep",
    name: "AASM 2015 Adult Sleep Duration",
    year: 2015,
    url: "https://aasm.org/resources/pdf/pressroom/adult-sleep-duration-consensus.pdf",
    caveat: "Target ≥7h adults; older adults may need slightly less.",
  },

  /**
   * Watson PE, et al. "Total body water volumes for adult males and
   * females estimated from simple anthropometric measurements." Am J
   * Clin Nutr. 1980. Establishes the canonical TBW (L) equations
   * referenced by Withings hydration estimates.
   */
  WATSON_1980_TBW: {
    id: "watson-1980-tbw",
    name: "Watson 1980 TBW formula",
    year: 1980,
    url: "https://pubmed.ncbi.nlm.nih.gov/6986753/",
    caveat:
      "Original anthropometric TBW equations; predictive, not measurement.",
  },

  /**
   * ICRP Publication 89 (2002) — Reference values for adult human TBW
   * (~42 L male, ~29 L female). Used as bounds for plausibility checks.
   */
  ICRP_89_REFERENCE_MAN: {
    id: "icrp-89-reference-man",
    name: "ICRP 89 Reference Man",
    year: 2002,
    url: "https://www.icrp.org/publication.asp?id=ICRP%20Publication%2089",
    caveat:
      "Reference values for an idealised adult; individual variation broad.",
  },
} as const satisfies Record<string, Citation>;

export type CitationId = keyof typeof CITATIONS;

/** Returns the URL for the given citation id. */
export function citationUrl(id: CitationId): string {
  return CITATIONS[id].url;
}

/**
 * Returns a localized "source: NAME (YEAR)" string for UI use.
 * Locale-agnostic for now (English-first); German UI consumers can
 * format the year via `Intl.NumberFormat` if needed but the citation
 * name itself is canonical and not translated.
 */
export function citationLabel(id: CitationId): string {
  const c = CITATIONS[id];
  return `${c.name} (${c.year})`;
}
