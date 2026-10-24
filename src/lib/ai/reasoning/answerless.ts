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
  rememberReasoningDialect,
  type ReasoningDialectKey,
} from "./dialect-cache";

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
    rememberReasoningDialect(key, FIELD_REFUSED_REASONS_REGARDLESS);
    return { kind: "final", learnedRegardless: true };
  }
  if (sent === "none") {
    if (!hadReasoning) return { kind: "final", learnedRegardless: false };
    rememberReasoningDialect(key, REASONS_REGARDLESS);
    return { kind: "final", learnedRegardless: true };
  }
  if (!hadReasoning && sent === null) {
    return { kind: "final", learnedRegardless: false };
  }
  rememberReasoningDialect(key, ANSWERS_ONLY_UNREASONED);
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
 * The endpoint refused the reasoning field `sent`: send none from now on. A
 * model already known to reason unasked keeps that lesson too, so it is never
 * asked with `none` again.
 */
export function learnReasoningFieldRefused(
  key: ReasoningDialectKey,
  provider: string,
  sent: string,
): void {
  rememberReasoningDialect(
    key,
    reasonsUnasked(key) ? FIELD_REFUSED_REASONS_REGARDLESS : "none",
  );
  annotateReasoningDowngrade(provider, sent, "none");
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
