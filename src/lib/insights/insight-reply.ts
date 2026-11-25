/**
 * The one parser for a briefing-generation reply, shared by the on-demand
 * generation (`briefing-request/`) and the background one
 * (`comprehensive-steps.ts`), first passes and corrective retries alike.
 *
 * It parses the JSON, keeps the top level as `insightResultSchema` reads it
 * (a reply that does not match is kept as parsed, so the richer optional
 * blocks survive), and runs the commit gate `gateBriefingBlocks` on the
 * blocks the card renders. A reply this returns `ok` is one whose briefing
 * the card can show; anything else is a failed generation and is recorded
 * as one, never stored as a success.
 */
import { gateBriefingBlocks } from "@/lib/ai/briefing-blocks";
import { extractJsonObject } from "@/lib/ai/json-extract";
import { insightResultSchema, type InsightResult } from "@/lib/ai/types";

export type ParsedInsight = InsightResult | Record<string, unknown>;

/** A parsed reply, or why it may not be stored. */
export type ParsedReply =
  | { ok: true; insights: ParsedInsight; repairs: string[] }
  | {
      ok: false;
      reason: "invalid-json" | "invalid-briefing";
      issues: string[];
    };

/**
 * `invalid-json` when the reply is not a JSON object even after the fence is
 * stripped, `invalid-briefing` when its briefing cannot be rendered (or is
 * missing although `briefingRequired`).
 */
export function parseInsightReply(
  content: string,
  options: { briefingRequired: boolean },
): ParsedReply {
  let parsed: unknown;
  try {
    // Anthropic + local have no native JSON mode, so a ```json-fenced or
    // sentence-prefixed reply is unwrapped first; clean JSON passes through.
    parsed = JSON.parse(extractJsonObject(content));
  } catch {
    return { ok: false, reason: "invalid-json", issues: [] };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "invalid-json", issues: [] };
  }
  const validated = insightResultSchema.safeParse(parsed);
  const insights: ParsedInsight = validated.success
    ? validated.data
    : (parsed as Record<string, unknown>);
  const gated = gateBriefingBlocks(insights, options);
  return gated.ok
    ? { ok: true, insights: gated.insights, repairs: gated.repairs }
    : { ok: false, reason: "invalid-briefing", issues: gated.issues };
}
