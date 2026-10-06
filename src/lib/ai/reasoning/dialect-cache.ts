/**
 * v1.41 — what an endpoint answered when it was asked to reason, learned at
 * runtime and kept for the life of the process.
 *
 * Every client that sends reasoning parameters to a wire it does not control
 * (a gateway, a local server, a model name the client has never seen, a Codex
 * slug whose accepted efforts moved) asks this cache first. When the endpoint
 * rejects a parameter the client retries once with the lesser request and
 * records the lesser request here, so the next call does not pay the rejected
 * round-trip again. A successful call never has to be recorded: the default
 * is "send what was asked".
 *
 * Keyed by provider, endpoint and model, because the same gateway can serve a
 * model that reasons and one that does not, and the same model name can sit
 * behind two endpoints with different parameter rules. The values are short
 * strings each client defines for itself; nothing outside the client reads
 * them.
 *
 * Pattern borrowed from `../json-dialect.ts`, which learns the JSON-mode flag
 * the same way. Server-only: the provider clients are its only importers.
 */
import { annotate } from "@/lib/logging/context";

export interface ReasoningDialectKey {
  /** The client that learned it (`codex`, `anthropic`, `openai`, `local`). */
  provider: string;
  /** Base URL or endpoint constant. */
  endpoint: string;
  model: string;
}

const learned = new Map<string, string>();

function cacheKey(key: ReasoningDialectKey): string {
  return `${key.provider}\u0000${key.endpoint}\u0000${key.model}`;
}

/** The learned dialect value for `key`, or `undefined` when nothing was learned. */
export function learnedReasoningDialect(
  key: ReasoningDialectKey,
): string | undefined {
  return learned.get(cacheKey(key));
}

/** Record what `key` accepts after it refused a richer request. */
export function rememberReasoningDialect(
  key: ReasoningDialectKey,
  value: string,
): void {
  learned.set(cacheKey(key), value);
}

/** Test hook: forget everything learned. */
export function resetReasoningDialectCache(): void {
  learned.clear();
}

/**
 * Mark the request's wide event with a reasoning downgrade. Meta keys only,
 * never an action: the route or job owns the action name dashboards pin on.
 * The values are our own vocabulary (provider tag, wire effort), never model
 * or upstream text.
 */
export function annotateReasoningDowngrade(
  provider: string,
  from: string,
  to: string,
): void {
  annotate({
    meta: {
      ai_reasoning_downgraded: true,
      ai_reasoning_downgraded_provider: provider,
      ai_reasoning_downgraded_from: from,
      ai_reasoning_downgraded_to: to,
    },
  });
}
