/**
 * Request and error shapes of the Local client that need nothing of its state.
 * Split out of `local-client.ts`; that client is their only importer.
 *
 * Server-only.
 */
import type { AiMessage } from "./types";

const STRICT_JSON_PREFIX =
  "Return strict JSON only, no markdown, no commentary.\n\n";

/**
 * Prepend the strict-JSON instruction to the FIRST user turn's text. Local
 * model templates respect an in-message instruction reliably, so it is sent
 * in BOTH dialects — it is the only JSON steering left when an endpoint
 * rejects `response_format` (dialect `"none"`). Mirrors the pre-refactor
 * behaviour, which prepended to the single user prompt.
 */
export function withStrictJsonPrefix(messages: AiMessage[]): AiMessage[] {
  const idx = messages.findIndex((m) => m.role === "user");
  if (idx === -1) return messages;
  const out = [...messages];
  const target = out[idx];
  if (typeof target.content === "string") {
    out[idx] = { ...target, content: `${STRICT_JSON_PREFIX}${target.content}` };
  } else {
    // Vision parts: prepend a leading text part with the instruction.
    out[idx] = {
      ...target,
      content: [{ type: "text", text: STRICT_JSON_PREFIX }, ...target.content],
    };
  }
  return out;
}

/**
 * The empty-reply error. `httpStatus: 0` is the sentinel the chain classifier
 * treats as a hard failure; `kind` says whether the reply held reasoning and
 * no answer, or nothing at all, so the log names it instead of "network".
 */
export function emptyReplyError(
  hadReasoning: boolean,
  spent: number | null,
): Error {
  const err = new Error(
    hadReasoning
      ? "Local AI returned reasoning but no answer"
      : "Local AI returned empty content",
  );
  Object.assign(err, {
    httpStatus: 0,
    kind: hadReasoning ? "reasoning_only" : "empty_response",
    upstream: "local",
    // #1279 — what the reply cost, for the day's ledger to charge.
    ...(spent !== null ? { tokensUsed: spent } : {}),
  });
  return err;
}
