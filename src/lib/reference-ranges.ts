/**
 * v1.18.6 — citation-backed reference-range backbone.
 *
 * A single structured source of truth for the population reference bands
 * the UI surfaces (explainer captions, metric tiles, the glossary, the
 * "where your value sits" tooltip). Each metric carries:
 *   - the canonical display unit,
 *   - one or more named `bands` (low/high half-open, with the body + year
 *     that publishes them via a `CitationId`),
 *   - the primary `referenceId` (the body the headline band is sourced to),
 *   - an optional `conflicts[]` of alternative-guideline context (e.g. the
 *     BP US/EU disagreement — shown as placement context, never the
 *     shipped classification),
 *   - a `guidanceCaveat` that frames the band as general guidance.
 *
 * This module is intentionally read-only data + pure helpers — no DB, no
 * LLM, no per-user state. The metric-status registry fills its coarse
 * `normalRange` from these bands; the BP detail surface reads the PP / MAP
 * anchors; the explainers read `referenceLabel()` for the cited sentence.
 *
 * Every band traces to `src/lib/medical-citations.ts`. No commercial brand
 * is named anywhere. Ranges are population anchors that shift with age,
 * sex and condition — the user's own baseline always leads the read; these
 * are a placement aid, not a diagnosis. Where authoritative bodies
 * disagree the disagreement is surfaced (`conflicts`), never silently
 * resolved.
 */
import { type CitationId, citationLabel } from "./medical-citations";

/**
 * A single named reference band. `low`/`high` are inclusive display
 * anchors in the metric's unit; either bound may be omitted for an
 * open-ended band (e.g. "≥7 h", "<100 mg/dL").
 */
export interface ReferenceBand {
  /** Stable, human-readable band label ("Normal", "Elevated", "Fever"). */
  readonly label: string;
  readonly low?: number;
  readonly high?: number;
  /** The body + year that publishes this band. */
  readonly citation: CitationId;
  /**
   * Marks THE population-normal / target band — the placement
   * `classifyReference` treats as "within" and `headlineBandText` renders
   * as the headline. Exactly one band per metric (with at least one band)
   * carries this. Bands are NOT assumed normal by index: a metric whose
   * first band is abnormal (BMI → Underweight first; pulse pressure →
   * Narrow first) marks the correct interior band instead. A test asserts
   * the one-marker-per-banded-metric invariant.
   */
  readonly normal?: boolean;
}

/**
 * An alternative-guideline framing shown as CONTEXT next to the default
 * band — never the shipped classification. The BP US/EU split is the
 * canonical use.
 */
export interface ReferenceConflict {
  /** Short note describing the alternative framing (general education). */
  readonly note: string;
  readonly citation: CitationId;
}

export interface ReferenceRange {
  /** Canonical display unit (matches the metric tile + registry). */
  readonly unit: string;
  /**
   * Ordered population bands. The "good"/normal placement is the band
   * flagged `normal: true` — NOT necessarily the first entry. Some metrics
   * (BMI, pulse pressure) author an abnormal band first, so consumers must
   * resolve the normal band by the marker, never by index.
   */
  readonly bands: readonly ReferenceBand[];
  /** The body the headline band is sourced to (drives the cited sentence). */
  readonly referenceId: CitationId;
  /** Alternative-guideline context, shown for placement only. */
  readonly conflicts?: readonly ReferenceConflict[];
  /** One-sentence general-guidance frame surfaced under the band. */
  readonly guidanceCaveat: string;
}

/**
 * The reference-metric slugs the backbone covers. Stable string keys (not
 * the DB enum) so the UI, the registry and the explainer can all read one
 * vocabulary. A superset of the universal metrics + the cardiovascular
 * derivations the explainers cite.
 */
export type ReferenceMetric =
  | "BLOOD_PRESSURE"
  | "PULSE_PRESSURE"
  | "MEAN_ARTERIAL_PRESSURE"
  | "PULSE_WAVE_VELOCITY"
  | "RESTING_HEART_RATE"
  | "HEART_RATE_VARIABILITY"
  | "OXYGEN_SATURATION"
  | "RESPIRATORY_RATE"
  | "BODY_TEMPERATURE"
  | "BLOOD_GLUCOSE"
  | "HBA1C"
  | "BMI"
  | "STEPS"
  | "VISCERAL_FAT"
  | "SLEEP_DURATION";

export const REFERENCE_RANGES: Record<ReferenceMetric, ReferenceRange> = {
  // ── Blood pressure — ESH 2023 is the SHIPPED default (do not flip). ──
  // ACC/AHA 2017 + ESC 2024 are surfaced only as placement CONTEXT.
  BLOOD_PRESSURE: {
    unit: "mmHg",
    bands: [
      // ESH grade bands (office, mmHg, systolic anchors shown).
      {
        label: "Optimal",
        high: 120,
        citation: "ESH_2023_HYPERTENSION",
        normal: true,
      },
      {
        label: "Normal",
        low: 120,
        high: 129,
        citation: "ESH_2023_HYPERTENSION",
      },
      {
        label: "High-normal",
        low: 130,
        high: 139,
        citation: "ESH_2023_HYPERTENSION",
      },
      { label: "Hypertension", low: 140, citation: "ESH_2023_HYPERTENSION" },
    ],
    referenceId: "ESH_2023_HYPERTENSION",
    conflicts: [
      {
        note: "ACC/AHA (US) labels 130–139/80–89 as Stage 1 hypertension — a stricter line than the European disease threshold of 140/90.",
        citation: "ACC_AHA_2017_BP",
      },
      {
        note: "ESC 2024 adds an 'Elevated' band at 120–139/70–89 and a treated target of 120–129.",
        citation: "ESC_2024_BP",
      },
    ],
    guidanceCaveat:
      "Categorised from a standardised seated reading or a validated home average — never a single reading. Targets individualise by age and condition.",
  },

  // Pulse pressure = SBP − DBP. Pure derivation of stored BP.
  PULSE_PRESSURE: {
    unit: "mmHg",
    bands: [
      { label: "Narrow", high: 25, citation: "STATPEARLS_PULSE_PRESSURE" },
      {
        label: "Typical at rest",
        low: 25,
        high: 60,
        citation: "STATPEARLS_PULSE_PRESSURE",
        normal: true,
      },
      { label: "Wide", low: 60, citation: "STATPEARLS_PULSE_PRESSURE" },
    ],
    referenceId: "STATPEARLS_PULSE_PRESSURE",
    guidanceCaveat:
      "A wide gap (≳60) in middle age can reflect arterial stiffening; a narrow gap (≲25) can accompany low stroke volume. A discussion prompt, not a diagnosis.",
  },

  // Mean arterial pressure ≈ (SBP + 2·DBP)/3.
  MEAN_ARTERIAL_PRESSURE: {
    unit: "mmHg",
    bands: [
      {
        label: "Resting band",
        low: 70,
        high: 100,
        citation: "STATPEARLS_MAP",
        normal: true,
      },
    ],
    referenceId: "STATPEARLS_MAP",
    guidanceCaveat:
      "The average pressure your organs see across a heartbeat. The ~60 mmHg floor is an acute-care concept, not a consumer self-alarm.",
  },

  PULSE_WAVE_VELOCITY: {
    unit: "m/s",
    bands: [
      {
        label: "Reference",
        high: 10,
        citation: "ESC_ESH_2018_PWV",
        normal: true,
      },
      { label: "Elevated stiffness", low: 10, citation: "ESC_ESH_2018_PWV" },
    ],
    referenceId: "ESC_ESH_2018_PWV",
    guidanceCaveat:
      "The cf-PWV >10 m/s organ-damage marker is a European clinical reference measured by tonometry; a consumer estimate is a proxy, not interchangeable.",
  },

  // ── Resting heart rate — uses RESTING_HEART_RATE, never workout pulse. ──
  // The 60–100 band carries `normal: true`, so `classifyReference` treats it
  // as the "within" placement regardless of band order. The athletic band
  // (40–60) is benign for a trained heart but sits below the standard
  // normal range — the caveat copy carries that nuance.
  RESTING_HEART_RATE: {
    unit: "bpm",
    bands: [
      {
        label: "Normal adult resting",
        low: 60,
        high: 100,
        citation: "AHA_2024_RHR",
        normal: true,
      },
      {
        label: "Athletic (benign)",
        low: 40,
        high: 60,
        citation: "AHA_2024_RHR",
      },
    ],
    referenceId: "AHA_2024_RHR",
    guidanceCaveat:
      "Measured at rest, ideally on waking. A trained heart can sit 40–60 bpm; the trend over weeks beats any single reading. Caffeine, stress, fever and medication all shift it.",
  },

  HEART_RATE_VARIABILITY: {
    unit: "ms",
    bands: [],
    referenceId: "ESC_NASPE_1996_HRV",
    guidanceCaveat:
      "There is no universal 'normal' — only your own trend is meaningful. Single-night swings of about ±10% are routine; track a 7-day rolling average and read changes smaller than that as noise.",
  },

  // ── SpO2 — healthy room-air band + darker-skin over-read caveat (C4). ──
  OXYGEN_SATURATION: {
    unit: "%",
    bands: [
      {
        label: "Healthy room air",
        low: 95,
        high: 100,
        citation: "STATPEARLS_PULSE_OX",
        normal: true,
      },
      {
        label: "Mild hypoxaemia",
        low: 91,
        high: 94,
        citation: "STATPEARLS_PULSE_OX",
      },
    ],
    referenceId: "STATPEARLS_PULSE_OX",
    guidanceCaveat:
      "95–100% is normal at rest; above ~98% adds no benefit. Optical readers can over-read true saturation in people with darker skin, so a single near-normal reading is not a clearance — confirm when warm, still and concerned.",
  },

  RESPIRATORY_RATE: {
    unit: "breaths/min",
    bands: [
      {
        label: "Normal resting adult",
        low: 12,
        high: 20,
        citation: "ALA_RESPIRATORY_RATE",
        normal: true,
      },
      { label: "Worth attention", low: 22, citation: "RCP_2017_NEWS2" },
    ],
    referenceId: "ALA_RESPIRATORY_RATE",
    guidanceCaveat:
      "Meaningful only truly at rest or asleep. A sustained rise of about +3 above your own nightly baseline can be an early illness signal; clinical escalation cutoffs are hospital tools, not self-alarms.",
  },

  // ── Body temperature — evidence-based 36.6 °C mean, fever ≥38 (C6). ──
  BODY_TEMPERATURE: {
    unit: "°C",
    bands: [
      {
        label: "Normal oral range",
        low: 35.7,
        high: 37.4,
        citation: "JGIM_2019_TEMPERATURE",
        normal: true,
      },
      { label: "Fever", low: 38.0, citation: "JGIM_2019_TEMPERATURE" },
    ],
    referenceId: "JGIM_2019_TEMPERATURE",
    guidanceCaveat:
      "The population mean is ~36.6 °C, not 37.0 °C, and swings ~0.5 °C across the day. Sites differ by up to ~1 °C, so tag the measurement site. Wearable wrist readings track relative change, not a fever value.",
  },

  // ── Glucose — GENERAL non-diabetic bands only (diabetes opt-in = W6). ──
  BLOOD_GLUCOSE: {
    unit: "mg/dL",
    bands: [
      {
        label: "Normal fasting",
        high: 100,
        citation: "ADA_2024_GLYCEMIC",
        normal: true,
      },
      {
        label: "Prediabetes (fasting)",
        low: 100,
        high: 125,
        citation: "ADA_2024_GLYCEMIC",
      },
      {
        label: "Diabetes range (fasting)",
        low: 126,
        citation: "ADA_2024_GLYCEMIC",
      },
    ],
    referenceId: "ADA_2024_GLYCEMIC",
    conflicts: [
      {
        note: "WHO/IDF set the prediabetes fasting floor at 110 mg/dL rather than 100; the diabetes line (≥126) is shared.",
        citation: "WHO_IDF_2006_GLUCOSE",
      },
    ],
    guidanceCaveat:
      "Fasting bands for adults without diabetes. A single high reading does not diagnose — a clinician confirms with a repeat test. People managing diabetes use different, clinician-set targets.",
  },

  HBA1C: {
    unit: "%",
    bands: [
      {
        label: "Normal",
        high: 5.7,
        citation: "ADA_2024_GLYCEMIC",
        normal: true,
      },
      {
        label: "Prediabetes",
        low: 5.7,
        high: 6.4,
        citation: "ADA_2024_GLYCEMIC",
      },
      { label: "Diabetes", low: 6.5, citation: "ADA_2024_GLYCEMIC" },
    ],
    referenceId: "ADA_2024_GLYCEMIC",
    guidanceCaveat:
      "Reflects the average glucose over ~2–3 months. Unreliable with altered red-cell turnover; when discordant with glucose, glucose takes precedence.",
  },

  BMI: {
    unit: "kg/m²",
    bands: [
      { label: "Underweight", high: 18.5, citation: "WHO_2020_PA" },
      {
        label: "Normal",
        low: 18.5,
        high: 24.9,
        citation: "WHO_2020_PA",
        normal: true,
      },
      { label: "Overweight", low: 25.0, high: 29.9, citation: "WHO_2020_PA" },
      { label: "Obesity", low: 30.0, citation: "WHO_2020_PA" },
    ],
    referenceId: "WHO_2000_BMI",
    guidanceCaveat:
      "A population-level screen, not a diagnosis — it does not distinguish muscle from fat or where fat sits. Asian-population risk rises at lower cut-offs.",
  },

  // ── Steps — canonical green floor = 8,000 (C2/D4 reconcile). ──
  STEPS: {
    unit: "steps/day",
    bands: [
      {
        label: "Higher mortality benefit",
        low: 8000,
        citation: "STEPS_SAINT_MAURICE_2020",
        normal: true,
      },
    ],
    referenceId: "STEPS_SAINT_MAURICE_2020",
    guidanceCaveat:
      "Mortality risk falls steeply toward ~8,000 steps/day with continued benefit through ~12,000; the optimal count is lower for older adults. The '10,000' figure is a marketing slogan, not research.",
  },

  VISCERAL_FAT: {
    unit: "rating",
    bands: [
      {
        label: "Healthy rating",
        low: 1,
        high: 12,
        citation: "VAT_IMAGING_THRESHOLD",
        normal: true,
      },
      { label: "Elevated rating", low: 13, citation: "VAT_IMAGING_THRESHOLD" },
    ],
    referenceId: "VAT_IMAGING_THRESHOLD",
    guidanceCaveat:
      "The consumer scale 'rating' (≈1–12 healthy) is a unitless scale, not the imaging cm² value (>100 cm² increased risk). High visceral fat is closely tied to heart disease and type 2 diabetes.",
  },

  // ── Sleep — adult 7–9 h; total sleep time beats the stage split. ──
  SLEEP_DURATION: {
    unit: "h",
    bands: [
      {
        label: "Adult 18–64",
        low: 7,
        high: 9,
        citation: "AASM_2015_SLEEP",
        normal: true,
      },
      {
        label: "Older adult 65+",
        low: 7,
        high: 8,
        citation: "AASM_2015_SLEEP",
      },
    ],
    referenceId: "AASM_2015_SLEEP",
    guidanceCaveat:
      "Both short and long habitual sleep carry risk. Regularity predicts health at least as strongly as duration, and a wearable's total sleep time is far more trustworthy than its deep/REM split.",
  },
};

/** All reference-metric slugs the backbone covers. */
export const REFERENCE_METRICS = Object.keys(
  REFERENCE_RANGES,
) as ReferenceMetric[];

/** Type guard narrowing an arbitrary string to a covered reference metric. */
export function isReferenceMetric(value: string): value is ReferenceMetric {
  return Object.prototype.hasOwnProperty.call(REFERENCE_RANGES, value);
}

/** Resolve the reference range for a metric, or null when uncovered. */
export function getReferenceRange(metric: string): ReferenceRange | null {
  return isReferenceMetric(metric) ? REFERENCE_RANGES[metric] : null;
}

/**
 * Localised "ESH 2023 (2023)"-style label for the headline band's source.
 * The citation name is canonical and not translated (locale-agnostic).
 */
export function referenceLabel(metric: ReferenceMetric): string {
  return citationLabel(REFERENCE_RANGES[metric].referenceId);
}

/**
 * The four-state "where your value sits" phrasing contract (UI-1). A
 * deterministic placement of a value against the metric's population
 * bands, ALWAYS framed as general guidance. Consumers map each state to a
 * cited i18n string; the state itself never asserts a diagnosis.
 *
 * - `within`          — inside the normal/good band.
 * - `slightly-outside`— in an adjacent watch band (e.g. high-normal,
 *                       prediabetes, mild hypoxaemia).
 * - `outside`         — in a band the guideline flags for attention.
 * - `insufficient`    — no value, or the metric carries no population band
 *                       (device-derived / baseline-only signals).
 */
export type ReferencePlacement =
  "within" | "slightly-outside" | "outside" | "insufficient";

/**
 * Place a value against a metric's population bands. Returns
 * `insufficient` when the value is absent or the metric has no fixed band
 * (HRV and other device-derived signals defer wholly to the personal
 * baseline). Pure + side-effect free; the user's own baseline still leads
 * the read — this is only a coarse placement aid.
 */
/**
 * Resolve the index of a metric's population-normal band — the band the
 * placement contract treats as "within". Returns the index of the band
 * flagged `normal: true`; falls back to band 0 only for the legacy
 * (untagged) shape so an unmarked metric degrades to the old normal-first
 * assumption rather than throwing. A metric with no bands returns -1.
 */
export function normalBandIndex(metric: ReferenceMetric): number {
  const bands = REFERENCE_RANGES[metric].bands;
  if (bands.length === 0) return -1;
  const marked = bands.findIndex((b) => b.normal === true);
  return marked === -1 ? 0 : marked;
}

export function classifyReference(
  metric: ReferenceMetric,
  value: number | null | undefined,
): ReferencePlacement {
  const range = REFERENCE_RANGES[metric];
  if (value == null || !Number.isFinite(value) || range.bands.length === 0) {
    return "insufficient";
  }
  const normalIdx = normalBandIndex(metric);
  // Find the band whose half-open interval contains the value. Bands are
  // authored in ascending order; the placement is the band's DISTANCE from
  // the normal band (resolved by the `normal` marker, NOT by index 0 —
  // some metrics author an abnormal band first, e.g. BMI Underweight,
  // pulse-pressure Narrow). One step from normal = watch tier; two or more
  // = attention tier.
  for (let i = 0; i < range.bands.length; i++) {
    const band = range.bands[i];
    const aboveLow = band.low == null || value >= band.low;
    const belowHigh = band.high == null || value <= band.high;
    if (aboveLow && belowHigh) {
      const distance = Math.abs(i - normalIdx);
      if (distance === 0) return "within";
      return distance === 1 ? "slightly-outside" : "outside";
    }
  }
  // Value sits beyond every authored band (below an open-low first band, or
  // above an open-high last band). Either way it is outside the covered
  // bands → attention.
  return "outside";
}
