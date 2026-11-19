import { emitSignal } from "@/lib/logging/signal";
import type { CompletionParams, StandardReasoning } from "@/lib/ai/types";
import type {
  ChainWalkArgs,
  ProviderChainResolved,
} from "@/lib/ai/provider-runner";
import { resolveEffectivePolicyCap } from "@/lib/ai/reasoning/controls";
import { stricterReasoningLevel } from "@/lib/ai/reasoning/levels";

export async function normalizeCandidateParams(
  candidate: ProviderChainResolved,
  params: CompletionParams,
  args: ChainWalkArgs,
): Promise<CompletionParams> {
  if (candidate.providerType !== "antigravity") {
    // Preserve non-agy wire: if deliberate off was passed on background jobs,
    // or if reasoning was omitted on the original request, strip reasoning.
    if (
      !args.params.reasoning ||
      (args.surface === "job" && params.reasoning?.effort === "off")
    ) {
      return { ...params, reasoning: undefined };
    }
    return params;
  }

  // Candidate is Antigravity:
  // Always resolve the administrative/record policy cap on every call.
  // Take the strictest of caller's maxEffort and the policy cap.
  const policyCap = await resolveEffectivePolicyCap(
    args.userId,
    args.surface,
  ).catch(() => {
    emitSignal({
      action: "ai.reasoning.policy_cap_read_failed",
      level: "warn",
      meta: { surface: args.surface },
    });
    return "off" as const;
  });
  const effectiveCap =
    stricterReasoningLevel(params.reasoning?.maxEffort, policyCap) ?? undefined;
  const effort = params.reasoning?.effort;

  return {
    ...params,
    reasoning: {
      ...params.reasoning,
      ...(effort !== undefined ? { effort } : {}),
      summaries: params.reasoning?.summaries ?? false,
      maxEffort: effectiveCap,
      ...(params.reasoning?.explicit !== undefined
        ? { explicit: params.reasoning.explicit }
        : {}),
    } as StandardReasoning,
  };
}
