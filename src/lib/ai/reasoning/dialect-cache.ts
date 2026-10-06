/**
 * v1.41 — what an endpoint answered when it was asked to reason, learned at
 * runtime and kept for an hour (`DIALECT_TTL_MS`), so an endpoint that
 * gains the parameter, or a downgrade learned from a misread error, heals
 * without a restart.
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
 * Only an HTTP 400 that refuses one of the parameters the client sent may
 * teach anything (`isReasoningParameterRejection`): never an auth, rate-limit
 * or server error, never a body that merely mentions a model whose name
 * contains "reasoner" or "thinking", and never a replay error about the
 * reasoning state handed back from an earlier round, which says nothing
 * about what the endpoint accepts.
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

/** How long a learned downgrade holds before the full request is tried again. */
export const DIALECT_TTL_MS = 60 * 60 * 1000;

const learned = new Map<string, { value: string; expiresAt: number }>();

function cacheKey(key: ReasoningDialectKey): string {
  return `${key.provider}\u0000${key.endpoint}\u0000${key.model}`;
}

/** The learned dialect value for `key`, or `undefined` when nothing was learned. */
export function learnedReasoningDialect(
  key: ReasoningDialectKey,
): string | undefined {
  const k = cacheKey(key);
  const entry = learned.get(k);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    learned.delete(k);
    return undefined;
  }
  return entry.value;
}

/** Record what `key` accepts after it refused a richer request. */
export function rememberReasoningDialect(
  key: ReasoningDialectKey,
  value: string,
): void {
  learned.set(cacheKey(key), { value, expiresAt: Date.now() + DIALECT_TTL_MS });
}

/**
 * Errors about the reasoning state an earlier round handed back (a thinking
 * block missing or altered, an encrypted reasoning item the server cannot
 * read or no longer has). They name the reasoning vocabulary but say nothing
 * about the parameters the endpoint accepts.
 */
const REPLAY_ERROR =
  /thinking block|redacted_thinking|signature|encrypted[_ ]content|item with id|of type 'reasoning'|required following item|previous_response|not persisted/i;

/** Wording an endpoint uses when it refuses a parameter or one of its values. */
const PARAMETER_REFUSAL =
  /unsupported|not supported|does not support|doesn't support|unrecognized|unrecognised|unknown (?:parameter|field|argument|key)|extra (?:inputs|fields|arguments)|not permitted|not allowed|invalid value|does not match any of the expected|does not accept|not accepted|cannot be used|unexpected (?:keyword|field|parameter|argument)/i;

/**
 * True when `status` and `body` say the endpoint refused a reasoning (or
 * sampling) parameter the client sent: an HTTP 400 whose body names one of
 * `params` together with refusal wording, and which is not a replay error.
 * The model name is cut out of the body first, so a model called
 * `deepseek-reasoner` or `qwen3-thinking` cannot supply the parameter match.
 */
export function isReasoningParameterRejection(
  status: number,
  body: string,
  params: RegExp,
  model: string,
): boolean {
  if (status !== 400 || !body) return false;
  // Only a model name that could itself supply the match is cut; a short
  // name ("m", "o3") must not take letters out of the wording.
  const text = model && params.test(model) ? body.split(model).join(" ") : body;
  if (REPLAY_ERROR.test(text)) return false;
  return params.test(text) && PARAMETER_REFUSAL.test(text);
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
