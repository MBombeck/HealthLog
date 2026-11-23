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
   * The paper reports continued dose-response benefit (HR 0.49 at 8k
   * vs 4k, HR 0.35 at 12k vs 4k) — NOT a plateau. The plateau-shaped
   * finding belongs to Paluch 2022 Lancet Public Health (PMID
   * 35247352, age-stratified meta-analysis). WHO 2020 PA guidelines
   * publish minutes per week, NOT a step quota — DO NOT cite WHO
   * for a step number.
   */
  STEPS_SAINT_MAURICE_2020: {
    id: "steps-saint-maurice-2020",
    name: "Saint-Maurice JAMA 2020",
    year: 2020,
    url: "https://jamanetwork.com/journals/jama/fullarticle/2763292",
    caveat:
      "U.S. adult cohort, observational; benefit accumulates strongly through ~12k steps/day (continued dose-response, not a plateau).",
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

  // ── v1.18.6 — reference-range backbone sources ──

  /**
   * AHA — All About Heart Rate (resting + target heart rates), 2024.
   * Normal adult resting 60–100 bpm; endurance athletes benignly 40–60.
   * Consumer-facing orientation; symptomatic concern is the trigger for
   * care, not the number alone.
   */
  AHA_2024_RHR: {
    id: "aha-2024-rhr",
    name: "AHA 2024 Heart Rate",
    year: 2024,
    url: "https://www.heart.org/en/health-topics/high-blood-pressure/the-facts-about-high-blood-pressure/all-about-heart-rate-pulse",
    caveat:
      "General adult band; a trained heart can sit 40–60, and a new low with dizziness/fainting is the concern, not the number alone.",
  },

  /**
   * StatPearls/NIH — Pulse Oximetry (2023). Healthy adult room-air SpO₂
   * 95–100% (bulk 96–99%); mild hypoxaemia 91–94%; clinically significant
   * <90%. Consumer wrist/finger optical readers are wellness-grade
   * (±2–4%) and a single low reading is often artefact.
   */
  STATPEARLS_PULSE_OX: {
    id: "statpearls-pulse-ox",
    name: "StatPearls Pulse Oximetry",
    year: 2023,
    url: "https://www.ncbi.nlm.nih.gov/books/NBK470348/",
    caveat:
      "Healthy room-air band; consumer optical SpO₂ is ±2–4% and a single low reading is often artefact — sustained runs are the signal.",
  },

  /**
   * 2017 ACC/AHA Guideline for the Prevention, Detection, Evaluation and
   * Management of High Blood Pressure in Adults. Lowers the US disease
   * line: Normal <120/<80; Elevated 120–129/<80; Stage 1 130–139 or
   * 80–89; Stage 2 ≥140 or ≥90. Surfaced only as the stricter COMPARISON
   * anchor next to the shipped ESH default — never the labelled band.
   */
  ACC_AHA_2017_BP: {
    id: "acc-aha-2017-bp",
    name: "ACC/AHA 2017",
    year: 2017,
    url: "https://www.ahajournals.org/doi/10.1161/HYP.0000000000000065",
    caveat:
      "US guideline; labels 130–139/80–89 as Stage 1 — a stricter line than the ESH default, shown for placement only.",
  },

  /**
   * 2024 ESC Guidelines for the management of elevated blood pressure and
   * hypertension. Adds an "Elevated" diagnostic band (120–139/70–89) and a
   * treated SBP target of 120–129. Disease line stays ≥140/90 office.
   * Displayed as context alongside the ESH 2023 default.
   */
  ESC_2024_BP: {
    id: "esc-2024-bp",
    name: "ESC 2024",
    year: 2024,
    url: "https://academic.oup.com/eurheartj/article/45/38/3912/7741010",
    caveat:
      "European; introduces an 'Elevated' 120–139/70–89 band and a treated 120–129 target — context, not the shipped classification.",
  },

  /**
   * StatPearls/NCBI — Physiology, Pulse Pressure (NBK482408). PP = SBP −
   * DBP; ~40 mmHg typical at rest, wide ≳60 mmHg marks large-artery
   * stiffening, narrow ≲25 mmHg can accompany low stroke volume. A
   * "discuss with a clinician" signal, not a diagnosis.
   */
  STATPEARLS_PULSE_PRESSURE: {
    id: "statpearls-pulse-pressure",
    name: "StatPearls Pulse Pressure",
    year: 2023,
    url: "https://www.ncbi.nlm.nih.gov/books/NBK482408/",
    caveat:
      "Educational physiology reference; PP is a discussion prompt, never a standalone diagnosis.",
  },

  /**
   * StatPearls/NCBI — Physiology, Mean Arterial Pressure (NBK538226).
   * MAP ≈ (SBP + 2·DBP)/3; resting band ~70–100 mmHg, ~60 mmHg the
   * conventional organ-perfusion floor — an acute-care concept, NOT a
   * consumer self-alarm threshold.
   */
  STATPEARLS_MAP: {
    id: "statpearls-map",
    name: "StatPearls Mean Arterial Pressure",
    year: 2023,
    url: "https://www.ncbi.nlm.nih.gov/books/NBK538226/",
    caveat:
      "The ~60 mmHg floor is an acute-care perfusion concept, not a consumer alarm threshold.",
  },

  /**
   * 2018 ESC/ESH Guidelines for the management of arterial hypertension.
   * Source of the carotid-femoral PWV >10 m/s organ-damage cut-off and
   * the BP grade bands still widely cited. The PWV number is European;
   * AHA/ACC do not enshrine an equivalent consumer PWV threshold.
   */
  ESC_ESH_2018_PWV: {
    id: "esc-esh-2018-pwv",
    name: "ESC/ESH 2018",
    year: 2018,
    url: "https://academic.oup.com/eurheartj/article/39/33/3021/5079119",
    caveat:
      "cf-PWV >10 m/s is the European clinical reference; consumer PWV / vascular-age estimates are proxies, not clinical cf-PWV.",
  },

  /**
   * US FDA — pulse-oximeter accuracy and limitations (Feb 2024 advisory
   * committee review + safety communication). Oximeters can overestimate
   * true saturation in people with darker skin, roughly 3× more often
   * than in lighter-skinned patients (occult hypoxaemia).
   */
  FDA_2024_PULSE_OX: {
    id: "fda-2024-pulse-ox",
    name: "FDA 2024 Pulse Oximeter Review",
    year: 2024,
    url: "https://www.fda.gov/medical-devices/safety-communications/pulse-oximeter-accuracy-and-limitations-fda-safety-communication",
    caveat:
      "Documents over-reading in darker skin; a single near-normal reading is not a clearance — confirm when concerned.",
  },

  /**
   * "Normal Body Temperature: A Systematic Review" — J Gen Intern Med,
   * 2019. Population oral-equivalent mean ~36.6 °C (normal ~35.7–37.4 °C),
   * superseding the conventional 37.0 °C set point. Fever ≥38.0 °C oral.
   */
  JGIM_2019_TEMPERATURE: {
    id: "jgim-2019-temperature",
    name: "J Gen Intern Med 2019",
    year: 2019,
    url: "https://link.springer.com/article/10.1007/s11606-019-05148-7",
    caveat:
      "Oral-equivalent mean; sites differ by up to ~1 °C — tag the measurement site before comparing.",
  },

  /**
   * Royal College of Physicians — National Early Warning Score 2 (NEWS2),
   * 2017. Respiratory-rate scoring: highest-risk ≤8 and ≥25/min. A
   * hospital deterioration tool, not a consumer alarm.
   */
  RCP_2017_NEWS2: {
    id: "rcp-2017-news2",
    name: "RCP NEWS2 2017",
    year: 2017,
    url: "https://www.rcp.ac.uk/improving-care/resources/national-early-warning-score-news-2/",
    caveat:
      "Hospital deterioration score; the ≥25/min cutoff is clinical context, not a self-monitoring alarm.",
  },

  /**
   * American Lung Association — resting respiratory rate reference
   * (12–20 breaths/min for healthy adults). Consumer-facing vital-sign
   * orientation.
   */
  ALA_RESPIRATORY_RATE: {
    id: "ala-respiratory-rate",
    name: "American Lung Association",
    year: 2024,
    url: "https://www.lung.org/lung-health-diseases/how-lungs-work/breathing-rate",
    caveat:
      "General adult resting band; rates run higher in children and shift with activity, fever and emotion.",
  },

  /**
   * Peer-reviewed visceral-adipose-tissue imaging literature (2014–2025):
   * CT/MRI/DXA VAT area >~100 cm² increased-risk, >~160 cm² high-risk.
   * Ethnicity-dependent; the consumer scale "rating" is NOT a cm² value.
   */
  VAT_IMAGING_THRESHOLD: {
    id: "vat-imaging-threshold",
    name: "VAT imaging literature",
    year: 2025,
    url: "https://pubmed.ncbi.nlm.nih.gov/24008002/",
    caveat:
      "Imaging cm² thresholds; the consumer scale 'visceral fat rating' is a separate unitless scale, not interchangeable.",
  },

  /**
   * Wilcox AJ, Dunson D, Baird DD. "The timing of the 'fertile window' in
   * the menstrual cycle." BMJ, 2000. The 6-day fertile window ends on
   * ovulation day; ovulation timing is highly variable even in regular
   * cyclers.
   */
  WILCOX_2000_FERTILE_WINDOW: {
    id: "wilcox-2000-fertile-window",
    name: "Wilcox BMJ 2000",
    year: 2000,
    url: "https://www.bmj.com/content/321/7271/1259",
    caveat:
      "Fertile-window timing is highly variable; calendar estimates approximate and are not a contraceptive method.",
  },

  /**
   * ACOG Committee Opinion 651 (2015) — "Menstruation in Girls and
   * Adolescents: Using the Menstrual Cycle as a Vital Sign." Adult cycle
   * 24–38 days, bleeding ~5 days (up to ~7).
   *
   * NEEDS-VERIFY ACOG — the cycle-length / bleeding-duration figures cited
   * in the `insights.subPage.explainer.cycleEducationBody` copy, and any
   * "when to see a clinician" thresholds (cycle <21 / >35, amenorrhea ≥3
   * months, heavy bleeding >7 days), must be confirmed against the live
   * ACOG FAQ before shipping that copy to users (automated fetch was
   * rate-limited during research).
   */
  ACOG_CO651_2015: {
    id: "acog-co651-2015",
    name: "ACOG CO 651 2015",
    year: 2015,
    url: "https://www.acog.org/clinical/clinical-guidance/committee-opinion/articles/2015/12/menstruation-in-girls-and-adolescents-using-the-menstrual-cycle-as-a-vital-sign",
    caveat:
      "Cycle as a vital sign; exact clinician-consultation thresholds should be confirmed against the live ACOG FAQ.",
  },

  /**
   * Phillips AJK, et al. "Irregular sleep/wake patterns are associated
   * with poorer academic performance and delayed circadian and sleep/wake
   * timing." Sci Rep, 2017 — origin of the Sleep Regularity Index (SRI).
   * UK Biobank (Windred 2023/24) tied higher regularity to lower mortality.
   */
  PHILLIPS_2017_SRI: {
    id: "phillips-2017-sri",
    name: "Phillips Sci Rep 2017",
    year: 2017,
    url: "https://www.nature.com/articles/s41598-017-03171-4",
    caveat:
      "Sleep-regularity construct; no universal good/bad threshold — present as a personal trend.",
  },

  /**
   * US CDC — About Sleep / tips for better sleep (2024). Evidence-based
   * sleep-hygiene behaviours (consistent schedule, morning light, dim
   * evenings, caffeine timing, cool dark room).
   */
  CDC_2024_SLEEP: {
    id: "cdc-2024-sleep",
    name: "CDC 2024 Sleep",
    year: 2024,
    url: "https://www.cdc.gov/sleep/about/index.html",
    caveat: "General sleep-hygiene guidance; individual needs vary.",
  },

  /**
   * WHO — Obesity: preventing and managing the global epidemic (TRS 894),
   * 2000. The BMI classification still in use: underweight <18.5, normal
   * 18.5–24.9, overweight 25.0–29.9, obesity ≥30. Asian-population risk
   * rises at lower cut-offs (WHO 2004).
   */
  WHO_2000_BMI: {
    id: "who-2000-bmi",
    name: "WHO 2000 BMI",
    year: 2000,
    url: "https://www.who.int/publications/i/item/WHO_TRS_894",
    caveat:
      "Population screen, not a diagnosis; Asian-population risk rises at lower cut-offs and BMI does not distinguish muscle from fat.",
  },

  /**
   * WHO/IDF — Definition and Diagnosis of Diabetes Mellitus and
   * Intermediate Hyperglycaemia, 2006. Impaired fasting glucose floor of
   * 110 mg/dL (vs ADA's 100); the diabetes line (≥126) is shared.
   */
  WHO_IDF_2006_GLUCOSE: {
    id: "who-idf-2006-glucose",
    name: "WHO/IDF 2006",
    year: 2006,
    url: "https://www.who.int/publications/i/item/definition-and-diagnosis-of-diabetes-mellitus-and-intermediate-hyperglycaemia",
    caveat:
      "Sets the impaired-fasting-glucose floor at 110 mg/dL; the diabetes threshold (≥126) is shared with ADA.",
  },

  /**
   * ESC/NASPE Task Force — Heart Rate Variability: Standards of
   * Measurement, Physiological Interpretation and Clinical Use.
   * Circulation / Eur Heart J, 1996. Defines SDNN/RMSSD norms and the
   * prognostic 24-h SDNN bands; day-to-day swings of ~±10% are routine.
   */
  ESC_NASPE_1996_HRV: {
    id: "esc-naspe-1996-hrv",
    name: "ESC/NASPE HRV Standards 1996",
    year: 1996,
    url: "https://www.ahajournals.org/doi/10.1161/01.CIR.93.5.1043",
    caveat:
      "Clinical 24-h SDNN norms are NOT interchangeable with an overnight wearable RMSSD; only the personal trend is meaningful.",
  },
} as const satisfies Record<string, Citation>;

export type CitationId = keyof typeof CITATIONS;

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
