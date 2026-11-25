/**
 * The daily-briefing number-grounding gate. The reply's parse and its
 * commit gate live in `insight-reply.ts`, shared with the background path.
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
import {
  briefingRequiredFor,
  previousRenderableBriefing,
} from "@/lib/ai/briefing-blocks";
import type { RunRawWithFallbackResult } from "@/lib/ai/provider-runner";
import {
  parseInsightReply,
  type ParsedInsight,
} from "@/lib/insights/insight-reply";
import { annotate } from "@/lib/logging/context";

import { runBriefingCall, type BriefingCall } from "./completion";
import type { PreparedFeatures } from "./features";

export type BriefingInsights = ParsedInsight;

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
      // The corrected reply passes the same commit gate as the first one; a
      // reply the card could not render keeps the briefing withheld.
      const retryParsed = parseInsightReply(retry.result.content, {
        briefingRequired: briefingRequiredFor(signals),
      });
      if (retryParsed.ok) {
        ungrounded = findUngroundedBriefingNumbers(
          readBriefingBlock(retryParsed.insights),
          signals,
          features,
          comparisonSnapshot,
        );
      }
      if (retryParsed.ok && ungrounded.length === 0) {
        insights = retryParsed.insights;
        result = retry.result;
        workingProviderType = retry.workingProvider.providerType;
      }
    } catch {
      // The day's ceiling refused the correction pass, or the provider
      // failed it; either way fall through to the strip. An ungrounded
      // figure is never persisted.
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
    // Only a previous briefing that renders may stand in.
    const fallbackBriefing = previousRenderableBriefing(call.ctx.cachedText);
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
