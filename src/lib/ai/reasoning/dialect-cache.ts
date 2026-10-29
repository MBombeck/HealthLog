/**
 * v1.41 — what an endpoint answered when it was asked to reason, learned at
 * runtime and kept for an hour (`DIALECT_TTL_MS`), a reasoning field a 400
 * refused for a day (`FIELD_REFUSED_TTL_MS`), so an endpoint that gains the
 * parameter, or a downgrade learned from a misread error, heals without a
 * restart.
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

/**
 * #1267 — the learned value for an endpoint and model that answered a
 * reasoning request with reasoning alone (Ollama's Gemma 4 on
 * `/v1/chat/completions`): ask them with `reasoning_effort: "none"`. Shared by
 * the Local and the OpenAI-compatible gateway clients. Distinct from
 * `"none"`, which both clients read as "send no reasoning field at all".
 */
export const ANSWERS_ONLY_UNREASONED = "off";

/**
 * #1279 — the learned value for an endpoint and model that answered with
 * reasoning alone even when asked with `none`: gpt-oss behind vLLM accepts
 * only low / medium / high and ignores it, and a GLM chat template reads an
 * effort it does not know as its maximum. Asking such a model with `none` is
 * a wasted call, or a longer thought. Both clients send what the call asks
 * for (with the thinking room) and never repeat an answerless reply while
 * this holds.
 */
export const REASONS_REGARDLESS = "unswitchable";

/**
 * #1279 — the learned value for an endpoint that refuses the reasoning field
 * outright (LiteLLM in front of Ollama: "does not support parameters:
 * ['reasoning_effort']") in front of a model that reasons unasked. Both facts
 * at once: no field is sent, as with `"none"`, and the thinking room stays
 * and an answerless reply is final, as with `REASONS_REGARDLESS`. Held as one
 * value each, the two lessons overwrote each other on every request.
 */
export const FIELD_REFUSED_REASONS_REGARDLESS = "none-unswitchable";

/** True when `learned` says the endpoint refuses the reasoning field. */
export function refusesReasoningField(learned: string | undefined): boolean {
  return learned === "none" || learned === FIELD_REFUSED_REASONS_REGARDLESS;
}

/** How long a learned downgrade holds before the full request is tried again. */
export const DIALECT_TTL_MS = 60 * 60 * 1000;

/**
 * #1279 — how long a reasoning field refused by a 400 holds
 * (`refusesReasoningField`). A gateway that refuses the field does so by its
 * configuration (LiteLLM without `drop_params`), which changes when its
 * operator changes it, not between two calls, and only a 400 naming the
 * field with refusal wording can teach it. At the hour every expiry cost one
 * refused request, a few a day on a gateway that runs the briefings
 * unattended. A day bounds that to one per day, and a gateway that gains the
 * field still gets it the next day. A lesson read from a single reply keeps
 * the hour.
 */
export const FIELD_REFUSED_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Pinned on `globalThis`: a module imported from more than one bundler layer
 * is instantiated once per layer (see `caches` in `server-cache.ts`), so the
 * Coach's route handlers and the worker's jobs each kept a copy and paid for
 * the same lesson separately. One map per process.
 */
const LEARNED_SLOT = Symbol.for("healthlog.ai.reasoningDialects");
const learned: Map<string, { value: string; expiresAt: number }> = ((
  globalThis as Record<symbol, unknown>
)[LEARNED_SLOT] ??= new Map()) as Map<
  string,
  { value: string; expiresAt: number }
>;

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

/**
 * What taught a lesson: a 400 that refused a parameter the client sent, or a
 * single reply (one that came back without an answer).
 */
export type ReasoningLessonSource = "refusal" | "reply";

/**
 * Record what `key` accepts, by default after a 400 refused a richer request;
 * a lesson read from a reply says so (`"reply"`). A reasoning field a 400
 * refused holds for `FIELD_REFUSED_TTL_MS`, every other lesson for
 * `DIALECT_TTL_MS`.
 *
 * `FIELD_REFUSED_REASONS_REGARDLESS` carries two facts, and a reply only ever
 * adds the second ("reasons regardless") to a field refusal a 400 taught
 * earlier. That upgrade keeps the refusal's remaining lifetime: a fresh day
 * would let one reply extend what the 400 taught, and the hour would bring
 * the refused request back after it. The "regardless" half rides along and
 * is learned again from the next answerless reply if it lapses.
 */
export function rememberReasoningDialect(
  key: ReasoningDialectKey,
  value: string,
  source: ReasoningLessonSource = "refusal",
): void {
  const k = cacheKey(key);
  const now = Date.now();
  let expiresAt = now + DIALECT_TTL_MS;
  if (refusesReasoningField(value)) {
    const before = learned.get(k);
    if (source === "refusal") {
      expiresAt = now + FIELD_REFUSED_TTL_MS;
    } else if (
      before &&
      before.expiresAt > now &&
      refusesReasoningField(before.value)
    ) {
      expiresAt = before.expiresAt;
    }
  }
  learned.set(k, { value, expiresAt });
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

/**
 * #1276 — endpoints and models seen reasoning: a reasoning field or a think
 * tag in a reply. `unasked` when the request carried no effort (or `none`),
 * and it outlasts a later sighting on a request that asked. Held as long as a
 * lesson (`DIALECT_TTL_MS`) and on `globalThis` for the same reason.
 */
const SEEN_SLOT = Symbol.for("healthlog.ai.reasoningSeen");
const seen: Map<string, { unasked: boolean; expiresAt: number }> = ((
  globalThis as Record<symbol, unknown>
)[SEEN_SLOT] ??= new Map()) as Map<
  string,
  { unasked: boolean; expiresAt: number }
>;

function seenEntry(k: string) {
  const entry = seen.get(k);
  if (entry && Date.now() >= entry.expiresAt) {
    seen.delete(k);
    return undefined;
  }
  return entry;
}

/** Record a reply of `key` that reasoned; `asked`: its request asked to. */
export function noteReasoningSeen(
  key: ReasoningDialectKey,
  asked: boolean,
): void {
  const k = cacheKey(key);
  seen.set(k, {
    unasked: !asked || (seenEntry(k)?.unasked ?? false),
    expiresAt: Date.now() + DIALECT_TTL_MS,
  });
}

/**
 * True when `key` was seen reasoning in a way that speaks for a request that
 * did (`asked`) or did not ask to reason: a model that reasoned unasked
 * speaks for both, one seen reasoning only when asked for the first.
 */
export function reasoningSeen(
  key: ReasoningDialectKey,
  asked: boolean,
): boolean {
  const entry = seenEntry(cacheKey(key));
  return entry !== undefined && (entry.unasked || asked);
}

/** Test hook: forget everything learned. */
export function resetReasoningDialectCache(): void {
  learned.clear();
  seen.clear();
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
