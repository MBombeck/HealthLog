/**
 * The document-class provider preference, on its own so the capability
 * resolver can read it without the provider resolution around it.
 *
 * `provider-order.ts` sorts a resolved chain by it before a document read picks
 * a provider; the AI capability resolver sorts a presence-only chain by it to
 * know whether that pick would leave the machine. One rank, two readers, so
 * the answer published to a client and the provider a route picks cannot
 * disagree about which entry comes first.
 */

/**
 * Preference rank for a provider when the payload is a DOCUMENT. Lower wins.
 * Local keeps the document on the machine (rank 0); BYOK no-train API keys are
 * next (rank 1, including the user's own OpenAI-compatible gateway); the
 * operator's shared no-train key follows (rank 2); the
 * ChatGPT-subscription OAuth paths are LAST (rank 3) — the user's own `codex`
 * AND the operator's shared `admin-codex`, both train on consumer content by
 * default and cannot be verified opted-out from here.
 *
 * `antigravity` (v1.48.0) is also rank 3 — it sends documents to an external
 * Antigravity/Google service with potential training/interactions according
 * to its terms of service.
 */
export function documentProviderRank(providerType: string): number {
  switch (providerType) {
    case "local":
      return 0;
    case "openai":
    case "anthropic":
    case "admin-key":
    // The user's own gateway (LiteLLM / OpenRouter / vLLM) is a BYO endpoint
    // under their own contract. It may well be on their own network, but
    // HealthLog cannot tell that from the URL, so it ranks with the BYO API
    // keys rather than with `local` — the conservative side.
    case "openai-compatible":
      return 1;
    case "admin-openai":
      return 2;
    case "codex":
    case "admin-codex":
    case "antigravity":
      return 3;
    default:
      return 2;
  }
}
