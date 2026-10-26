/**
 * The reply's parse and the daily-briefing number-grounding gate.
 *
 * The schema only checks the briefing's SHAPE; the gate asserts every
 * number the briefing prose restates traces to a `features.signalsOfDay`
 * figure, mirroring the recommendations citation cross-check. On a miss: one
 * corrective retry, then the briefing block is dropped rather than shipping
 * a fabricated number.
 */
import {
  buildBriefingGroundingCorrection,
  findUngroundedBriefingNumbers,
  readBriefingBlock,
} from "@/lib/ai/briefing-grounding";
import type { RunRawWithFallbackResult } from "@/lib/ai/provider-runner";
import { insightResultSchema, type InsightResult } from "@/lib/ai/types";
import { annotate } from "@/lib/logging/context";

import { runBriefingCall, type BriefingCall } from "./completion";
import type { PreparedFeatures } from "./features";

export type BriefingInsights = InsightResult | Record<string, unknown>;

/** The parsed reply: the strict shape when it validates, the raw object if not. */
export function parseBriefingReply(content: string): BriefingInsights {
  const parsed = JSON.parse(content);
  // Try the strict schema first, fall back to the raw parsed object.
  const validated = insightResultSchema.safeParse(parsed);
  return validated.success ? validated.data : parsed;
}

export interface GroundedReply {
  insights: BriefingInsights;
  result: RunRawWithFallbackResult["result"];
  workingProviderType: string;
  /**
   * Non-null when the gate stripped the briefing from THIS generation and no
   * previous one could stand in, so the card can explain the hole instead
   * of reading "no briefing yet" (#470).
   */
  briefingOmittedReason: "ungrounded" | null;
}

/** The previous cached briefing, when the payload parses and carries one. */
function previousBriefing(cachedText: string | null): unknown {
  if (!cachedText) return null;
  try {
    const prev = JSON.parse(cachedText) as Record<string, unknown>;
    return prev.dailyBriefing ?? null;
  } catch {
    // Unparseable previous payload — nothing safe to stand in.
    return null;
  }
}

export async function groundBriefing(
  call: BriefingCall,
  prepared: PreparedFeatures,
  reply: Omit<GroundedReply, "briefingOmittedReason">,
): Promise<GroundedReply> {
  const { features } = prepared;
  const { comparisonSnapshot } = call.prompt;
  let { insights, result, workingProviderType } = reply;
  let briefingOmittedReason: "ungrounded" | null = null;
  const signals = features.signalsOfDay ?? null;
  let ungrounded = findUngroundedBriefingNumbers(
    readBriefingBlock(insights),
    signals,
    features,
    comparisonSnapshot,
  );
  if (ungrounded.length > 0) {
    annotate({
      action: { name: "insights.generate.briefing_grounding_retry" },
      meta: { ungroundedCount: ungrounded.length },
    });
    try {
      const retry = await runBriefingCall(call, {
        userPrompt: `${call.prompt.userPrompt}\n\n${buildBriefingGroundingCorrection(ungrounded)}`,
        stage: "grounding-retry",
        reasoning: false,
      });
      const retryInsights = parseBriefingReply(retry.result.content);
      ungrounded = findUngroundedBriefingNumbers(
        readBriefingBlock(retryInsights),
        signals,
        features,
        comparisonSnapshot,
      );
      if (ungrounded.length === 0) {
        insights = retryInsights;
        result = retry.result;
        workingProviderType = retry.workingProvider.providerType;
      }
    } catch {
      // Retry failed to produce parseable JSON, or the day's ceiling refused
      // the correction pass — either way fall through to the strip. An
      // ungrounded figure is never persisted.
    }
  }
  // Still ungrounded after the retry: the freshly generated briefing is
  // discarded rather than shipped — the anti-fabrication guarantee is
  // absolute here too. But rather than leave a hole, the PREVIOUS cached
  // briefing stands in its place: it passed this identical gate when it was
  // written, so it carries no fabricated figure, and a day-old grounded
  // briefing beats a vanished one. This mirrors the background generator,
  // which is the path that writes the same cached payload; the two must not
  // disagree on disposal.
  //
  // `briefingOmittedReason` is set ONLY when no previous briefing exists to
  // stand in, so the card's honest "a figure couldn't be verified" state
  // still fires exactly when the user really has no briefing.
  if (ungrounded.length > 0 && insights && typeof insights === "object") {
    const fallbackBriefing = previousBriefing(call.ctx.cachedText);
    (insights as Record<string, unknown>).dailyBriefing = fallbackBriefing;
    briefingOmittedReason = fallbackBriefing == null ? "ungrounded" : null;
    annotate({
      action: { name: "insights.generate.briefing_grounding_stripped" },
      meta: {
        ungroundedCount: ungrounded.length,
        briefing_fallback:
          fallbackBriefing != null ? "previous-cached" : "stripped",
      },
    });
  }
  return { insights, result, workingProviderType, briefingOmittedReason };
}
