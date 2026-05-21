import { z } from "zod/v4";
import { MEDICAL_REFERENCE_IDS } from "./medical-references";

/**
 * Strict response schema for v1.4.15 AI hardening (Phase C1).
 *
 * the maintainer, verbatim 2026-05-09: "Es darf null Halluzinationen haben und es
 * muss sich halt irgendwie stützen auf medizinische Dinge."  ("It must
 * have zero hallucinations and must ground on medical facts.")
 *
 * The schema enforces:
 *   - A short natural-language summary.
 *   - A typed `recommendations[]` where each item is structured
 *     (`id`, `text`, `severity`) and MUST cite the user-data point that
 *     justified it via `metricSource`. An empty `metricSource.summary`
 *     fails parse — the model cannot fabricate recommendations without
 *     pointing to a number from the user's snapshot.
 *   - A `citations[]` array referencing the metrics the response drew
 *     on. May be empty when `recommendations[]` is empty (no data → no
 *     citation), but every recommendation's `metricSource` MUST also
 *     appear in `citations[]` (cross-check enforced by `validateInsightResponse`).
 *   - A `warnings[]` array for guideline-flagged values (high BP,
 *     critical pulse, etc.). Free-form for now; v1.4.16 adds severity
 *     enum + medical-reference grounding.
 *
 * Legacy rich fields (`classification`, `findings`, `correlations`,
 * `dataQuality`, `disclaimer`) remain accepted via `.passthrough()` so
 * cached payloads from v1.4.14 still hydrate the dashboard. The
 * v1.4.16 roadmap (`docs/audit/v1416-ai-roadmap.md`) plans the full
 * migration to the strict shape once all consumers move over.
 */

// Severity levels — generic for v1.4.15. v1.4.16 adds a clinical
// severity enum keyed to ESH/ESC and AHA guidelines.
export const recommendationSeveritySchema = z.enum([
  "info",
  "suggestion",
  "important",
  "urgent",
]);

/**
 * Citation-from-data: every recommendation must point to a concrete
 * snapshot field that justified it. Empty `summary` is rejected.
 */
export const metricSourceSchema = z.object({
  /**
   * Snapshot key — e.g. "bloodPressure", "weight", "pulse",
   * "medications.compliance30". Free-form because the snapshot shape
   * itself is rich; v1.4.16 narrows to a typed enum.
   */
  type: z.string().min(1, "metricSource.type required"),
  /**
   * Time window the value covers — e.g. "last7days", "last30days",
   * "allTime". v1.4.16 narrows this enum.
   */
  timeRange: z.string().min(1, "metricSource.timeRange required"),
  /**
   * Human-readable summary of the data point — e.g. "avg 142/88 over
   * 12 readings" or "compliance 0.71 / 30d". Empty value rejected so
   * the model cannot fake a citation.
   */
  summary: z
    .string()
    .min(1, "metricSource.summary required (zero-hallucination)"),
  /** Sample count behind the value, when known. */
  n: z.number().int().nonnegative().optional(),
});

/**
 * Set of valid `referenceId` values, derived from
 * `MEDICAL_REFERENCES` so the two cannot drift. Validated lazily
 * inside `superRefine` instead of `z.enum(...)` because the bundle is
 * a `string[]` constant — `z.enum` requires a tuple type.
 */
const MEDICAL_REFERENCE_ID_SET: ReadonlySet<string> = new Set(
  MEDICAL_REFERENCE_IDS,
);

/**
 * v1.4.16 phase B5c — per-recommendation explainability rationale.
 *
 * Each rec carries a 3-field rationale that powers the Oura-style
 * "Contributors" expand-card:
 *
 *   - dataWindow: which time window the rec is based on. Mirrors the
 *     `metricSource.timeRange` enum so the UI's mini-chart can pin
 *     to the same window the rec was derived from.
 *   - comparedTo: the user's own baseline OR a population norm the
 *     deviation is being measured against — e.g.
 *     "your 90-day median (73 bpm)" or "ESH ceiling 140/90".
 *   - deviation: the size + direction of the deviation that triggered
 *     the rec — e.g. "+5 bpm above baseline over 7 of 7 days".
 *
 * Empty `comparedTo` or `deviation` is rejected so the model cannot
 * emit a placeholder rationale card. the maintainer's mandate from B5a stays:
 * zero hallucinations, every rec must trace back to user data.
 */
export const aiRecommendationRationaleSchema = z.object({
  /**
   * Time window the rec is based on. Same enum the UI's mini-chart
   * uses, so the chart can pin to the rationale's window regardless
   * of any parent range tab.
   */
  dataWindow: z.enum(["last7days", "last30days", "last90days", "allTime"]),
  /**
   * What the deviation is being compared against — the user's own
   * baseline or a guideline ceiling. Free-form so the model can be
   * specific ("your 90-day median (73 bpm)").
   */
  comparedTo: z.string().min(1, "rationale.comparedTo required"),
  /**
   * Size + direction of the deviation. Free-form so the model can be
   * specific ("+5 bpm above baseline over 7 of 7 days").
   */
  deviation: z.string().min(1, "rationale.deviation required"),
});

export const aiRecommendationSchema = z
  .object({
    /**
     * Stable identifier for the recommendation within this response.
     * Used by the future user-feedback loop ("was this helpful?",
     * v1.4.16 roadmap). Format: short slug (`rec-1`, `bp-elevated`).
     */
    id: z.string().min(1, "recommendation.id required"),
    /** Human-readable recommendation text. */
    text: z.string().min(1, "recommendation.text required"),
    /**
     * Mandatory citation — the data point that justified the
     * recommendation. Closes the "ungrounded boilerplate" risk the maintainer
     * called out: every recommendation must trace back to user data.
     */
    metricSource: metricSourceSchema,
    /** Severity — generic for v1.4.15, clinically-keyed in v1.4.16. */
    severity: recommendationSeveritySchema,
    /**
     * v1.4.16 phase B5c — per-recommendation explainability rationale.
     * Required on every rec so the UI's expand-card always has WHY +
     * WINDOW + COMPARED-TO content to render. Legacy payloads (pre-
     * B5c) ride through `findRecommendationsMissingRationale()` for
     * the regenerate-CTA migration; the strict parser rejects them.
     */
    rationale: aiRecommendationRationaleSchema,
    /**
     * Optional pointer into the curated medical-reference bundle
     * (`src/lib/ai/medical-references.ts`). When set, the value MUST
     * be a known id — fabricated ids are rejected.
     *
     * Optional in v1.4.16 (B5a): the prompt asks the model to cite a
     * matching reference for normative claims, but a missing
     * referenceId is logged as a citation-coverage warning rather
     * than a parse failure. v1.4.16 phase B5c flips it to required
     * when `severity >= "important"`.
     */
    referenceId: z.string().optional(),
    /**
     * v1.4.16 phase B5d — deterministic confidence score (0-100).
     *
     * Optional at parse-time:
     *   - The LLM may emit a value (we accept it so the payload round-
     *     trips cleanly), but `generateInsight()` OVERRIDES with the
     *     server-computed `computeConfidence()` post-validation. The
     *     model's number is discarded — calibrated probabilities are
     *     not a small-LLM strength and the deterministic path keeps
     *     the v1.4.17 feedback ratchet reproducible.
     *   - Legacy cached payloads from before B5d landed have no
     *     confidence field; the meter falls back to a "draft" pill.
     *
     * Integer-only and bounded so the meter component can render
     * without clamping; a renegade provider that emits 101 or 67.5
     * fails parse and triggers the wrapper's corrective retry.
     */
    confidence: z.number().int().min(0).max(100).optional(),
  })
  .superRefine((rec, ctx) => {
    if (rec.referenceId !== undefined) {
      if (!MEDICAL_REFERENCE_ID_SET.has(rec.referenceId)) {
        ctx.addIssue({
          code: "custom",
          message: `referenceId "${rec.referenceId}" is not in MEDICAL_REFERENCES`,
          path: ["referenceId"],
        });
      }
    }
  });

export const aiCitationSchema = z.object({
  /** Snapshot key being cited. */
  type: z.string().min(1, "citation.type required"),
  /** Window of the value. */
  timeRange: z.string().min(1, "citation.timeRange required"),
  /** Short description of the data point. */
  summary: z.string().min(1, "citation.summary required"),
});

export const aiWarningSchema = z.object({
  /** Topic — "blood_pressure", "pulse", etc. */
  topic: z.string().min(1, "warning.topic required"),
  /** What's flagged. */
  message: z.string().min(1, "warning.message required"),
  /** Severity tag for downstream filtering. */
  severity: recommendationSeveritySchema.optional(),
});

/**
 * v1.4.20 phase B1 — Daily Briefing block.
 *
 * The Insights redesign hero strip + full-width briefing card render a
 * narrative paragraph synthesised from the day's data plus up to five
 * "key findings" — one-liners that summarise a single trend with a
 * tone (good / watch / info), an optional delta string ("↓ 4 mmHg"),
 * and the metric + window the finding was drawn from.
 *
 * The block is `nullable().optional()` so cached payloads from
 * v1.4.19 (which predate the field) still parse cleanly. Fresh
 * generations after the v1.4.20 PROMPT_VERSION bump emit the block.
 *
 * the maintainer's "zero hallucinations" mandate stays: the prompt instructs the
 * model to derive every finding from a number visible in the snapshot,
 * and `keyFindings.length` is hard-capped at 5 so a runaway model
 * cannot pad the surface with filler.
 */
export const dailyBriefingKeyFindingSchema = z.object({
  /**
   * Tone drives the left-bar colour on the finding row:
   *   - "good"  — Dracula green (target hit, streak, etc.)
   *   - "watch" — Dracula orange (deviation worth noting)
   *   - "info"  — Dracula cyan (neutral observation)
   * Severity stays separate from the recommendation severity ladder
   * so the briefing surface can be lighter-weight than the advisor.
   */
  tone: z.enum(["good", "watch", "info"]),
  /** Headline — the one-liner the user reads first. */
  headline: z.string().min(1, "keyFinding.headline required"),
  /** One-sentence detail expanding on the headline. */
  detail: z.string().min(1, "keyFinding.detail required"),
  /**
   * Optional delta string — e.g. "↓ 4 mmHg" or "+6 bpm". Null when the
   * finding does not naturally carry a single delta (e.g. compliance
   * streak: the "delta" is the streak length itself, captured in the
   * detail).
   */
  delta: z.string().nullable(),
  /** Window the finding was derived from — same enum as elsewhere. */
  sourceWindow: z.enum(["7d", "30d", "90d", "1y"]).default("30d"),
  /**
   * Metric the finding was drawn from.
   *
   * v1.4.23 — extended with the seven Apple Health categories landed in
   * Wave 2 so the daily-briefing surface can cite HRV / sleep / resting
   * HR / steps / active energy / flights / distance findings on iOS-
   * connected accounts. Web-only accounts never see those metrics in
   * the snapshot, so the prompt is told (rule 12) to treat the new
   * tokens as optional.
   */
  sourceMetric: z.enum([
    "bp",
    "weight",
    "pulse",
    "mood",
    "compliance",
    // ── v1.4.23 Apple Health additive ──
    "hrv",
    "sleep",
    "resting_hr",
    "steps",
    "active_energy",
    "flights",
    "distance",
    "vo2_max",
    "body_temp",
    // ── v1.4.25 W4d GLP-1 additive ──
    // Findings emitted by the plateau-detection rule when a user has
    // an active GLP-1 receptor agonist and weight has flattened on a
    // stable dose for ≥21 days. The finding ALWAYS defers to the
    // user's clinician (no dose recommendation); the enum value
    // exists so the UI can pin the right icon + filter.
    "glp1_plateau",
  ]),
});

export type DailyBriefingKeyFinding = z.infer<
  typeof dailyBriefingKeyFindingSchema
>;

export const dailyBriefingSchema = z.object({
  /**
   * Narrative paragraph — ~80-200 words. Synthesised from the day's
   * data, conservative phrasing, no medical advice claims. Empty
   * strings are rejected so the briefing card never paints a void.
   */
  paragraph: z.string().min(1, "dailyBriefing.paragraph required"),
  /**
   * 0-5 key findings. Empty array is acceptable when the data is
   * truly flat; the hero strip simply hides the row in that case.
   */
  keyFindings: z.array(dailyBriefingKeyFindingSchema).min(0).max(5),
});

export type DailyBriefing = z.infer<typeof dailyBriefingSchema>;

/**
 * v1.4.20 phase B3 — optional one-sentence Trend Annotations.
 *
 * The Trends row on `/insights` renders three small charts (BP / weight /
 * mood). Each chart can carry a one-sentence AI-authored annotation
 * directly below it ("Your systolic is trending down — a pattern worth
 * watching"). Each string is hard-capped at 200 chars so a runaway model
 * cannot flood the surface with paragraph-length annotations.
 *
 * Every field is `.optional()` and the wrapping object is
 * `.nullable().optional()` so legacy cached payloads from PROMPT_VERSION
 * 4.20.0 (which predate the field) round-trip without forcing a
 * regenerate. Fresh generations after the 4.20.1 bump emit the block
 * when the snapshot has trend signal.
 */
export const trendAnnotationsSchema = z.object({
  bp: z
    .string()
    .min(1, "trendAnnotations.bp required when emitted")
    .max(200, "trendAnnotations.bp must be <= 200 chars")
    .optional(),
  weight: z
    .string()
    .min(1, "trendAnnotations.weight required when emitted")
    .max(200, "trendAnnotations.weight must be <= 200 chars")
    .optional(),
  mood: z
    .string()
    .min(1, "trendAnnotations.mood required when emitted")
    .max(200, "trendAnnotations.mood must be <= 200 chars")
    .optional(),
  // ── v1.4.23 Apple Health additive ──
  // Each annotation stays one sentence, observational, ≤ 200 chars
  // (mirrors the bp/weight/mood contract). The prompt instructs the
  // model to omit any metric the snapshot doesn't carry.
  hrv: z
    .string()
    .min(1, "trendAnnotations.hrv required when emitted")
    .max(200, "trendAnnotations.hrv must be <= 200 chars")
    .optional(),
  sleep: z
    .string()
    .min(1, "trendAnnotations.sleep required when emitted")
    .max(200, "trendAnnotations.sleep must be <= 200 chars")
    .optional(),
  resting_hr: z
    .string()
    .min(1, "trendAnnotations.resting_hr required when emitted")
    .max(200, "trendAnnotations.resting_hr must be <= 200 chars")
    .optional(),
  steps: z
    .string()
    .min(1, "trendAnnotations.steps required when emitted")
    .max(200, "trendAnnotations.steps must be <= 200 chars")
    .optional(),
  active_energy: z
    .string()
    .min(1, "trendAnnotations.active_energy required when emitted")
    .max(200, "trendAnnotations.active_energy must be <= 200 chars")
    .optional(),
});

export type TrendAnnotations = z.infer<typeof trendAnnotationsSchema>;

/**
 * v1.4.20 phase B4 — Storyboard annotations.
 *
 * The 90-day BP timeline on `/insights` overlays factual events the user
 * logged ("started medication X", "first sustained dip below 140") onto
 * the chart as vertical reference lines + chapter cards beneath. Each
 * annotation MUST cite a real event from the snapshot — the prose is
 * neutral, never causal ("started medication X" not "improvement is due
 * to X").
 *
 * Hard cap of 20 entries so a runaway model cannot blanket the chart
 * with reference lines. The block itself is `.optional()` (no nullable
 * wrap because zod treats an absent field as undefined for arrays
 * uniformly).
 */
export const storyboardAnnotationSchema = z.object({
  /** ISO date the annotation pins to (YYYY-MM-DD). */
  date: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}$/,
      "storyboardAnnotation.date must be YYYY-MM-DD",
    ),
  /** Short label rendered next to the reference line (≤ 80 chars). */
  label: z
    .string()
    .min(1, "storyboardAnnotation.label required")
    .max(80, "storyboardAnnotation.label must be <= 80 chars"),
  /**
   * Category drives the annotation colour:
   *   - "medication" — Dracula pink (started/changed dose)
   *   - "event"      — Dracula cyan (a notable user-logged event)
   *   - "milestone"  — Dracula green (target hit, streak milestone)
   *   - "warning"    — Dracula orange (a deviation worth flagging)
   */
  category: z.enum(["medication", "event", "milestone", "warning"]),
  /** One-paragraph detail that the chapter card surfaces below the chart. */
  detail: z
    .string()
    .min(1, "storyboardAnnotation.detail required")
    .max(400, "storyboardAnnotation.detail must be <= 400 chars"),
});

export const storyboardAnnotationsSchema = z
  .array(storyboardAnnotationSchema)
  .max(20, "storyboardAnnotations can hold at most 20 entries");

/**
 * Canonical strict response schema. New strict fields are required;
 * legacy rich fields ride along through `.passthrough()` for back-
 * compat with cached payloads and the existing dashboard renderer.
 */
export const aiInsightResponseSchema = z
  .object({
    /** 2-3 sentence overall summary in user-facing locale. */
    summary: z.string().min(1, "summary required"),
    /** Structured recommendations with mandatory citations. */
    recommendations: z.array(aiRecommendationSchema),
    /** Citations supporting any claim in summary or recommendations. */
    citations: z.array(aiCitationSchema),
    /** Guideline-flagged values (e.g. BP > 140/90). May be empty. */
    warnings: z.array(aiWarningSchema),
    /**
     * v1.4.20 phase B1 — optional Daily Briefing payload. Nullable +
     * optional so legacy cached payloads (from before PROMPT_VERSION
     * 4.20.0) round-trip without forcing a regenerate.
     */
    dailyBriefing: dailyBriefingSchema.nullable().optional(),
    /**
     * v1.4.20 phase B3 — optional Trend Annotations block. Each metric
     * is independently optional; the wrapping object is nullable so
     * legacy 4.20.0 caches round-trip.
     */
    trendAnnotations: trendAnnotationsSchema.nullable().optional(),
    /**
     * v1.4.20 phase B4 — optional storyboard annotations. Each entry
     * pins a vertical reference line + chapter card to a date on the
     * 90-day BP timeline. Optional so legacy caches round-trip.
     */
    storyboardAnnotations: storyboardAnnotationsSchema.optional(),
  })
  .passthrough();

export type AIInsightResponse = z.infer<typeof aiInsightResponseSchema>;

/**
 * Tagged error thrown by the schema-enforcement wrapper when even the
 * retry attempt fails to produce a valid payload. The route catches
 * this and surfaces a 422 to the client.
 */
export class InsightSchemaError extends Error {
  readonly httpStatus = 422;
  readonly issues: z.ZodIssue[] | null;
  readonly attempts: number;

  constructor(
    message: string,
    options: { issues?: z.ZodIssue[]; attempts: number },
  ) {
    super(message);
    this.name = "InsightSchemaError";
    this.issues = options.issues ?? null;
    this.attempts = options.attempts;
  }
}

/**
 * v1.4.16 phase B5c — legacy-payload detector.
 *
 * The strict schema now requires `rationale` on every recommendation.
 * Cached payloads from v1.4.14/v1.4.15 predate the field — they would
 * fail `aiInsightResponseSchema.safeParse()` outright. Rather than
 * auto-regenerating on every read (expensive + surprising), we let
 * the route call this helper against the legacy-shape JSON so the
 * UI can show a "Insights updated — regenerate for new explainability
 * features" CTA. User-initiated regeneration stays the trigger.
 *
 * Input is intentionally typed loosely (the runtime shape is the
 * canonical AIInsightResponse, but legacy payloads omit `rationale`
 * which the static type now requires). Returns the ids of
 * recommendations missing rationale; an empty array means the
 * payload is well-shaped under B5c.
 */
export function findRecommendationsMissingRationale(
  parsed: AIInsightResponse,
): string[] {
  const missing: string[] = [];
  for (const rec of parsed.recommendations) {
    // Defensive runtime check — the static type asserts rationale is
    // present, but the helper exists precisely for legacy payloads
    // where it isn't.
    const r = (rec as { rationale?: unknown }).rationale;
    if (r === undefined || r === null) {
      missing.push(rec.id);
    }
  }
  return missing;
}

/**
 * Cross-validation beyond zod: every recommendation's `metricSource`
 * must also appear in `citations[]` (same `type` + `timeRange`).
 * Returns the list of missing-citation issues; an empty list means
 * the response is internally consistent.
 */
export function findUncitedRecommendations(parsed: AIInsightResponse): Array<{
  recommendationId: string;
  missing: { type: string; timeRange: string };
}> {
  const cited = new Set(
    parsed.citations.map((c) => `${c.type}::${c.timeRange}`),
  );
  const missing: Array<{
    recommendationId: string;
    missing: { type: string; timeRange: string };
  }> = [];
  for (const rec of parsed.recommendations) {
    const key = `${rec.metricSource.type}::${rec.metricSource.timeRange}`;
    if (!cited.has(key)) {
      missing.push({
        recommendationId: rec.id,
        missing: {
          type: rec.metricSource.type,
          timeRange: rec.metricSource.timeRange,
        },
      });
    }
  }
  return missing;
}
