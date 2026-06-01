import { resolveProvider, resolveProviderChain } from "@/lib/ai/provider";
import {
  AllProvidersFailedError,
  runRawCompletionWithFallback,
  type ProviderChainResolved,
} from "@/lib/ai/provider-runner";
import { annotate } from "@/lib/logging/context";
import { STATUS_PROVIDER_TIMEOUT_MS, withTimeout } from "./with-timeout";

/**
 * Shared provider plumbing for the seven `*-status.ts` generators.
 *
 * Before this, each generator resolved a single provider via
 * `resolveProvider()` and raced one `generateCompletion()` call against
 * a 20 s cap. A degraded primary provider could not cascade, and the
 * cap fired below the providers' own 60 s floor — converting healthy-
 * but-slow generations into the generic fallback.
 *
 * This helper mirrors the Coach (`chat/route.ts`): resolve the user's
 * provider chain, fall back to the legacy single provider when the chain
 * is empty, and run `runRawCompletionWithFallback` so a degraded provider
 * cascades to the next. The whole thing is still wrapped in
 * `withTimeout` at the aligned 60 s budget so a total stall can't pin the
 * card — but a timeout / error is reported as a transient miss (the
 * caller serves the fallback for this render without persisting it),
 * never as the day's cached assessment.
 */

export type StatusProviderResult =
  | { kind: "none" }
  | { kind: "timeout" }
  | { kind: "error" }
  | {
      kind: "ok";
      content: string;
      providerType: string;
      model: string;
      tokensUsed: number | null;
    };

interface RunStatusCompletionArgs {
  userId: string;
  cacheAction: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Resolve the provider chain for `userId`, falling back to the legacy
 * single provider. Returns `null` when the user has no usable provider
 * anywhere (the caller surfaces the no-key fallback with
 * `hasProvider:false`).
 */
async function resolveStatusChain(
  userId: string,
): Promise<ProviderChainResolved[] | null> {
  const chain = await resolveProviderChain(userId);
  if (chain.length > 0) return chain;

  const legacy = await resolveProvider(userId);
  if (legacy.type === "none") return null;
  return [{ providerType: "admin-openai", instance: legacy }];
}

/**
 * Cheap provider-availability probe for the read-only status path.
 *
 * v1.8.3 — when a status route runs in read-only mode (serve cache, never
 * block on the LLM) it still has to tell the difference between "no
 * provider — show the no-key fallback" and "provider configured but the
 * assessment isn't warm yet — show preparing + enqueue a generation". This
 * resolves the same chain `runStatusCompletion` would, but does NOT run a
 * completion, so the navigation request never awaits an LLM round-trip.
 */
export async function hasUsableStatusProvider(
  userId: string,
): Promise<boolean> {
  return (await resolveStatusChain(userId)) !== null;
}

/**
 * Run a status generation across the user's provider chain, bounded by
 * `STATUS_PROVIDER_TIMEOUT_MS`. The result discriminates between
 * no-provider / timeout / provider-error / success so the caller can
 * decide what to persist — only `ok` is ever cached as the day's
 * assessment.
 */
export async function runStatusCompletion(
  args: RunStatusCompletionArgs,
): Promise<StatusProviderResult> {
  const { userId, cacheAction, systemPrompt, userPrompt } = args;

  const chain = await resolveStatusChain(userId);
  if (chain === null) {
    return { kind: "none" };
  }

  const raced = await withTimeout(
    () =>
      runRawCompletionWithFallback({
        userId,
        providers: chain,
        params: {
          systemPrompt,
          userPrompt,
          temperature: args.temperature ?? 0.3,
          maxTokens: args.maxTokens ?? 1000,
        },
      }),
    STATUS_PROVIDER_TIMEOUT_MS,
    null,
  );

  if (raced.timedOut) {
    return { kind: "timeout" };
  }
  if (raced.errored || raced.value === null) {
    return { kind: "error" };
  }

  const { result, workingProvider } = raced.value;
  const content = result.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    annotate({
      action: { name: "insights.status.empty_content" },
      meta: { cacheAction, providerType: workingProvider.providerType },
    });
    return { kind: "error" };
  }

  return {
    kind: "ok",
    content,
    providerType: workingProvider.providerType,
    model: result.model ?? "unknown",
    tokensUsed: result.tokensUsed ?? null,
  };
}

export { AllProvidersFailedError };
