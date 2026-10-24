/**
 * v1.41 — what each provider can do with reasoning, read from the provider
 * type and the model name alone.
 *
 * No admin keeps a model list. A name this file does not recognise is treated
 * optimistically: the client sends the request, and if the endpoint refuses a
 * parameter it retries without it and learns the refusal per endpoint and
 * model (`dialect-cache.ts`). What is reported here is therefore the starting
 * assumption, not a promise; the settings use `offIsReal` to label the lowest
 * option "Off" or "Minimal".
 *
 * The wire facts behind each branch, with sources:
 *
 *  - Codex backend: Responses API `reasoning: { effort, summary }` plus
 *    `include: ["reasoning.encrypted_content"]` for the stateless round trip.
 *    A live probe on 2026-10-06 against the current slug (`gpt-5.5`) answered
 *    `effort: "none"` with a non-reasoning reply and rejected `minimal` with
 *    "Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'",
 *    so "off" is real there. https://developers.openai.com/api/docs/guides/reasoning,
 *    https://developers.openai.com/cookbook/examples/responses_api/reasoning_items
 *  - OpenAI Chat Completions: `reasoning_effort`, no summaries and no
 *    reasoning items to hand back between tool rounds, so reasoning is only
 *    sent on rounds without tools. `none` exists from gpt-5.1 on (the gpt-6
 *    line included); gpt-5 knows `minimal`; the o-series starts at `low`.
 *    https://platform.openai.com/docs/api-reference/chat/create
 *  - Anthropic: manual `thinking: { type: "enabled", budget_tokens }` up to
 *    the 4.5 generation; adaptive `thinking: { type: "adaptive" }` with
 *    `output_config.effort` from 4.6 on (`budget_tokens` is deprecated on 4.6
 *    and refused from 4.7). From the 5 generation thinking is on whatever the
 *    request says, so "off" becomes the lowest effort. Sampling parameters
 *    are refused from 4.7 on.
 *    https://platform.claude.com/docs/en/build-with-claude/extended-thinking,
 *    https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking,
 *    https://platform.claude.com/docs/en/build-with-claude/effort
 *  - OpenRouter: `reasoning: { effort }` with `none` and `minimal` accepted,
 *    reply `reasoning` (text) and `reasoning_details[]`, which must go back
 *    unmodified on the assistant message of a tool round.
 *    https://openrouter.ai/docs/use-cases/reasoning-tokens
 *  - Other OpenAI-compatible gateways and local servers: `reasoning_effort`,
 *    reply `reasoning_content` (llama.cpp, LiteLLM) or `reasoning` (vLLM,
 *    Ollama, LM Studio), some models inline `<think>…</think>`.
 *    https://docs.litellm.ai/docs/reasoning_content,
 *    https://docs.vllm.ai/en/latest/features/reasoning_outputs.html,
 *    https://docs.ollama.com/api/openai-compatibility,
 *    https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
 *
 * Client-safe: no server import.
 */
import {
  openAIModelFamily,
  type OpenAIReasoningFamily,
} from "../openai-model-family";
import type { ProviderType } from "../types";
import type { ReasoningLevel } from "./levels";

export interface ReasoningSupport {
  /** The provider takes an effort (or a budget) at all. */
  effort: boolean;
  /** It returns readable summaries of the reasoning. */
  summaries: boolean;
  /** Summaries arrive while the call runs, not only after it. */
  liveSummaries: boolean;
  /** Reasoning state has to travel between tool rounds (`providerState`). */
  stateRoundTrip: boolean;
  /** "Off" switches reasoning off; false means it falls to the lowest level. */
  offIsReal: boolean;
}

const NONE: ReasoningSupport = {
  effort: false,
  summaries: false,
  liveSummaries: false,
  stateRoundTrip: false,
  offIsReal: true,
};

// ── Anthropic ───────────────────────────────────────────────────────────────

export interface AnthropicModelVersion {
  major: number;
  minor: number;
}

/**
 * The generation of a Claude model id: `claude-<tier>-<major>[-<minor>][-<date>]`
 * from Claude 4 on (`claude-sonnet-4-6`, `claude-opus-5`, `claude-opus-4-20250514`),
 * `claude-<major>[-<minor>]-<tier>` before (`claude-3-7-sonnet-latest`). A
 * dotted minor (`claude-sonnet-4.5`, the gateway spelling) reads the same. An
 * eight-digit segment is a snapshot date, not a minor. `null` for anything
 * else (a proxy alias, a typo): the client then tries the current dialect and
 * learns from the answer.
 */
export function anthropicModelVersion(
  model: string,
): AnthropicModelVersion | null {
  const m = model.toLowerCase().replace(/^anthropic\//, "");
  const modern =
    /^claude-(?:opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?:[-.](\d{1,2}))?(?:$|[-@:])/.exec(
      m,
    );
  if (modern) {
    return { major: Number(modern[1]), minor: Number(modern[2] ?? 0) };
  }
  const legacy = /^claude-(\d)(?:[-.](\d))?-(?:opus|sonnet|haiku)/.exec(m);
  if (legacy) {
    return { major: Number(legacy[1]), minor: Number(legacy[2] ?? 0) };
  }
  return null;
}

function atLeast(
  v: AnthropicModelVersion,
  major: number,
  minor: number,
): boolean {
  return v.major > major || (v.major === major && v.minor >= minor);
}

/**
 * How a Claude model is asked to think. `manual` is the budget form (up to
 * 4.5, and 3.7), `adaptive` the effort form (4.6 on, and every name this
 * function cannot read), `none` a model that cannot think (3.5 and older).
 */
export type AnthropicThinkingDialect = "adaptive" | "manual" | "none";

export function anthropicThinkingDialect(
  model: string,
): AnthropicThinkingDialect {
  const v = anthropicModelVersion(model);
  if (!v) return "adaptive";
  if (v.major < 3) return "none";
  if (v.major === 3) return v.minor >= 7 ? "manual" : "none";
  return atLeast(v, 4, 6) ? "adaptive" : "manual";
}

/**
 * True when the model refuses `temperature` / `top_p` / `top_k` (4.7 on; the
 * 5 generation refuses any value, including the default). Unknown names
 * return false: the client keeps today's wire and learns from a refusal.
 */
export function anthropicRefusesSampling(model: string): boolean {
  const v = anthropicModelVersion(model);
  return v !== null && atLeast(v, 4, 7);
}

/** True from the 5 generation on: thinking runs whatever the request says. */
export function anthropicThinksAlways(model: string): boolean {
  const v = anthropicModelVersion(model);
  return v !== null && v.major >= 5;
}

// ── OpenAI ──────────────────────────────────────────────────────────────────

export type { OpenAIReasoningFamily };

/**
 * The reasoning family of an OpenAI model id, or `null` for a model that does
 * not reason (`gpt-4o`, `gpt-4.1`) or is not recognised. `gpt-5.1+` (every
 * generation from 5.1 on, the gpt-6 line included) knows `none`, bare `gpt-5`
 * (and its mini / nano) stops at `minimal`, the o-series at `low`. The
 * reading itself lives in `openai-model-family.ts`.
 */
export function openAIReasoningFamily(model: string): OpenAIReasoningFamily {
  return openAIModelFamily(model)?.reasoning ?? null;
}

/** The lowest `reasoning_effort` an OpenAI reasoning family accepts. */
export function openAIOffEffort(
  family: Exclude<OpenAIReasoningFamily, null>,
): "none" | "minimal" | "low" {
  return family === "gpt-5.1+"
    ? "none"
    : family === "gpt-5"
      ? "minimal"
      : "low";
}

/** True for an OpenRouter base URL, whose reasoning dialect differs. */
export function isOpenRouterEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

// ── Support matrix ──────────────────────────────────────────────────────────

/**
 * What `providerType` serving `model` can do with reasoning. `baseUrl` only
 * matters for the gateway tag (OpenRouter has its own dialect) and the
 * operator's OpenAI provider (a non-OpenAI base URL is a gateway in all but
 * name).
 */
export function reasoningSupport(
  providerType: ProviderType,
  model: string,
  opts: { baseUrl?: string } = {},
): ReasoningSupport {
  switch (providerType) {
    case "codex":
      return {
        effort: true,
        summaries: true,
        liveSummaries: true,
        stateRoundTrip: true,
        offIsReal: true,
      };
    case "anthropic": {
      const dialect = anthropicThinkingDialect(model);
      if (dialect === "none") return NONE;
      return {
        effort: true,
        summaries: true,
        liveSummaries: false,
        stateRoundTrip: true,
        offIsReal: !anthropicThinksAlways(model),
      };
    }
    case "admin-key": {
      const family = openAIReasoningFamily(model);
      if (!family) return NONE;
      return {
        effort: true,
        summaries: false,
        liveSummaries: false,
        stateRoundTrip: false,
        offIsReal: family === "gpt-5.1+",
      };
    }
    case "openai-compatible": {
      const openRouter = opts.baseUrl
        ? isOpenRouterEndpoint(opts.baseUrl)
        : false;
      return {
        effort: true,
        summaries: true,
        liveSummaries: false,
        stateRoundTrip: openRouter,
        offIsReal: true,
      };
    }
    case "local":
      return {
        effort: true,
        summaries: true,
        liveSummaries: true,
        stateRoundTrip: false,
        offIsReal: true,
      };
    case "none":
      return NONE;
  }
}

// ── Shared parsing helpers ──────────────────────────────────────────────────

/**
 * The title of a reasoning summary: its first line when that line is wholly
 * bold (`**Checking the window**`), the convention the Responses API
 * summaries follow. `null` when the summary has no such line yet or at all.
 */
export function reasoningTitleOf(text: string): string | null {
  const m = /^\s*\*\*([^*\n]+?)\*\*\s*(?:\n|$)/.exec(text);
  return m ? m[1].trim() : null;
}

/**
 * Split a reply that inlines its reasoning as a leading `<think>…</think>`
 * block (some local models do, and any server without a reasoning parser
 * passes it through). Only a block at the very start counts; a mention later
 * in the prose stays prose. An unclosed block means the answer budget ran out
 * inside the reasoning: everything is reasoning, no answer.
 *
 * #1276 — a reply can also carry only the closing tag: GLM, Qwen3 and
 * DeepSeek-R1 chat templates end the generation prompt with `<think>`, so the
 * model's output starts inside the block. Everything before the first
 * `</think>` of such a reply is reasoning.
 */
export function splitThinkTags(content: string): {
  content: string;
  reasoning: string | null;
} {
  const m =
    /^\s*<think>([\s\S]*?)(<\/think>|$)/.exec(content) ??
    /^([\s\S]*?)(<\/think>)/.exec(content);
  if (!m) return { content, reasoning: null };
  const reasoning = m[1].trim();
  const rest = m[2] ? content.slice(m[0].length).replace(/^\s+/, "") : "";
  return { content: rest, reasoning: reasoning.length > 0 ? reasoning : null };
}

/**
 * #1276 — what a Chat Completions reply's `content` holds, for a wire whose
 * reasoning switch the client does not control (a gateway, a local server).
 *
 *  - Inline reasoning (`<think>…</think>`, or only the closing tag) is split
 *    off by {@link splitThinkTags}.
 *  - A reply that ran into a ceiling which held room for reasoning
 *    (`finish_reason: "length"`, `reasoningRoom`), with no reasoning field
 *    beside it, no tag and no tool call, is reasoning the server did not
 *    separate: the budget was sized for thinking plus an answer, so text
 *    that fills all of it unlabelled is the thought, cut off. It is never
 *    the answer.
 *
 * `reasoning` is the text taken out of `content`, for the reasoning channel.
 * `unseparated` marks the second case so the caller can say so in its log.
 */
export function answerOf(
  content: string | null | undefined,
  reply: {
    /** The reply carried `reasoning` / `reasoning_content` beside `content`. */
    fieldedReasoning: boolean;
    finishReason: string | null | undefined;
    hasToolCalls: boolean;
    /** The request's ceiling held room for reasoning on top of the answer. */
    reasoningRoom: boolean;
  },
): { content: string; reasoning: string | null; unseparated: boolean } {
  const text = content ?? "";
  if (!text) return { content: "", reasoning: null, unseparated: false };
  const split = splitThinkTags(text);
  if (split.content !== text || split.reasoning !== null) {
    return {
      content: split.content,
      reasoning: split.reasoning,
      unseparated: false,
    };
  }
  if (
    reply.finishReason === "length" &&
    reply.reasoningRoom &&
    !reply.fieldedReasoning &&
    !reply.hasToolCalls
  ) {
    const reasoning = text.trim();
    return {
      content: "",
      reasoning: reasoning.length > 0 ? reasoning : null,
      unseparated: true,
    };
  }
  return { content: text, reasoning: null, unseparated: false };
}

/** The level a provider's wire effort corresponds to, for `downgradedTo`. */
export function levelOfWireEffort(effort: string | null): ReasoningLevel {
  switch (effort) {
    case "low":
    case "medium":
    case "high":
      return effort;
    case "xhigh":
    case "max":
      return "high";
    default:
      return "off";
  }
}
