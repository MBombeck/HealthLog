import { z } from "zod/v4";

// ─── Insight Result Schema ─────────────────────────────────

export const insightFindingSchema = z.object({
  label: z.string(),
  value: z.string(),
  assessment: z.enum(["positive", "neutral", "attention", "warning"]),
  guideline: z.string().optional(),
});

export const insightCorrelationSchema = z.object({
  factor: z.string(),
  effect: z.string(),
  confidence: z.enum(["hoch", "mittel", "gering"]),
});

export const insightDataQualitySchema = z.object({
  coverage: z.string(),
  gaps: z.array(z.string()),
  confidence: z.enum(["hoch", "mittel", "gering"]),
});

/**
 * v1.4.16 phase B5c — rationale shape mirrors the strict
 * `aiRecommendationRationaleSchema`. dataWindow values match
 * `mini-window.ts` so the rec card's mini-chart can pin to the right
 * window without an extra mapping table.
 */
export const insightRecommendationRationaleSchema = z.object({
  dataWindow: z.enum(["last7days", "last30days", "last90days", "allTime"]),
  comparedTo: z.string(),
  deviation: z.string(),
});

export type InsightRecommendationRationale = z.infer<
  typeof insightRecommendationRationaleSchema
>;

/**
 * v1.4.16 — recommendations can be either the legacy plain-string
 * shape OR a structured object carrying an optional medical-reference
 * citation. The card renders a footnote with a labelled link when
 * `referenceId` is set and resolves to a known entry in
 * `MEDICAL_REFERENCES`.
 *
 * v1.4.16 phase B5c — adds `rationale` (Oura-style "Contributors")
 * and `metricSource` so the rec card can render the expand-out
 * explainability panel + a mini-chart pinned to the rec's window.
 * Both fields are optional on the UI type because legacy cached
 * payloads predate them; the server-side `aiRecommendationSchema`
 * enforces presence on fresh generations.
 */
export const insightRecommendationSchema = z.union([
  z.string(),
  z.object({
    text: z.string(),
    referenceId: z.string().optional(),
    rationale: insightRecommendationRationaleSchema.optional(),
    metricSource: z
      .object({
        type: z.string(),
        timeRange: z.string(),
        summary: z.string(),
        n: z.number().optional(),
      })
      .optional(),
    severity: z.enum(["info", "suggestion", "important", "urgent"]).optional(),
    id: z.string().optional(),
    /**
     * v1.4.16 phase B5d — deterministic confidence score (0-100).
     * Optional on the UI type because legacy cached payloads predate
     * the field; `<ConfidenceMeter>` renders a "draft" pill in that
     * case. Server-side `aiRecommendationSchema` mirrors this shape.
     */
    confidence: z.number().int().min(0).max(100).optional(),
  }),
]);

export type InsightRecommendation = z.infer<typeof insightRecommendationSchema>;

export const insightResultSchema = z.object({
  insightType: z.string().optional(),
  summary: z.string(),
  classification: z.enum([
    "optimal",
    "gut",
    "grenzwertig",
    "erhoht",
    "kritisch",
  ]),
  classificationLabel: z.string().optional(),
  findings: z.array(insightFindingSchema),
  correlations: z.array(insightCorrelationSchema),
  primaryRecommendation: z.string().optional(),
  recommendations: z.array(insightRecommendationSchema),
  dataQuality: insightDataQualitySchema,
  disclaimer: z.string(),
});

export type InsightResult = z.infer<typeof insightResultSchema>;

// ─── Provider Types ────────────────────────────────────────

export type ProviderType =
  | "codex"
  | "admin-key"
  | "anthropic"
  | "local"
  | "none";

export interface AIProvider {
  type: ProviderType;
  generateCompletion(params: CompletionParams): Promise<CompletionResult>;
}

export interface CompletionParams {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
}

export interface CompletionResult {
  content: string;
  tokensUsed: number | null;
  model: string;
  providerType: ProviderType;
}
