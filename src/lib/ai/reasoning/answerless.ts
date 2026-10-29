/**
 * #1279 — what the Local and the OpenAI-compatible gateway clients do with a
 * reply that reached the model and came back without an answer.
 *
 * A reply with reasoning and no answer is asked once more with
 * `reasoning_effort: "none"` (#1267): Ollama serves Gemma 4 that way, and the
 * repeat answers. The lesson holds for the hour (`ANSWERS_ONLY_UNREASONED`).
 *
 * When the repeat, or any later call sent as `none`, comes back the same way,
 * `none` did nothing for this model: gpt-oss accepts only low / medium / high,
 * and a GLM chat template reads an effort it does not know as its maximum
 * (vllm-project/vllm#54744). That is learned too (`REASONS_REGARDLESS`): later
 * calls go out as the call asks, with the thinking room #1276 keeps, and an
 * answerless reply is final. After the first such call, one request.
 *
 * An endpoint that refuses the reasoning field altogether can be asked
 * neither way: it learns `"none"` (no field), and once its model is seen
 * reasoning unasked, `FIELD_REFUSED_REASONS_REGARDLESS`. Its `none` repeat is
 * the refused field itself, so a refusal of that repeat is learned as both.
 * Every request of a call, these repeats included, counts against its budget
 * of two (`request-hops.ts`).
 *
 * What bounds the calls themselves is not here: the chain keeps background
 * work off a provider that keeps failing (`provider-runner.ts`), and each job
 * backs off the record it failed on.
 */
import { emitSignal } from "@/lib/logging/signal";
import {
  ANSWERS_ONLY_UNREASONED,
  FIELD_REFUSED_REASONS_REGARDLESS,
  REASONS_REGARDLESS,
  annotateReasoningDowngrade,
  learnedReasoningDialect,
  reasoningSeen,
  refusesReasoningField,
  rememberReasoningDialect,
  type ReasoningDialectKey,
} from "./dialect-cache";
import {
  REASONING_THINKING_BUDGET,
  uncontrolledThinkingRoom,
  type ReasoningLevel,
} from "./levels";

/**
 * What the client does next with an answerless reply.
 *  - `ask_unreasoned`: learned that the model answers only unreasoned; send
 *    the call once more (it now goes out as `none`).
 *  - `final`: throw the empty reply. `learnedRegardless` is true when this
 *    reply taught that `none` does not help.
 */
export type AnswerlessStep =
  { kind: "ask_unreasoned" } | { kind: "final"; learnedRegardless: boolean };

/**
 * The next step for a reply with no answer. `sent` is the effort the request
 * carried (`null`: no field); `hadReasoning` whether the reply reasoned.
 */
export function nextAnswerlessStep(
  key: ReasoningDialectKey,
  sent: string | null,
  hadReasoning: boolean,
): AnswerlessStep {
  const learned = learnedReasoningDialect(key);
  if (
    learned === REASONS_REGARDLESS ||
    learned === FIELD_REFUSED_REASONS_REGARDLESS
  ) {
    return { kind: "final", learnedRegardless: false };
  }
  // The endpoint refuses the field: there is no `none` to ask with.
  if (learned === "none") {
    if (!hadReasoning) return { kind: "final", learnedRegardless: false };
    rememberReasoningDialect(key, FIELD_REFUSED_REASONS_REGARDLESS, "reply");
    return { kind: "final", learnedRegardless: true };
  }
  if (sent === "none") {
    if (!hadReasoning) return { kind: "final", learnedRegardless: false };
    rememberReasoningDialect(key, REASONS_REGARDLESS, "reply");
    return { kind: "final", learnedRegardless: true };
  }
  if (!hadReasoning && sent === null) {
    return { kind: "final", learnedRegardless: false };
  }
  rememberReasoningDialect(key, ANSWERS_ONLY_UNREASONED, "reply");
  return { kind: "ask_unreasoned" };
}

/**
 * The clients' whole answerless step: decide, mark the downgrade, and write
 * the one line each lesson gets (`<signals>.reasoning_answerless` when the
 * repeat is learned, `<signals>.reasoning_unswitchable` when it is learned
 * useless), never one per call. True when the call goes out once more.
 */
export function askAgainUnreasoned(args: {
  key: ReasoningDialectKey;
  /** The provider tag for the downgrade mark (`local`, `openai-compatible`). */
  provider: string;
  signals: "ai.local" | "ai.gateway";
  sent: string | null;
  hadReasoning: boolean;
  finishReason: string | null | undefined;
}): boolean {
  const finish =
    args.finishReason === "length" || args.finishReason === "stop"
      ? args.finishReason
      : "other";
  const step = nextAnswerlessStep(args.key, args.sent, args.hadReasoning);
  if (step.kind === "final") {
    if (step.learnedRegardless) {
      emitSignal({
        action: `${args.signals}.reasoning_unswitchable`,
        level: "warn",
        meta: { finish },
      });
    }
    return false;
  }
  annotateReasoningDowngrade(args.provider, args.sent ?? "default", "none");
  emitSignal({
    action: `${args.signals}.reasoning_answerless`,
    level: "warn",
    meta: {
      effort: args.sent ?? "default",
      finish,
      reasoning: args.hadReasoning,
    },
  });
  return true;
}

/**
 * True when the model has shown it reasons without being asked to, so a call
 * without a level of its own gets the thinking room (#1276).
 */
export function reasonsUnasked(key: ReasoningDialectKey): boolean {
  const learned = learnedReasoningDialect(key);
  return (
    learned === ANSWERS_ONLY_UNREASONED ||
    learned === REASONS_REGARDLESS ||
    learned === FIELD_REFUSED_REASONS_REGARDLESS
  );
}

/**
 * #1276 — the thinking room of an unattended call (`CompletionParams.unattended`)
 * to a model that has answered with reasoning alone (`reasonsUnasked`): at
 * least the `high` room the Coach gets on High. Background work asks for
 * `medium` at most, and a model that cannot be switched down (GLM behind
 * vLLM) spends all of it thinking and answers nothing, the daily briefing's
 * `reasoning_only`. The room applies from the #1267 repeat with `none` on:
 * one call may send two requests (`request-hops.ts`), and a once-a-day job
 * meets an expired lesson every morning, so the room has to ride on the
 * repeat or the first job of the day never gets it. A ceiling, not a charge:
 * a model that does stop at `none` never touches it, one that does not
 * thinks as long as it does either way and reaches the answer. Every call a
 * person is reading keeps `room`.
 */
export function unattendedThinkingRoom(
  key: ReasoningDialectKey,
  room: number,
  unattended: boolean | undefined,
): number {
  return unattended && reasonsUnasked(key)
    ? Math.max(room, REASONING_THINKING_BUDGET.high)
    : room;
}

/**
 * #1276 — the thinking room of one call on a wire whose reasoning switch the
 * client cannot verify (a gateway, a local server): by the call's level, not
 * by what the wire says, the `low` room for a call without a level once the
 * model has shown it reasons unasked, and the `high` room for background work
 * once it has answered with reasoning alone (`unattendedThinkingRoom`).
 */
export function uncontrolledCallThinkingRoom(
  key: ReasoningDialectKey,
  params: { reasoning?: { effort: ReasoningLevel }; unattended?: boolean },
): number {
  const room = params.reasoning
    ? uncontrolledThinkingRoom(params.reasoning.effort)
    : reasonsUnasked(key)
      ? uncontrolledThinkingRoom("off")
      : 0;
  return unattendedThinkingRoom(key, room, params.unattended);
}

/**
 * #1276 — true when the model has shown it reasons, for a request that did
 * (`asked`) or did not ask it to: a lesson that says it reasons unasked, or a
 * reply seen reasoning (`reasoningSeen`). Only then is unlabelled text that
 * ran into the ceiling read as reasoning (`answerOf`).
 */
export function knownReasoner(
  key: ReasoningDialectKey,
  asked: boolean,
): boolean {
  return reasonsUnasked(key) || reasoningSeen(key, asked);
}

/**
 * The endpoint refused the reasoning field `sent`: send none from now on. A
 * model already known to reason unasked keeps that lesson too, so it is never
 * asked with `none` again.
 */
export function learnReasoningFieldRefused(
  key: ReasoningDialectKey,
  provider: string,
  sent: string,
): void {
  const before = learnedReasoningDialect(key);
  rememberReasoningDialect(
    key,
    reasonsUnasked(key) ? FIELD_REFUSED_REASONS_REGARDLESS : "none",
    "refusal",
  );
  annotateReasoningDowngrade(provider, sent, "none");
  // One line per lesson, not per call: the operator learns that the
  // endpoint takes no reasoning field (an entry setting it refuses included).
  if (!refusesReasoningField(before)) {
    emitSignal({
      action: "ai.provider.reasoning_field_refused",
      level: "warn",
      meta: { provider, effort: sent },
    });
  }
}

/**
 * The repeat's outcome with the first request's tokens added: they were spent
 * upstream whether the repeat answers or fails too, and the day's ledger
 * charges what a call cost, not its last request.
 */
export async function withEarlierSpend<T extends { tokensUsed: number | null }>(
  repeat: Promise<T>,
  earlier: number | null,
): Promise<T> {
  if (earlier === null || earlier <= 0) return repeat;
  try {
    const result = await repeat;
    return {
      ...result,
      tokensUsed: (result.tokensUsed ?? 0) + earlier,
    };
  } catch (err) {
    addSpentTokens(err, earlier);
    throw err;
  }
}

/**
 * The `none` repeat after an answerless reply, carrying that reply's spend.
 * When the endpoint refused the `none` itself on the call's last request
 * (`reasoningRefused` on the error), the call ends with the first reply's
 * failure (`answerless`): the model reasoned without answering, and that is
 * what the call ran into, not the field the client then tried.
 */
export async function repeatUnreasoned<T extends { tokensUsed: number | null }>(
  repeat: Promise<T>,
  earlier: number | null,
  answerless: () => Error,
): Promise<T> {
  try {
    return await withEarlierSpend(repeat, earlier);
  } catch (err) {
    const refused = (err as { reasoningRefused?: unknown } | null)
      ?.reasoningRefused;
    throw refused === true ? answerless() : err;
  }
}

/**
 * Tokens a failed call spent upstream, as its error carries them
 * (`tokensUsed`), or `null` when it carries none.
 */
export function spentTokensOf(err: unknown): number | null {
  const value = (err as { tokensUsed?: unknown } | null)?.tokensUsed;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/** Add `tokens` to what the error `err` says its call spent. */
export function addSpentTokens(err: unknown, tokens: number | null): void {
  if (tokens === null || tokens <= 0) return;
  if (err === null || typeof err !== "object") return;
  Object.assign(err, { tokensUsed: (spentTokensOf(err) ?? 0) + tokens });
}

/**
 * Tokens a failed provider chain reported spending upstream
 * (`AllProvidersFailedError.tokensSpent`), or 0 when it reported none. What a
 * caller that reserved budget charges instead of a full refund: a model that
 * reasons without answering is billed for every call.
 */
export function spentOnFailure(err: unknown): number {
  const value = (err as { tokensSpent?: unknown } | null)?.tokensSpent;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}
