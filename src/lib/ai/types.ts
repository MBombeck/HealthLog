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

export const insightResultSchema = z.object({
  insightType: z.string().optional(),
  summary: z.string(),
  classification: z.enum(["optimal", "gut", "grenzwertig", "erhoht", "kritisch"]),
  classificationLabel: z.string().optional(),
  findings: z.array(insightFindingSchema),
  correlations: z.array(insightCorrelationSchema),
  primaryRecommendation: z.string().optional(),
  recommendations: z.array(z.string()),
  dataQuality: insightDataQualitySchema,
  disclaimer: z.string(),
});

export type InsightResult = z.infer<typeof insightResultSchema>;
export type InsightFinding = z.infer<typeof insightFindingSchema>;

// ─── Provider Types ────────────────────────────────────────

export type ProviderType = "codex" | "admin-key" | "anthropic" | "local" | "none";

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
