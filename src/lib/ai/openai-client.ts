import { callTimeoutMs } from "./effective-timeout";
import { annotate } from "@/lib/logging/context";
import { emitSignal } from "@/lib/logging/signal";
import type {
  AIProvider,
  AiToolCall,
  CompletionParams,
  CompletionResult,
} from "./types";
import {
  isCanonicalOpenAIEndpoint,
  selectOpenAIChatCompletionsCapabilities,
  type OpenAIChatCompletionsCapabilities,
} from "./openai-capabilities";
import {
  ANSWERS_ONLY_UNREASONED,
  learnedReasoningDialect,
  noteReasoningSeen,
  refusesReasoningField,
} from "./reasoning/dialect-cache";
import {
  askAgainUnreasoned,
  knownReasoner,
  uncontrolledCallThinkingRoom,
  repeatUnreasoned,
} from "./reasoning/answerless";
import { RequestHops } from "./request-hops";
import { learnFromRefusal } from "./wire-refusal";
import { REASONING_THINKING_BUDGET } from "./reasoning/levels";
import {
  answerOf,
  isOpenRouterEndpoint,
  levelOfWireEffort,
  openAIOffEffort,
  openAIReasoningFamily,
  reasoningTitleOf,
} from "./reasoning/support";
import {
  hasLearnedJsonModeDialect,
  jsonModeDialectFor,
  rememberJsonModeDialect,
} from "./json-dialect";
import { aiEgressPolicyFor } from "./local-host-allowlist";
import { probeModelListing } from "./model-availability";
import type { ReasoningEffort } from "./reasoning-effort";
import {
  buildOpenAIMessages,
  buildOpenAITools,
  mapFinishReason,
  parseCachedTokens,
  parseOpenAIToolCalls,
  raiseEmbeddedError,
  sanitiseBodyExcerpt,
  type OpenAIChoice,
  type OpenAIResponseJson,
} from "./openai-wire";

interface OpenAIClientConfig {
  /**
   * Bearer credential. Empty string means "no bearer" — only the
   * `openai-compatible` tag ever constructs that way (a LAN gateway with no
   * auth); every OpenAI-keyed call site checks the key's presence first.
   */
  apiKey: string;
  model: string;
  baseUrl: string;
  /**
   * Override the provider tag used in logs and analytics. Defaults to
   * "admin-key". The Codex flow uses the same OpenAI API but the key
   * was obtained via the token-exchange grant against a ChatGPT
   * subscription — for billing and observability we want that path
   * to log as "codex" instead.
   *
   * v1.33.1 (#470) — `openai-compatible` is the user-configured gateway
   * (LiteLLM / OpenRouter / vLLM). Its `baseUrl` always comes from a person,
   * and two behaviours hang off that: the operator's private-host allowlist
   * may apply, and the JSON-mode dialect is learned per endpoint instead of
   * assumed. `admin-key` carries a person-typed base URL in exactly one
   * place (the operator's global provider in the admin settings) and shares
   * the allowlist policy for it since v1.37.30; the dialect stays assumed.
   * `codex` keeps the fully pinned posture.
   */
  providerType?: OpenAIProviderType;
  /**
   * v1.39.3 — true when the base URL belongs to the operator: the
   * instance-wide admin provider, or provider settings saved on an admin
   * account. Only such a URL is still covered by the deprecated
   * `ALLOW_LOCAL_AI_PRIVATE_HOSTS=true` (see `local-host-allowlist.ts`).
   */
  operatorTrusted?: boolean;
}

type OpenAIProviderType = "admin-key" | "codex" | "openai-compatible";

/**
 * v1.41 — the reasoning one request sends.
 *  - `reasoning_effort`: the Chat Completions field (OpenAI, LiteLLM, vLLM,
 *    most gateways). https://platform.openai.com/docs/api-reference/chat/create
 *  - `openrouter`: OpenRouter's `reasoning: { effort }` object, which also
 *    returns `reasoning_details` to hand back on tool rounds.
 *    https://openrouter.ai/docs/use-cases/reasoning-tokens
 */
type OpenAIReasoningWire =
  | { kind: "none" }
  | { kind: "reasoning_effort"; effort: string }
  | { kind: "openrouter"; effort: string };

/**
 * Assistant-message fields a gateway returns and needs back unmodified on the
 * next tool round: OpenRouter's `reasoning_details` and the `thinking_blocks`
 * LiteLLM carries for Claude upstreams (https://docs.litellm.ai/docs/reasoning_content).
 */
const ROUND_TRIP_FIELDS = ["reasoning_details", "thinking_blocks"] as const;

export class OpenAIClient implements AIProvider {
  readonly type: OpenAIProviderType;
  /** See `AIProvider.responseTimeoutSeconds`; stamped by the resolver. */
  responseTimeoutSeconds: number | null = null;
  /**
   * See `AIProvider.reasoningEffort`; stamped by the resolver. Only the
   * gateway tag ever sends it (`isGateway` below), whatever is stamped here.
   */
  reasoningEffort: ReasoningEffort | null = null;
  private config: OpenAIClientConfig;

  constructor(config: OpenAIClientConfig) {
    this.config = config;
    this.type = config.providerType ?? "admin-key";
  }

  /**
   * v1.42 — after a server error from an operator- or person-configured
   * endpoint (never the canonical `api.openai.com`, which names a missing
   * model in its own 404), check whether it still lists the configured
   * model. A 4xx already carries its reason in the body; a 5xx from a proxy
   * often carries none. See `model-availability.ts`.
   */
  private async modelNoLongerServed(status: number): Promise<boolean> {
    if (status < 500) return false;
    if (this.type === "codex") return false;
    if (isCanonicalOpenAIEndpoint(this.config.baseUrl)) return false;
    const listing = await probeModelListing({
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      model: this.config.model,
      operatorTrusted: this.config.operatorTrusted,
    });
    if (listing === "not_listed") {
      emitSignal({
        action: "ai.provider.model_not_served",
        level: "error",
        meta: { provider: this.type, model: this.config.model, status },
      });
    }
    return listing === "not_listed";
  }

  /**
   * True only for the user-configured gateway. Read it as "the base URL came
   * from a person, not from this repository" — every behaviour that must not
   * change for `api.openai.com` is gated on it.
   */
  private get isGateway(): boolean {
    return this.type === "openai-compatible";
  }

  /**
   * `hops` is the call's request budget (`request-hops.ts`): a caller never
   * passes it, every repeat inside the call hands it on.
   */
  async generateCompletion(
    params: CompletionParams,
    hops: RequestHops = new RequestHops(),
  ): Promise<CompletionResult> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;

    // System turn first (the stable cache prefix — OpenAI prefix-caches a
    // byte-identical ≥1024-token prefix automatically, no API flag), then the
    // conversation turns mapped 1:1. Vision parts (Lab-OCR) become the
    // multimodal `image_url` content array `gpt-4o`-class models accept. The
    // image is framed as untrusted DATA by the system prompt.
    const messages = this.withRoundTripState(
      buildOpenAIMessages(params.system, params.messages),
      params,
    );

    // v1.20.0 — tool plumbing. The defs map onto the OpenAI `function` tool
    // wire; F1 supplies real defs and consumes the parsed `toolCalls`. No F4
    // call site sets `tools`, so the text-only body is unchanged.
    const hasTools = !!params.tools && params.tools.length > 0;
    const tools = hasTools ? buildOpenAITools(params.tools!) : undefined;

    // Only force OpenAI's strict JSON mode when the caller actually consumes a
    // JSON object AND no tools are in play — mirrors the Anthropic client's
    // `usePrefill` gate. JSON mode coerces `message.content` into a valid JSON
    // object, which contradicts the Coach prose contract; the tool loop's
    // forced-final round (tools with toolChoice:"none", no responseFormat)
    // must therefore stay out of JSON mode, and every tool round is non-JSON
    // by construction. Insight/extraction callers opt in with `responseFormat:"json"`.
    const useJsonFormat = params.responseFormat === "json" && !hasTools;
    // v1.33.1 (#470) — a gateway may reject the standard `response_format`
    // field. Learn that per endpoint (shared cache with the Local client) and
    // retry once without the flag below. `api.openai.com` defines the field,
    // so the pinned tags never consult the dialect and never retry.
    const jsonDialect = this.isGateway
      ? jsonModeDialectFor(this.config.baseUrl)
      : "response_format";
    const sendJsonFormat = useJsonFormat && jsonDialect === "response_format";
    const capabilities = selectOpenAIChatCompletionsCapabilities(
      this.config.baseUrl,
      this.config.model,
    );
    const reasoningWire = this.planReasoning(params, hasTools, capabilities);
    // #1126 — the gateway entry's own setting, for a call without a level,
    // unless the wire carries one or the endpoint refused the field (#1279).
    const entryEffort =
      !params.reasoning &&
      this.isGateway &&
      this.reasoningEffort &&
      reasoningWire.kind === "none" &&
      !this.refusesField()
        ? this.reasoningEffort
        : null;
    const sent =
      reasoningWire.kind !== "none" ? reasoningWire.effort : entryEffort;
    const thinkingTokens = this.thinkingRoom(params, reasoningWire);
    const tokenBudget = (params.maxTokens ?? 1000) + thinkingTokens;
    const capabilityParams = capabilities.supportsSamplingControls
      ? {
          [capabilities.tokenBudgetField]: tokenBudget,
          temperature: params.temperature ?? 0.3,
          ...(params.seed !== undefined ? { seed: params.seed } : {}),
        }
      : { [capabilities.tokenBudgetField]: tokenBudget };

    // A gateway that needs no bearer (a LAN LiteLLM without a master key)
    // gets no `Authorization` header at all rather than an empty one — an
    // empty bearer is a 401 on some proxies. Every OpenAI-keyed construction
    // site checks the key's presence, so this branch is gateway-only in
    // practice.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const trimmedKey = this.config.apiKey?.trim();
    if (trimmedKey) headers.Authorization = `Bearer ${trimmedKey}`;

    const res = await hops.fetch(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.config.model,
          messages,
          ...capabilityParams,
          ...(sendJsonFormat
            ? { response_format: { type: "json_object" } }
            : {}),
          ...(tools ? { tools } : {}),
          ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
          // v1.41.2 — the prompt-cache routing key `api.openai.com` documents
          // (https://platform.openai.com/docs/guides/prompt-caching). Only
          // there: a gateway or proxy behind another base URL may refuse a
          // field it does not know.
          ...(params.cacheKey && isCanonicalOpenAIEndpoint(this.config.baseUrl)
            ? { prompt_cache_key: params.cacheKey }
            : {}),
          // #1126 — the gateway entry's reasoning setting; Default sends
          // nothing. `api.openai.com` and Codex never get it. A call that
          // carries its own resolved level (`params.reasoning`) wins, and
          // (#1267) once a model answered nothing while reasoning, the wire
          // below carries `none` instead (`planReasoning`).
          ...(entryEffort ? { reasoning_effort: this.reasoningEffort } : {}),
          ...(reasoningWire.kind === "reasoning_effort"
            ? { reasoning_effort: reasoningWire.effort }
            : reasoningWire.kind === "openrouter"
              ? { reasoning: { effort: reasoningWire.effort } }
              : {}),
        }),
      },
      // The record owner's response-timeout setting (else the surface value,
      // else 60 s), and the caller's cancel signal (a Coach disconnect tears
      // the upstream call down). The gateway's base URL and the operator's
      // `admin-key` one are typed by a person, so they take the Local
      // provider's host policy: public hosts always, a private host only for
      // an origin the operator granted (`AI_PRIVATE_ORIGINS`), dialled through
      // the pinned operator-approved dispatcher; a personal key pins the
      // public `api.openai.com`, for which the policy never consults the
      // allowlist. `codex` keeps the hard pin: its URL is a repository constant.
      {
        timeoutMs: callTimeoutMs(params, this.responseTimeoutSeconds),
        ...(this.isGateway || this.type === "admin-key"
          ? aiEgressPolicyFor(url, {
              operatorTrusted: this.config.operatorTrusted,
            })
          : { requirePublicHost: true as const }),
        signal: params.signal,
      },
    );

    if (!res.ok) {
      return this.failed(res, params, hops, { sent, sendJsonFormat });
    }

    // v1.33.1 (#470) — the standard `response_format` request succeeded: pin
    // the dialect for this endpoint so a later transient 4xx can never
    // silently degrade it.
    if (
      this.isGateway &&
      sendJsonFormat &&
      !hasLearnedJsonModeDialect(this.config.baseUrl)
    ) {
      rememberJsonModeDialect(this.config.baseUrl, "response_format");
      annotate({
        action: { name: "ai.compat.jsonDialect" },
        meta: { dialect: "response_format" },
      });
    }

    const json = (await res.json()) as OpenAIResponseJson;

    // A 200 that carries the failure inside the body. OpenRouter (and every
    // gateway that copies it) answers a provider-side refusal — no credits,
    // a data-policy or moderation block, an upstream timeout, a model that is
    // down, no provider matching the routing requirements — with HTTP 200 and
    // a top-level `error` object instead of `choices`, and a generation that
    // died mid-flight with `choices[0].error` beside `finish_reason: "error"`.
    // Both used to fall through to the empty-content throw below, so every one
    // of those causes collapsed into "returned empty content", status 0, no
    // excerpt: neither the person nor the provider-health card could tell them
    // apart. Raise the same shaped error a non-2xx reply raises so the chain
    // classifier, the health ledger and the card all see the real status.
    //
    // Gated on the gateway tag because the shape is gateway-only: on
    // `api.openai.com` — the `admin-key` and `codex` tags — a failure is
    // always a non-2xx status, so their parsing is untouched.
    if (this.isGateway) {
      raiseEmbeddedError(json, {
        upstream: "openai-compatible",
        label: "OpenAI-compatible gateway",
        model: this.config.model,
      });
    }

    const choice = json.choices?.[0];
    const toolCalls = parseOpenAIToolCalls(choice);
    const reply = this.separateReasoning(choice, toolCalls, {
      thinkingTokens,
      sent,
    });
    let content: string = reply.content;

    // v1.28.28 (#470) — gateway JSON-mode shim. LiteLLM (and similar
    // OpenAI-compatible proxies) translate `response_format: json_object`
    // for an Anthropic upstream into a synthesized tool call: the reply
    // comes back with `finish_reason: "tool_calls"`, an empty / "{}"
    // `message.content`, and the actual JSON object in
    // `tool_calls[0].function.arguments`. Since no JSON caller passes
    // tools (useJsonFormat requires !hasTools), lift the arguments string
    // into `content` so the payload parses instead of silently emptying
    // the insight. The real tool loop (Coach F1) always has tools and
    // never enters JSON mode, so it is untouched.
    const trimmedContent = content.trim();
    if (useJsonFormat && (trimmedContent === "" || trimmedContent === "{}")) {
      const args = choice?.message?.tool_calls?.[0]?.function?.arguments;
      if (typeof args === "string" && args.trim().length > 0) {
        content = args;
      }
    }

    // A reply with tool calls and no prose is valid (F1 tool loop); only an
    // empty reply with neither content NOR tool calls is an error.
    if (!content && !toolCalls) {
      return this.answerless(params, hops, {
        sent,
        hadReasoning: reply.hadReasoning,
        finishReason: choice?.finish_reason,
        spent: json.usage?.total_tokens ?? null,
      });
    }

    const summary = reply.reasoning ? [reply.reasoning.trim()] : [];
    const emit = params.reasoning ? params.onReasoning : undefined;
    if (emit) {
      for (const text of summary) {
        const title = reasoningTitleOf(text);
        if (title) emit({ kind: "title", text: title });
        emit({ kind: "text", text });
      }
      emit({ kind: "done", text: "" });
    }
    const message = (choice?.message ?? {}) as Record<string, unknown>;
    const roundTrip = ROUND_TRIP_FIELDS.filter(
      (field) => message[field] !== undefined && message[field] !== null,
    ).map((field) => ({ [field]: message[field] }));
    const usage = json.usage as
      { completion_tokens_details?: { reasoning_tokens?: number } } | undefined;
    const learnedNone = refusesReasoningField(
      learnedReasoningDialect(this.reasoningDialectKey()),
    );

    return {
      content,
      tokensUsed: json.usage?.total_tokens ?? null,
      cachedInputTokens: parseCachedTokens(json),
      model: this.config.model,
      providerType: this.type,
      ...(toolCalls ? { toolCalls } : {}),
      // #1276 — the calls decide, as on the Anthropic and Codex wires.
      finishReason: toolCalls
        ? "tool_calls"
        : mapFinishReason(choice?.finish_reason),
      ...(params.reasoning
        ? {
            reasoning: {
              summary,
              // Billed as completion tokens, already inside `total_tokens`.
              tokens:
                usage?.completion_tokens_details?.reasoning_tokens ?? null,
              ...(learnedNone && params.reasoning.effort !== "off"
                ? { downgradedTo: "off" as const }
                : {}),
            },
          }
        : {}),
      ...(roundTrip.length > 0
        ? {
            providerState: {
              providerType: this.type,
              model: this.config.model,
              items: roundTrip,
            },
          }
        : {}),
    };
  }

  /**
   * A reply with neither an answer nor tool calls. #1267 — a gateway in front
   * of a thinking model (Ollama serving Gemma 4, say) can answer with the
   * thought in `reasoning` and no content; asked with `none`, the same model
   * answers, so that is learned once and the call asked again. #1279 — once,
   * and never `none` again for a model the repeat showed ignores it. Same
   * rule as the Local client (`reasoning/answerless.ts`).
   *
   * Otherwise the empty reply is thrown, tagged with a sentinel
   * `httpStatus: 0` and its `kind` (v1.20.1) so the chain classifier can tell
   * it apart from a transport failure (ECONNRESET, DNS, timeout). The cascade
   * is unchanged: `isHardProviderFailure` treats `status <= 0` as hard. It
   * carries what the reply cost, for the day's ledger to charge.
   */
  private answerless(
    params: CompletionParams,
    hops: RequestHops,
    reply: {
      sent: string | null;
      hadReasoning: boolean;
      finishReason: string | null | undefined;
      spent: number | null;
    },
  ): Promise<CompletionResult> {
    const failure = () =>
      Object.assign(
        new Error(
          `${this.isGateway ? "OpenAI-compatible gateway" : "OpenAI"} returned empty content`,
        ),
        {
          httpStatus: 0,
          kind: reply.hadReasoning ? "reasoning_only" : "empty_response",
          upstream: this.isGateway ? "openai-compatible" : "openai",
          ...(reply.spent !== null ? { tokensUsed: reply.spent } : {}),
        },
      );
    if (
      this.isGateway &&
      // The lesson holds even when the budget leaves no repeat for it.
      askAgainUnreasoned({
        key: this.reasoningDialectKey(),
        provider: this.type,
        signals: "ai.gateway",
        sent: reply.sent,
        hadReasoning: reply.hadReasoning,
        finishReason: reply.finishReason,
      }) &&
      hops.canSend
    ) {
      return repeatUnreasoned(
        this.generateCompletion(params, hops),
        reply.spent,
        failure,
      );
    }
    throw failure();
  }

  /**
   * A non-2xx reply. As much of the body as can be read goes into a
   * structured field (with anything key-shaped stripped), so an upstream
   * incident is diagnosable from the log instead of an opaque status.
   *
   * An endpoint or model that refuses the reasoning field, or (#470, gateway
   * only) the JSON flag, is asked once more without it and remembers
   * (`wire-refusal.ts`), inside the call's request budget. A refusal the
   * budget leaves no repeat for is marked `reasoningRefused`.
   *
   * A proxy that stopped offering the configured model answers with a bare
   * 500 that names nothing; its model listing (free, no completion) says so
   * plainly, so the chain, the health card and the log name the fix.
   */
  private async failed(
    res: Response,
    params: CompletionParams,
    hops: RequestHops,
    sent: { sent: string | null; sendJsonFormat: boolean },
  ): Promise<CompletionResult> {
    const bodyExcerpt = sanitiseBodyExcerpt(await res.text().catch(() => ""));
    // The entry's own setting (#1126) included: a refused field is learned
    // whichever level put it on the wire.
    const effort = sent.sent;
    const lesson = learnFromRefusal({
      status: res.status,
      body: bodyExcerpt,
      model: this.config.model,
      reasoning:
        effort === null
          ? null
          : {
              sent: effort,
              key: this.reasoningDialectKey(),
              provider: this.type,
              names: /reasoning|thinking/i,
            },
      json:
        this.isGateway && sent.sendJsonFormat
          ? { endpoint: this.config.baseUrl, action: "ai.compat.jsonDialect" }
          : null,
    });
    if (lesson && hops.canSend) return this.generateCompletion(params, hops);
    const modelNotServed = await this.modelNoLongerServed(res.status);
    const label = this.isGateway ? "OpenAI-compatible gateway" : "OpenAI";
    // The excerpt rides a structured field, not the message, so it lands in
    // the log fields that are filtered and truncated centrally.
    throw Object.assign(
      new Error(
        modelNotServed
          ? `${label} request failed (${res.status}): model "${this.config.model}" is not offered by this endpoint`
          : `${label} request failed (${res.status})`,
      ),
      {
        httpStatus: res.status,
        upstream: this.isGateway ? "openai-compatible" : "openai",
        model: this.config.model,
        bodyExcerpt,
        ...(modelNotServed ? { modelNotServed: true } : {}),
        ...(lesson === "reasoning" ? { reasoningRefused: true } : {}),
      },
    );
  }

  // ── v1.41 reasoning ───────────────────────────────────────────────────────

  /**
   * The thinking room on top of the answer budget. Reasoning tokens count
   * against the completion budget on every one of these wires, so without it
   * a 600-token Coach round spends its whole allowance thinking and returns
   * no answer. A ceiling, not a charge.
   *
   * #1276 — on a gateway the room follows the call's level, not the wire: a
   * model behind it may reason whatever `reasoning_effort` says, `none`
   * included, and a `none` sent for the person's Off or after the #1267
   * lesson must not leave it the bare answer budget to think in. Without a
   * level of its own, a call gets the `low` room once the model has shown it
   * reasons unasked, and background work the `high` room once the model has
   * answered with reasoning alone (`unattendedThinkingRoom`).
   */
  private thinkingRoom(
    params: CompletionParams,
    wire: OpenAIReasoningWire,
  ): number {
    if (this.isGateway) {
      return uncontrolledCallThinkingRoom(this.reasoningDialectKey(), params);
    }
    if (wire.kind === "none" || wire.effort === "none") return 0;
    const level = levelOfWireEffort(wire.effort);
    return REASONING_THINKING_BUDGET[level === "off" ? "low" : level];
  }

  /**
   * The answer and what the call reasoned. Gateways return the reasoning as
   * `reasoning` (OpenRouter, vLLM, Ollama) or `reasoning_content` (LiteLLM,
   * llama.cpp), some in both with the same text: one copy is kept.
   * `api.openai.com` returns none on this wire.
   *
   * #1276 — reasoning the server did not separate never becomes the answer:
   * an inline `<think>` block (or only its closing tag, when the chat
   * template opened it), or a reply that filled a ceiling sized for thinking
   * with unlabelled text (`answerOf`). Only a gateway's ceiling is sized that
   * way; `api.openai.com` never inlines its reasoning.
   */
  private separateReasoning(
    choice: OpenAIChoice | undefined,
    toolCalls: AiToolCall[] | undefined,
    request: { thinkingTokens: number; sent: string | null },
  ): { content: string; reasoning: string | null; hadReasoning: boolean } {
    const message = (choice?.message ?? {}) as Record<string, unknown>;
    const fielded = [message.reasoning, message.reasoning_content].find(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
    const raw = choice?.message?.content ?? "";
    const key = this.reasoningDialectKey();
    const asked = request.sent !== null && request.sent !== "none";
    const separated = answerOf(raw, {
      fieldedReasoning: fielded !== undefined,
      finishReason: choice?.finish_reason,
      hasToolCalls: toolCalls !== undefined,
      reasoningRoom: this.isGateway && request.thinkingTokens > 0,
      knownReasoner: knownReasoner(key, asked),
    });
    const hadReasoning = fielded !== undefined || separated.content !== raw;
    if (hadReasoning) noteReasoningSeen(key, asked);
    if (separated.unseparated) {
      emitSignal({
        action: "ai.gateway.reasoning_unseparated",
        level: "warn",
        meta: { provider: this.type },
      });
    }
    return {
      content: separated.content,
      reasoning: fielded ?? separated.reasoning,
      hadReasoning,
    };
  }

  /** #1279 — this endpoint and model refused the reasoning field. */
  private refusesField(): boolean {
    return refusesReasoningField(
      learnedReasoningDialect(this.reasoningDialectKey()),
    );
  }

  private reasoningDialectKey() {
    return {
      provider: "openai",
      endpoint: this.config.baseUrl,
      model: this.config.model,
    };
  }

  /**
   * The reasoning this request sends. Absent `params.reasoning` → none here
   * (the #1126 gateway setting is applied separately, unchanged).
   *
   * `api.openai.com` (operator key, personal key): `reasoning_effort` only for
   * a reasoning model, and only on a round without tools. Chat Completions
   * has no reasoning items to hand back between tool rounds, and newer
   * models restrict reasoning alongside function calls. The background jobs
   * carry no tools, which is where it counts; the Coach's final round
   * carries its tools with `tool_choice: "none"` (the history holds the
   * calls), so here it runs without `reasoning_effort` like its tool rounds.
   *
   * Gateway: the endpoint's own dialect, tools or not; its reasoning state
   * travels in `providerState`, and a refusal is learned per endpoint.
   */
  private planReasoning(
    params: CompletionParams,
    hasTools: boolean,
    capabilities: OpenAIChatCompletionsCapabilities,
  ): OpenAIReasoningWire {
    const reasoning = params.reasoning;
    const learned = learnedReasoningDialect(this.reasoningDialectKey());
    // #1267 — a gateway model that answered a reasoning request with
    // reasoning alone is asked with `none`, with or without a call level.
    if (this.isGateway && learned === ANSWERS_ONLY_UNREASONED) {
      return isOpenRouterEndpoint(this.config.baseUrl)
        ? { kind: "openrouter", effort: "none" }
        : { kind: "reasoning_effort", effort: "none" };
    }
    if (!reasoning) return { kind: "none" };
    if (refusesReasoningField(learned)) return { kind: "none" };
    const level = reasoning.effort;
    if (this.isGateway) {
      const effort = level === "off" ? "none" : level;
      return isOpenRouterEndpoint(this.config.baseUrl)
        ? { kind: "openrouter", effort }
        : { kind: "reasoning_effort", effort };
    }
    const family = openAIReasoningFamily(this.config.model);
    if (
      !family ||
      hasTools ||
      capabilities.tokenBudgetField !== "max_completion_tokens"
    ) {
      return { kind: "none" };
    }
    return {
      kind: "reasoning_effort",
      effort: level === "off" ? openAIOffEffort(family) : level,
    };
  }

  /**
   * Put the reasoning state of earlier tool rounds back on their assistant
   * messages. `buildOpenAIMessages` maps turn `i` to wire message `i + 1`
   * (the system turn leads). Only state this client made for this model is
   * used; anything else is dropped.
   */
  private withRoundTripState<T extends object>(
    wire: T[],
    params: CompletionParams,
  ): T[] {
    params.messages.forEach((m, i) => {
      const state = m.providerState;
      if (
        m.role !== "assistant" ||
        !state ||
        state.providerType !== this.type ||
        state.model !== this.config.model
      ) {
        return;
      }
      const target = wire[i + 1] as Record<string, unknown> | undefined;
      if (!target) return;
      for (const item of state.items) {
        if (!item || typeof item !== "object") continue;
        for (const field of ROUND_TRIP_FIELDS) {
          if (field in item) {
            target[field] = (item as Record<string, unknown>)[field];
          }
        }
      }
    });
    return wire;
  }
}
