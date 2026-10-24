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
 * answerless reply is final. So one call costs two requests at most, and
 * after the first such call, one.
 *
 * What bounds the calls themselves is not here: the chain keeps background
 * work off a provider that keeps failing (`provider-runner.ts`), and each job
 * backs off the record it failed on.
 */
import {
  ANSWERS_ONLY_UNREASONED,
  REASONS_REGARDLESS,
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
  if (learnedReasoningDialect(key) === REASONS_REGARDLESS) {
    return { kind: "final", learnedRegardless: false };
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
 * True when the model has shown it reasons without being asked to, so a call
 * without a level of its own gets the thinking room (#1276).
 */
export function reasonsUnasked(key: ReasoningDialectKey): boolean {
  const learned = learnedReasoningDialect(key);
  return learned === ANSWERS_ONLY_UNREASONED || learned === REASONS_REGARDLESS;
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
