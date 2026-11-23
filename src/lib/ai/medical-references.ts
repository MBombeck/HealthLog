/**
 * v1.4.16 — curated medical-reference bundle.
 *
 * Every normative claim in an AI-generated recommendation ("target
 * < 140/90", "BMI 18.5-24.9", "≥ 7h sleep") MUST cite an entry in
 * this list via `recommendation.referenceId`. The schema in
 * `src/lib/ai/schema.ts` validates `referenceId` against
 * `MEDICAL_REFERENCE_IDS`, so the model cannot fabricate a guideline
 * citation pointing at a source that does not exist.
 *
 * Curation policy:
 *   - Only major bodies: AHA, ESH, ESC, WHO, DGE (German nutrition
 *     society), ADA. No advocacy groups, no SEO health sites, no
 *     research previews.
 *   - URLs go directly to the guideline page, not to a press release.
 *     They open in a new tab via `target="_blank" rel="noreferrer"`.
 *   - publishedYear matches the document version we cite. When a body
 *     refreshes the guideline, bump the year and update the URL in the
 *     same commit.
 *   - Locale: `title` is English-canonical, `titleDe` is the German
 *     UI label. The body of the guideline itself is whatever language
 *     the publishing body uses; the URL is the truth.
 *
 * The shape is intentionally narrower than the full §1.4.16 roadmap's
 * "embedded excerpt" plan — that is a v1.4.17+ enhancement and would
 * require fair-use-length quotations, locale-routed excerpts, and a
 * scrape pipeline. v1.4.16 ships the citation grounding only: the
 * model emits an id, the UI renders a labelled link.
 */

export type MedicalReferenceOrg = "AHA" | "ESH" | "ESC" | "WHO" | "DGE" | "ADA";

export type MedicalReferenceMetric =
  "bp" | "weight" | "pulse" | "mood" | "medication";

export interface MedicalReference {
  /** Stable slug — used as `recommendation.referenceId`. */
  id: string;
  /** Issuing body. Stable contract value, do not translate. */
  org: MedicalReferenceOrg;
  /** Title in English (canonical UI text). */
  title: string;
  /** Title in German for the de-locale UI footnote. */
  titleDe: string;
  /** Direct link to the guideline page. https only. */
  url: string;
  /** Year the guideline / position paper was published. */
  publishedYear: number;
  /**
   * Fine-grained scope tags — used by future filtering / display
   * logic. Free-form strings; not validated.
   */
  scope: string[];
  /**
   * High-level metric buckets the reference applies to. The prompt
   * builder picks references whose buckets overlap the metrics in the
   * current snapshot.
   */
  metricApplicability: MedicalReferenceMetric[];
}

export const MEDICAL_REFERENCES: MedicalReference[] = [
  {
    id: "esh-2023-bp-adults",
    org: "ESH",
    title: "ESH 2023 Guidelines for the Management of Arterial Hypertension",
    titleDe: "ESH-Leitlinie 2023 zur Behandlung der arteriellen Hypertonie",
    url: "https://www.eshonline.org/guidelines/2023-esh-guidelines/",
    publishedYear: 2023,
    scope: ["bp_target", "bp_classification", "lifestyle"],
    metricApplicability: ["bp", "medication"],
  },
  {
    id: "esc-2024-bp-cv",
    org: "ESC",
    title:
      "ESC 2024 Guidelines for the Management of Elevated Blood Pressure and Hypertension",
    titleDe:
      "ESC-Leitlinie 2024 zur Behandlung von erhöhtem Blutdruck und Hypertonie",
    url: "https://www.escardio.org/Guidelines/Clinical-Practice-Guidelines/2024-Guidelines-on-Elevated-BP-and-Hypertension",
    publishedYear: 2024,
    scope: ["bp_target", "bp_thresholds", "cv_risk"],
    metricApplicability: ["bp", "pulse", "medication"],
  },
  {
    id: "aha-2017-hypertension",
    org: "AHA",
    title:
      "ACC/AHA 2017 Guideline for the Prevention, Detection, Evaluation and Management of High Blood Pressure in Adults",
    titleDe:
      "ACC/AHA-Leitlinie 2017 zur Prävention, Erkennung, Bewertung und Behandlung von Bluthochdruck bei Erwachsenen",
    url: "https://www.ahajournals.org/doi/10.1161/HYP.0000000000000065",
    publishedYear: 2017,
    scope: ["bp_target", "bp_classification"],
    metricApplicability: ["bp"],
  },
  {
    id: "who-2021-hypertension",
    org: "WHO",
    title:
      "WHO Guideline for the Pharmacological Treatment of Hypertension in Adults",
    titleDe:
      "WHO-Leitlinie zur pharmakologischen Behandlung der Hypertonie bei Erwachsenen",
    url: "https://www.who.int/publications/i/item/9789240033986",
    publishedYear: 2021,
    scope: ["bp_target", "treatment", "lifestyle"],
    metricApplicability: ["bp", "medication"],
  },
  {
    id: "who-2024-bmi-classification",
    org: "WHO",
    title: "WHO BMI classification for adults",
    titleDe: "WHO-BMI-Klassifikation für Erwachsene",
    url: "https://www.who.int/europe/news-room/fact-sheets/item/a-healthy-lifestyle---who-recommendations",
    publishedYear: 2024,
    scope: ["bmi_classification", "weight_target"],
    metricApplicability: ["weight"],
  },
  {
    id: "dge-2024-healthy-eating",
    org: "DGE",
    title: "DGE recommendations for a wholesome diet",
    titleDe: "DGE-Empfehlungen für eine vollwertige Ernährung",
    url: "https://www.dge.de/gesunde-ernaehrung/dge-empfehlungen/",
    publishedYear: 2024,
    scope: ["nutrition", "weight_target", "lifestyle"],
    metricApplicability: ["weight", "mood"],
  },
  {
    id: "aha-2023-resting-heart-rate",
    org: "AHA",
    title: "AHA — All About Heart Rate (Pulse)",
    titleDe: "AHA — Alles über die Herzfrequenz (Puls)",
    url: "https://www.heart.org/en/health-topics/high-blood-pressure/the-facts-about-high-blood-pressure/all-about-heart-rate-pulse",
    publishedYear: 2023,
    scope: ["pulse_target", "resting_heart_rate"],
    metricApplicability: ["pulse"],
  },
];

/** Stable list of all valid `recommendation.referenceId` values. */
export const MEDICAL_REFERENCE_IDS: readonly string[] = MEDICAL_REFERENCES.map(
  (r) => r.id,
);

/** Stable list of all distinct issuing bodies. */
export const MEDICAL_REFERENCE_ORGS: readonly MedicalReferenceOrg[] =
  Array.from(new Set(MEDICAL_REFERENCES.map((r) => r.org)));

/**
 * Map the set of feature/snapshot sections present for a generation onto
 * the reference metric buckets. Lets the insight consumers pick the
 * applicable curated SOURCES without re-encoding the bucket names.
 *
 * `present` carries one boolean per high-level section the snapshot
 * actually contains; absent / false sections drop their bucket so a
 * weight-only generation never lists ESH BP guidance.
 */
export function metricsFromPresentSections(present: {
  bloodPressure?: boolean;
  weight?: boolean;
  pulse?: boolean;
  mood?: boolean;
  medication?: boolean;
}): MedicalReferenceMetric[] {
  const out: MedicalReferenceMetric[] = [];
  if (present.bloodPressure) out.push("bp");
  if (present.weight) out.push("weight");
  if (present.pulse) out.push("pulse");
  if (present.mood) out.push("mood");
  if (present.medication) out.push("medication");
  return out;
}

/**
 * Pick the references whose `metricApplicability` overlaps any of the
 * supplied metric buckets. Order preserved from the canonical bundle
 * for stable prompt rendering.
 */
export function selectReferencesForMetrics(
  metrics: readonly MedicalReferenceMetric[],
): MedicalReference[] {
  if (metrics.length === 0) return [];
  const wanted = new Set(metrics);
  return MEDICAL_REFERENCES.filter((r) =>
    r.metricApplicability.some((m) => wanted.has(m)),
  );
}
