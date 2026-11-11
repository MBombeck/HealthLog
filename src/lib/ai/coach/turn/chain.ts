/**
 * Resolve the provider chain a Coach turn will run on, gate it on consent,
 * and decide between tool retrieval and the legacy snapshot path.
 */
import { annotate } from "@/lib/logging/context";
import { resolveProviderChain } from "@/lib/ai/provider";
import { assertConsentForChain } from "@/lib/ai/consent-guard";

import { streamProviderError } from "./sse";

export type TurnChain = Awaited<ReturnType<typeof resolveProviderChain>>;

export async function resolveTurnChain(
  userId: string,
): Promise<
  | { ok: true; chain: TurnChain; toolMode: boolean }
  | { ok: false; response: Response }
> {
  // v1.20.0 — provider capabilities select tool retrieval or the legacy
  // snapshot-stuffing path.
  const chain = await resolveProviderChain(userId);
  if (chain.length === 0) {
    annotate({
      action: { name: "insights.coach.noProvider" },
    });
    return {
      ok: false,
      response: streamProviderError({
        code: "coach.provider.none",
        reason: "no_provider",
      }),
    };
  }

  // v1.12.1 — consent gate before any server-managed external egress. When
  // the chain could egress via the operator's global key, require an active
  // `ai_coach` (or master `ai_full`) receipt. BYOK / local / ChatGPT-OAuth
  // chains are the user's own egress and stay ungated. Throws
  // ConsentRequiredError → apiHandler returns 403 + `consent.ai.required`.
  await assertConsentForChain({ userId, chain, surface: "coach" });

  // v1.20.0 — tool mode is on only when EVERY provider in the chain
  // supports tool-calling, so whichever hop the fallback runner lands on can
  // still serve tools. A chain that includes a no-tools provider (local /
  // Ollama) falls back to the legacy snapshot-stuffing path verbatim, exactly
  // as before — the snapshot builder stays alive as the no-tools floor.
  const toolMode = chain.every((c) => c.instance.supportsTools !== false);

  return { ok: true, chain, toolMode };
}
