/**
 * An on-demand briefing generation, from the resolved provider chain to the
 * committed payload. The route owns authentication, the capability gate,
 * the body, the hourly quota and the status of every refusal.
 */
import type { ProviderChainResolved } from "@/lib/ai/provider-runner";
import { assertConsentForChain } from "@/lib/ai/consent-guard";
import { resolveProvider, resolveProviderChain } from "@/lib/ai/provider";
import { recordBriefingFailure } from "@/lib/insights/briefing-failure-marker";
import { annotate } from "@/lib/logging/context";

import { commitBriefing } from "./commit";
import { runFirstCompletion, type BriefingCall } from "./completion";
import type { BriefingRefusal, GenerationContext } from "./context";
import { prepareBriefingFeatures } from "./features";
import { groundBriefing, parseBriefingReply } from "./grounding";
import { buildBriefingPrompt } from "./prompt";

/**
 * The user's full provider chain, so a hard failure on the primary (401,
 * 5xx, network) cascades to the next configured fallback rather than
 * surfacing to the dashboard. An empty chain falls back to the
 * single-provider resolution when the legacy `aiProvider` field still points
 * at something usable, so accounts that never customised the chain keep
 * working. Null when there is no provider at all.
 *
 * The consent gate runs on the resolved chain before anything leaves for a
 * model. Required for the operator's global key (`admin-openai`); BYOK /
 * local / ChatGPT-OAuth chains stay ungated. It throws ConsentRequiredError,
 * which `apiHandler` answers with 403 + `consent.ai.required`.
 */
export async function resolveConsentedBriefingChain(
  userId: string,
): Promise<ProviderChainResolved[] | null> {
  const chain = await resolveProviderChain(userId);
  if (chain.length === 0) {
    const legacy = await resolveProvider(userId);
    if (legacy.type === "none") return null;
    chain.push({ providerType: "admin-openai", instance: legacy });
  }
  await assertConsentForChain({ userId, chain, surface: "insights" });
  return chain;
}

export type GenerateOutcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; refusal: BriefingRefusal };

export async function generateBriefing(args: {
  ctx: GenerationContext;
  chain: ProviderChainResolved[];
  ipAddress: string | null;
}): Promise<GenerateOutcome> {
  const { ctx, chain } = args;
  const prepared = await prepareBriefingFeatures(ctx);
  if (prepared === null) return { ok: false, refusal: "payload-too-large" };

  const prompt = await buildBriefingPrompt(ctx, prepared);
  const call: BriefingCall = { ctx, chain, prompt };

  const first = await runFirstCompletion(call);
  if (!first.ok) return first;

  let insights;
  try {
    insights = parseBriefingReply(first.result.content);
  } catch {
    // A 502 here triggers Cloudflare's HTML error rewrite, which breaks
    // `await res.json()` on the client; the refusal stays a JSON 422 so the
    // React Query mutation can read the body and surface a readable message.
    void recordBriefingFailure({
      userId: ctx.userId,
      reason: "invalid-json",
      locale: ctx.locale,
    });
    // Truncation-aware (#470): `finishReason === "length"` means the model
    // hit the output-token ceiling and the JSON was cut off mid-string, which
    // is a budget problem, not a model-quality one.
    if (first.result.finishReason === "length") {
      annotate({ meta: { insights_response_truncated: true } });
      return { ok: false, refusal: "response-truncated" };
    }
    return { ok: false, refusal: "response-invalid-json" };
  }

  const reply = await groundBriefing(call, prepared, {
    insights,
    result: first.result,
    workingProviderType: first.workingProviderType,
  });

  return commitBriefing(call, prepared, reply, {
    ipAddress: args.ipAddress,
    fallbackHopCount: first.fallbackHopCount,
  });
}
