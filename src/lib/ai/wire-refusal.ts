/**
 * What a refused request teaches the Local and the OpenAI-compatible gateway
 * clients, in one place for both.
 *
 * Only an HTTP 400 that names a field the request carried teaches anything:
 * `max_tokens` where the model takes `max_completion_tokens` (#1304,
 * `isMaxTokensRejection`, learned per endpoint and model), the reasoning
 * field (`isReasoningParameterRejection`, learned per endpoint and model) or
 * `seed` (`isSeedRejection`, learned per endpoint: Gemini's endpoint has no
 * such field) or the JSON flag (`isResponseFormatRejection`, learned per
 * endpoint). The JSON flag is checked last, so a body that names another field never
 * switches JSON mode off. Whether the call then sends the lesser request
 * is the client's, inside its request budget (`request-hops.ts`).
 *
 * Server-only.
 */
import { annotate } from "@/lib/logging/context";

import {
  isResponseFormatRejection,
  rememberJsonModeDialect,
} from "./json-dialect";
import {
  isMaxTokensRejection,
  isSeedRejection,
  rememberMaxTokensRefused,
  rememberSeedRefused,
} from "./openai-capabilities";
import { learnReasoningFieldRefused } from "./reasoning/answerless";
import {
  isReasoningParameterRejection,
  type ReasoningDialectKey,
} from "./reasoning/dialect-cache";

export type RefusalLesson = "budget" | "reasoning" | "seed" | "json" | null;

export function learnFromRefusal(args: {
  status: number;
  body: string;
  model: string;
  /** The reasoning field the request carried, or `null` for none. */
  reasoning: {
    sent: string;
    key: ReasoningDialectKey;
    provider: string;
    /** The parameter names this endpoint's refusals use. */
    names: RegExp;
  } | null;
  /** The endpoint, when the request carried the JSON flag. */
  json: { endpoint: string; action: string } | null;
  /** The endpoint, when the request carried `max_tokens` it could drop. */
  budget: { endpoint: string } | null;
  /** The endpoint, when the request carried `seed` (absent: none sent). */
  seed?: { endpoint: string } | null;
}): RefusalLesson {
  const { reasoning, json, budget, seed } = args;
  if (budget && isMaxTokensRejection(args.status, args.body)) {
    rememberMaxTokensRefused(budget.endpoint, args.model);
    annotate({
      action: { name: "ai.compat.tokenBudgetField" },
      meta: { field: "max_completion_tokens", httpStatus: args.status },
    });
    return "budget";
  }
  if (
    reasoning &&
    isReasoningParameterRejection(
      args.status,
      args.body,
      reasoning.names,
      args.model,
    )
  ) {
    learnReasoningFieldRefused(
      reasoning.key,
      reasoning.provider,
      reasoning.sent,
    );
    return "reasoning";
  }
  if (seed && isSeedRejection(args.status, args.body)) {
    rememberSeedRefused(seed.endpoint);
    annotate({
      action: { name: "ai.compat.seedRefused" },
      meta: { httpStatus: args.status },
    });
    return "seed";
  }
  if (json && isResponseFormatRejection(args.status, args.body)) {
    rememberJsonModeDialect(json.endpoint, "none");
    annotate({
      action: { name: json.action },
      meta: { dialect: "none", httpStatus: args.status },
    });
    return "json";
  }
  return null;
}
