/**
 * What a refused request teaches the Local and the OpenAI-compatible gateway
 * clients, in one place for both.
 *
 * Only an HTTP 400 that names a field the request carried teaches anything:
 * the reasoning field (`isReasoningParameterRejection`, learned per endpoint
 * and model) or the JSON flag (`isResponseFormatRejection`, learned per
 * endpoint). The reasoning field is checked first, so a body that names it
 * never switches JSON mode off. Whether the call then sends the lesser request
 * is the client's, inside its request budget (`request-hops.ts`).
 *
 * Server-only.
 */
import { annotate } from "@/lib/logging/context";

import {
  isResponseFormatRejection,
  rememberJsonModeDialect,
} from "./json-dialect";
import { learnReasoningFieldRefused } from "./reasoning/answerless";
import {
  isReasoningParameterRejection,
  type ReasoningDialectKey,
} from "./reasoning/dialect-cache";

export type RefusalLesson = "reasoning" | "json" | null;

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
}): RefusalLesson {
  const { reasoning, json } = args;
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
