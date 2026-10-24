import { safeFetch } from "@/lib/safe-fetch";
import { callTimeoutMs } from "./effective-timeout";
import { annotate } from "@/lib/logging/context";
import { aiEgressPolicyFor } from "./local-host-allowlist";
import type {
  AIProvider,
  AiMessage,
  CompletionParams,
  CompletionResult,
} from "./types";
import {
  buildOpenAIMessages,
  mapFinishReason,
  parseCachedTokens,
  raiseEmbeddedError,
  readEmbeddedError,
  sanitiseBodyExcerpt,
} from "./openai-wire";
import {
  hasLearnedJsonModeDialect,
  isResponseFormatRejection,
  jsonModeDialectFor,
  rememberJsonModeDialect,
  resetJsonModeDialectCache,
  type JsonModeDialect,
} from "./json-dialect";
import type { ReasoningEffort } from "./reasoning-effort";
import { emitSignal } from "@/lib/logging/signal";
import {
  ANSWERS_ONLY_UNREASONED,
  annotateReasoningDowngrade,
  isReasoningParameterRejection,
  learnedReasoningDialect,
  rememberReasoningDialect,
} from "./reasoning/dialect-cache";
import { uncontrolledThinkingRoom } from "./reasoning/levels";
import {
  nextAnswerlessStep,
  reasonsUnasked,
  withEarlierSpend,
} from "./reasoning/answerless";
import {
  ReasoningCollector,
  separateMessage,
  takeReasoning,
} from "./local-reasoning";

interface LocalClientConfig {
  apiKey?: string | null;
  model: string;
  baseUrl: string;
  /**
   * v1.39.3 — true when the base URL belongs to the operator: the
   * instance-wide admin provider, or provider settings saved on an admin
   * account. Only such a URL is still covered by the deprecated
   * `ALLOW_LOCAL_AI_PRIVATE_HOSTS=true` (see `local-host-allowlist.ts`).
   */
  operatorTrusted?: boolean;
}

const STRICT_JSON_PREFIX =
  "Return strict JSON only, no markdown, no commentary.\n\n";

/**
 * v1.28.28 (#470) — per-endpoint JSON-mode dialect, learned at runtime.
 * v1.33.1 — the machinery moved to `json-dialect.ts` when the
 * OpenAI-compatible gateway provider needed the same learning; the two
 * clients share one cache keyed by base URL. The names below stay exported
 * from here because this client's tests and call sites were the first
 * consumers.
 */
type LocalJsonDialect = JsonModeDialect;

/** Test hook — clears the learned per-endpoint dialect cache. */
export const resetLocalJsonDialectCache = resetJsonModeDialectCache;

export { isResponseFormatRejection };

/**
 * v1.22 (#89) — absolute backstop for the streaming path. The real ceiling is
 * the per-idle-gap timer (`CompletionParams.timeoutMs`); this only stops a
 * server that streams forever from pinning a worker. Ten minutes is far beyond
 * any legitimate single Coach turn.
 */
const STREAM_ABSOLUTE_CEILING_MS = 10 * 60_000;

/**
 * Prepend the strict-JSON instruction to the FIRST user turn's text. Local
 * model templates respect an in-message instruction reliably, so it is sent
 * in BOTH dialects — it is the only JSON steering left when an endpoint
 * rejects `response_format` (dialect `"none"`). Mirrors the pre-refactor
 * behaviour, which prepended to the single user prompt.
 */
function withStrictJsonPrefix(messages: AiMessage[]): AiMessage[] {
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
function emptyReplyError(hadReasoning: boolean, spent: number | null): Error {
  const err = new Error(
    hadReasoning
      ? "Local AI returned reasoning but no answer"
      : "Local AI returned empty content",
  );
  Object.assign(err, {
    httpStatus: 0,
    kind: hadReasoning ? "reasoning_only" : "empty_response",
    upstream: "local",
    // #1279 — what the reply cost, so the day's ledger charges it instead of
    // refunding a call that was paid for.
    ...(spent !== null ? { tokensUsed: spent } : {}),
  });
  return err;
}

/**
 * Talks to OpenAI-compatible servers: local runtimes (Ollama, LocalAI,
 * LM Studio, vLLM, …) AND hosted gateways (LiteLLM, OpenRouter, any
 * `/v1/chat/completions` endpoint with an optional Bearer key). Same wire
 * format as OpenAI; JSON surfaces send the standard
 * `response_format: { type: "json_object" }` by default and self-heal to a
 * no-flag dialect per endpoint when the server rejects the field (see
 * `LocalJsonDialect` above). The strict-JSON instruction prepended to the
 * user message stays in both dialects.
 *
 * v1.20.0 — tool-calling DEGRADES silently here: most local servers reject an
 * unknown `tools` field, so the client never forwards it (capability flag
 * below). F1's tool loop must therefore tolerate a provider that never returns
 * `toolCalls` and answer from base context. Prompt-caching, where the local
 * server supports it (vLLM / Ollama prefix cache), is transparent — no flag,
 * no harm.
 */
export class LocalOpenAICompatibleClient implements AIProvider {
  readonly type = "local" as const;
  /** See `AIProvider.responseTimeoutSeconds`; stamped by the resolver. */
  responseTimeoutSeconds: number | null = null;
  /** See `AIProvider.reasoningEffort`; stamped by the resolver. */
  reasoningEffort: ReasoningEffort | null = null;
  /** Local servers commonly reject an unknown `tools` field — never send it. */
  readonly supportsTools = false;
  private config: LocalClientConfig;

  constructor(config: LocalClientConfig) {
    this.config = config;
  }

  /**
   * Build the shared request shape (url + headers + body) for both the
   * buffered and the streaming paths. `stream` adds the OpenAI-compatible
   * `stream: true` + `stream_options.include_usage` so the final SSE chunk
   * carries the token total.
   */
  private buildRequest(
    params: CompletionParams,
    stream: boolean,
  ): {
    url: string;
    headers: Record<string, string>;
    body: string;
    jsonDialect: LocalJsonDialect;
    /** The ceiling holds room for reasoning on top of the answer. */
    room: boolean;
  } {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    // v1.28.28 (#470) — per-endpoint JSON dialect (see json-dialect.ts).
    const jsonDialect = jsonModeDialectFor(this.config.baseUrl);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    // Some local servers (LM Studio with auth, vLLM behind a proxy) require a
    // bearer; Ollama does not. Send the header only when an actual key is set.
    const trimmedKey = this.config.apiKey?.trim();
    if (trimmedKey) {
      headers.Authorization = `Bearer ${trimmedKey}`;
    }

    // System turn first, then the conversation turns (with the strict-JSON
    // instruction folded into the first user turn). Vision parts (Lab-OCR)
    // become the OpenAI-compatible `image_url` content array that llava /
    // llama-vision models accept over the same endpoint. The image is framed
    // as untrusted DATA by the system prompt.
    const messages = buildOpenAIMessages(
      params.system,
      withStrictJsonPrefix(params.messages),
    );

    const callEffort = this.callReasoningEffort(params);
    // Reasoning tokens count against `max_tokens` on these servers; the
    // thinking budget rides on top of the answer budget (a ceiling only).
    // #1276 — by the call's level, not by what the wire says: a model may
    // reason whatever `reasoning_effort` asks, `none` included, and the
    // `none` sent for Off or after the #1267 lesson must not leave it the
    // bare answer budget to think in. A call without a level gets the `low`
    // room once the model has shown it reasons unasked.
    const thinkingTokens = params.reasoning
      ? uncontrolledThinkingRoom(params.reasoning.effort)
      : reasonsUnasked(this.reasoningDialectKey())
        ? uncontrolledThinkingRoom("off")
        : 0;
    const body = JSON.stringify({
      model: this.config.model,
      messages,
      temperature: params.temperature ?? 0.3,
      max_tokens: (params.maxTokens ?? 1000) + thinkingTokens,
      // Deterministic seed for reproducible reference output. Ollama +
      // most OpenAI-compatible local servers honour it; servers that
      // ignore it simply disregard the field. Omitted when unset.
      ...(params.seed !== undefined ? { seed: params.seed } : {}),
      // #1126 — the entry's reasoning setting. Default sends nothing, so the
      // body of a setup that never touched it stays byte-identical; "Off" is
      // `none`, which stops a thinking model spending the answer budget.
      // v1.41 — a call that carries its own resolved level wins over it.
      // #1267 — once a model answered nothing while reasoning, the entry's
      // setting gives way to the `none` that `callReasoningEffort` sends.
      ...(!params.reasoning && this.reasoningEffort && callEffort === null
        ? { reasoning_effort: this.reasoningEffort }
        : {}),
      ...(callEffort ? { reasoning_effort: callEffort } : {}),
      // v1.28.28 (#470) — the JSON surfaces opt in via `responseFormat:
      // "json"`. Default dialect sends the STANDARD OpenAI field (the
      // top-level Ollama-native `format: "json"` this client used to send
      // 400s on strict OpenAI-compatible gateways — LiteLLM / OpenRouter /
      // vLLM — and never belonged on the /chat/completions wire). An
      // endpoint that rejects `response_format` is flipped to the no-flag
      // dialect and retried once (see generateCompletion).
      ...(params.responseFormat === "json" && jsonDialect === "response_format"
        ? { response_format: { type: "json_object" } }
        : {}),
      // v1.22 (#89) — streaming opt-in. `stream_options.include_usage` asks
      // OpenAI-compatible servers (vLLM / LM Studio / exo) to append a final
      // chunk carrying the usage block so the token footer survives streaming.
      ...(stream
        ? { stream: true, stream_options: { include_usage: true } }
        : {}),
    });

    return {
      url,
      headers,
      body,
      jsonDialect,
      room: thinkingTokens > 0,
    };
  }

  private reasoningDialectKey() {
    return {
      provider: "local",
      endpoint: this.config.baseUrl,
      model: this.config.model,
    };
  }

  /**
   * The `reasoning_effort` a call with its own resolved level sends (`off`
   * is `none`), unless this endpoint refused the field before. `null` for a
   * call without one: the entry's #1126 setting applies, exactly as before.
   */
  private callReasoningEffort(params: CompletionParams): string | null {
    const learned = learnedReasoningDialect(this.reasoningDialectKey());
    // #1267 — this endpoint and model answered a reasoning request with
    // nothing but reasoning: every call asks with `none` until the lesson
    // expires, a call without a level of its own included.
    if (learned === ANSWERS_ONLY_UNREASONED) return "none";
    if (!params.reasoning) return null;
    if (learned === "none") return null;
    return params.reasoning.effort === "off" ? "none" : params.reasoning.effort;
  }

  /**
   * The `reasoning_effort` this request carries, whichever level decided it:
   * the call's own (`callReasoningEffort`), else the entry's #1126 setting.
   */
  private sentReasoningEffort(params: CompletionParams): string | null {
    return (
      this.callReasoningEffort(params) ??
      (params.reasoning ? null : this.reasoningEffort)
    );
  }

  /**
   * #1267 — a reply with reasoning and no answer. Ollama serves thinking
   * models (Gemma 4 among them) on `/v1/chat/completions` with the thought in
   * a separate `reasoning` field, and a long thought can leave `content`
   * empty: the thought used the whole token budget, or the answer itself was
   * parsed into `reasoning`. The same model asked with `reasoning_effort:
   * "none"` answers in `content`. So when a request that did not already say
   * `none` comes back empty with reasoning (or after asking to reason), learn
   * that this endpoint and model answer only unreasoned, and tell the caller
   * to ask once more. Returns false when the empty reply is final.
   *
   * #1279 — once per call, and a model whose `none` reply was answerless too
   * is not asked with `none` again while the lesson holds
   * (`reasoning/answerless.ts`).
   */
  private learnAnswerlessReasoning(
    params: CompletionParams,
    hadReasoning: boolean,
    finishReason: string | undefined,
  ): boolean {
    const sent = this.sentReasoningEffort(params);
    const finish =
      finishReason === "length" || finishReason === "stop"
        ? finishReason
        : "other";
    const step = nextAnswerlessStep(
      this.reasoningDialectKey(),
      sent,
      hadReasoning,
    );
    if (step.kind === "final") {
      if (step.learnedRegardless) {
        emitSignal({
          action: "ai.local.reasoning_unswitchable",
          level: "warn",
          meta: { finish },
        });
      }
      return false;
    }
    annotateReasoningDowngrade("local", sent ?? "default", "none");
    emitSignal({
      action: "ai.local.reasoning_answerless",
      level: "warn",
      meta: {
        effort: sent ?? "default",
        finish,
        reasoning: hadReasoning,
      },
    });
    return true;
  }

  async generateCompletion(
    params: CompletionParams,
  ): Promise<CompletionResult> {
    const { url, headers, body, jsonDialect, room } = this.buildRequest(
      params,
      false,
    );

    // safeFetch defaults: no redirect-follow (the local endpoint is the
    // most exploitable on this surface — a user-controlled baseUrl that
    // 302s to 169.254.169.254 would otherwise leak the bearer on the
    // redirected hop into the visible error envelope via `bodyExcerpt`)
    // and an explicit 60 s ceiling so a stalled GPU or tar-pit proxy
    // can't pin a worker indefinitely. `requirePublicHost` gates the
    // baseUrl against the input-time SSRF allowlist; the dispatcher
    // pin (issue #217) extends the same flag with a connect-time
    // resolved-IP check to also defeat DNS rebinding. Operators who
    // legitimately point at a self-hosted Ollama / LM Studio on an
    // RFC1918 address opt in via `AI_PRIVATE_ORIGINS` (exact origins) or the
    // legacy host list. A granted origin is dialled through the pinned
    // operator-approved dispatcher, never unpinned, so the metadata range and
    // link-local stay unreachable even for a granted name (v1.39.3). Enforced
    // at write-time in /api/user/ai-provider too.
    const egress = aiEgressPolicyFor(url, {
      operatorTrusted: this.config.operatorTrusted,
    });
    const res = await safeFetch(
      url,
      {
        method: "POST",
        headers,
        body,
      },
      // v1.20.1 — compose the caller's cancel signal (Coach SSE disconnect) so
      // a mid-generation abort tears the upstream call down early.
      {
        // The record owner's response-timeout setting, else the surface value, else 60 s.
        timeoutMs: callTimeoutMs(params, this.responseTimeoutSeconds),
        ...egress,
        signal: params.signal,
      },
    );

    if (!res.ok) {
      // Mirror the openai-client structured-error pattern. Local endpoints
      // also commonly leak bearer tokens in error envelopes (proxies), so
      // strip anything that looks like a key before logging.
      const rawBody = await res.text().catch(() => "");
      const bodyExcerpt = sanitiseBodyExcerpt(rawBody);
      // v1.41 — a server that refuses the reasoning field is asked once more
      // without it and remembers. Before the JSON dialect, so a complaint
      // about reasoning never switches JSON mode off.
      const sentEffort = this.callReasoningEffort(params);
      if (
        sentEffort &&
        isReasoningParameterRejection(
          res.status,
          bodyExcerpt,
          /reasoning|think/i,
          this.config.model,
        )
      ) {
        rememberReasoningDialect(this.reasoningDialectKey(), "none");
        annotateReasoningDowngrade("local", sentEffort, "none");
        return this.generateCompletion(params);
      }
      // v1.28.28 (#470) — dialect self-heal. A 4xx whose body names
      // `response_format` (or an unknown parameter) means this endpoint
      // rejects the standard JSON flag: learn the no-flag dialect for the
      // baseUrl and retry ONCE without it (the recursion terminates because
      // the cached dialect is now "none"). Unrelated 4xx/5xx errors are not
      // retried.
      if (
        params.responseFormat === "json" &&
        jsonDialect === "response_format" &&
        isResponseFormatRejection(res.status, bodyExcerpt)
      ) {
        rememberJsonModeDialect(this.config.baseUrl, "none");
        annotate({
          action: { name: "ai.local.jsonDialect" },
          meta: { dialect: "none", httpStatus: res.status },
        });
        return this.generateCompletion(params);
      }
      const err = new Error(`Local AI request failed (${res.status})`);
      Object.assign(err, {
        httpStatus: res.status,
        upstream: "local",
        model: this.config.model,
        baseUrl: this.config.baseUrl,
        bodyExcerpt,
      });
      throw err;
    }

    // v1.28.28 (#470) — the standard `response_format` request succeeded:
    // pin the dialect for this endpoint so a later transient 4xx can never
    // silently degrade it back.
    if (
      params.responseFormat === "json" &&
      jsonDialect === "response_format" &&
      !hasLearnedJsonModeDialect(this.config.baseUrl)
    ) {
      rememberJsonModeDialect(this.config.baseUrl, "response_format");
      annotate({
        action: { name: "ai.local.jsonDialect" },
        meta: { dialect: "response_format" },
      });
    }

    const json = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string;
      }>;
      usage?: {
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };

    // Same embedded-failure shape the OpenAI-compatible gateway tag handles:
    // this client serves hosted gateways too (the class doc above names
    // LiteLLM and OpenRouter), and those answer a provider-side refusal with
    // HTTP 200 and the failure inside the body. Unconditional here — every
    // base URL on this provider was typed by a person, there is no pinned
    // vendor endpoint whose behaviour has to stay untouched.
    raiseEmbeddedError(json, {
      upstream: "local",
      label: "local AI endpoint",
      model: this.config.model,
    });

    const finish = json.choices?.[0]?.finish_reason;
    const { content, hadReasoning, collector } = separateMessage(
      params,
      json.choices?.[0]?.message,
      finish,
      room,
    );
    if (!content) {
      const spent = json.usage?.total_tokens ?? null;
      if (this.learnAnswerlessReasoning(params, hadReasoning, finish)) {
        return withEarlierSpend(this.generateCompletion(params), spent);
      }
      // The reasoning that did arrive still reaches `onReasoning`, as before.
      collector.result(
        json.usage?.completion_tokens_details?.reasoning_tokens ?? null,
      );
      // v1.20.1 — sentinel httpStatus + kind so the chain classifier can tell
      // an empty 200-OK reply apart from a transport failure. Cascade unchanged
      // (`status <= 0` is already a hard failure).
      throw emptyReplyError(hadReasoning, spent);
    }
    const reasoning = collector.result(
      json.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    );

    return {
      content,
      tokensUsed: json.usage?.total_tokens ?? null,
      // v1.41.2 — llama.cpp, vLLM and the hosted gateways this client also
      // serves report a prompt-cache hit the Chat Completions way; without it
      // the Coach turn budget counted a cached prefix in full. Ollama sends
      // none, which leaves it null.
      cachedInputTokens: parseCachedTokens(json),
      model: this.config.model,
      providerType: "local",
      // v1.28.28 (#470) — surface why the model stopped so the JSON callers
      // can tell a token-ceiling truncation ("length") from bad output.
      finishReason: mapFinishReason(finish),
      ...(reasoning ? { reasoning } : {}),
    };
  }

  /**
   * v1.22 (#89) — true token streaming over the OpenAI-compatible
   * `stream: true` wire. POSTs with `stream: true`, reads the SSE response body
   * incrementally, and emits each `choices[0].delta.content` chunk through
   * `onDelta` as it arrives. The returned `CompletionResult` carries the FULL
   * assembled reply so every downstream guard still runs on the complete text.
   *
   * Timeout model: per-IDLE-gap, not whole-call. An idle timer (`timeoutMs`,
   * default 60 s) is armed before the request and reset on every chunk, so a
   * slow first token (an MLX/exo server loading the model) and a long total
   * generation are both fine as long as bytes keep flowing. A genuine stall
   * (no byte for the idle window) aborts the upstream. A generous absolute
   * ceiling backstops a server that streams forever.
   *
   * Graceful fallback: a server that rejects `stream: true` (non-2xx), or
   * ignores it and returns a buffered JSON body, or has no readable stream
   * body, degrades to the non-streaming {@link generateCompletion} path. The
   * Coach gets real tokens where the backend supports streaming and identical
   * behaviour where it does not.
   */
  async generateCompletionStream(
    params: CompletionParams,
    onDelta: (delta: string) => void,
  ): Promise<CompletionResult> {
    const { url, headers, body, room } = this.buildRequest(params, true);
    const egress = aiEgressPolicyFor(url, {
      operatorTrusted: this.config.operatorTrusted,
    });

    // Idle controller: aborts the upstream when no chunk arrives within the
    // per-idle window. Composed with the caller's cancel signal so a client
    // disconnect still tears the call down immediately.
    const idle = new AbortController();
    const idleMs = callTimeoutMs(params, this.responseTimeoutSeconds);
    const signal = params.signal
      ? AbortSignal.any([params.signal, idle.signal])
      : idle.signal;

    let res: Response;
    try {
      res = await safeFetch(
        url,
        { method: "POST", headers, body },
        {
          // Absolute backstop only — the per-idle timer below is the real
          // ceiling. A server that streams forever still cannot pin a worker.
          timeoutMs: STREAM_ABSOLUTE_CEILING_MS,
          ...egress,
          signal,
        },
      );
    } catch {
      // Network / private-host / abort before the stream opened → fall back to
      // the buffered path, which surfaces the structured error the chain runner
      // understands (or succeeds on a server that simply doesn't stream).
      return this.generateCompletion(params);
    }

    if (!res.ok) {
      // The server rejected the streaming request (some servers 400 on
      // `stream`/`stream_options`). Retry once on the buffered path so a
      // non-streaming server still works and surfaces its real status.
      return this.generateCompletion(params);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream") || !res.body) {
      // The server ignored the stream flag and returned a buffered completion
      // (or there is no readable body). Parse it like the non-streaming path
      // rather than paying a second round-trip.
      const json = (await res.json().catch(() => null)) as {
        choices?: Array<{
          message?: { content?: string };
          finish_reason?: string;
        }>;
        usage?: {
          total_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
      } | null;
      // The server ignored `stream` and answered buffered — the embedded
      // failure can ride this body exactly as it rides the non-streaming one.
      raiseEmbeddedError(json, {
        upstream: "local",
        label: "local AI endpoint",
        model: this.config.model,
      });
      const { content, hadReasoning, collector } = separateMessage(
        params,
        json?.choices?.[0]?.message,
        json?.choices?.[0]?.finish_reason,
        room,
      );
      if (!content) {
        const spent = json?.usage?.total_tokens ?? null;
        if (
          this.learnAnswerlessReasoning(
            params,
            hadReasoning,
            json?.choices?.[0]?.finish_reason,
          )
        ) {
          return withEarlierSpend(
            this.generateCompletionStream(params, onDelta),
            spent,
          );
        }
        collector.result(null);
        throw emptyReplyError(hadReasoning, spent);
      }
      const reasoning = collector.result(null);
      onDelta(content);
      return {
        content,
        tokensUsed: json?.usage?.total_tokens ?? null,
        cachedInputTokens: json ? parseCachedTokens(json) : null,
        model: this.config.model,
        providerType: "local",
        finishReason: mapFinishReason(json?.choices?.[0]?.finish_reason),
        ...(reasoning ? { reasoning } : {}),
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let content = "";
    let tokensUsed: number | null = null;
    let cachedInputTokens: number | null = null;
    let reasoningTokens: number | null = null;
    let finishReason: string | undefined;

    // v1.41 — reasoning on the stream: the `reasoning_content` / `reasoning`
    // delta fields, or a leading `<think>` block inside `content`. Inline
    // reasoning never reaches `onDelta`; it would otherwise show up as the
    // answer. #1276 — for every caller (only one that asked is told).
    const collector = new ReasoningCollector(params);
    let thinkState: "detect" | "inside" | "passthrough" = "detect";
    let pending = "";
    const passContent = (text: string) => {
      if (!text) return;
      collector.finish();
      content += text;
      onDelta(text);
    };
    const onContent = (delta: string) => {
      if (thinkState === "passthrough") {
        passContent(delta);
        return;
      }
      pending += delta;
      if (thinkState === "detect") {
        const lead = pending.replace(/^\s+/, "");
        if (lead.length < "<think>".length && "<think>".startsWith(lead)) {
          return;
        }
        if (!lead.startsWith("<think>")) {
          thinkState = "passthrough";
          const out = pending;
          pending = "";
          passContent(out);
          return;
        }
        thinkState = "inside";
        pending = lead.slice("<think>".length);
      }
      const close = pending.indexOf("</think>");
      if (close === -1) return;
      collector.add(pending.slice(0, close));
      collector.finish();
      const rest = pending.slice(close + "</think>".length).replace(/^\s+/, "");
      pending = "";
      thinkState = "passthrough";
      passContent(rest);
    };

    // An SSE frame can carry the same embedded failure the buffered body
    // carries. Remember the first one; it only matters if the stream ends
    // without a single token, in which case it is the honest reason.
    let streamedError: unknown = null;
    // #1267 — whether any reasoning arrived, asked for or not.
    let streamedReasoning = false;

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(), idleMs);
    };
    armIdle();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle();
        sseBuffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; each frame is one or more
        // `data:` lines. Split on newlines and process complete lines, keeping
        // any partial trailing line in the buffer.
        let nl: number;
        while ((nl = sseBuffer.indexOf("\n")) !== -1) {
          const line = sseBuffer.slice(0, nl).trim();
          sseBuffer = sseBuffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice("data:".length).trim();
          if (!payload || payload === "[DONE]") continue;
          let chunk: {
            error?: unknown;
            choices?: Array<{
              delta?: {
                content?: string;
                reasoning_content?: string;
                reasoning?: string;
              };
              finish_reason?: string | null;
              error?: unknown;
            }>;
            usage?: {
              total_tokens?: number;
              prompt_tokens_details?: { cached_tokens?: number };
              completion_tokens_details?: { reasoning_tokens?: number };
            };
          };
          try {
            chunk = JSON.parse(payload);
          } catch {
            // A malformed chunk line is skipped, not fatal — keep reading.
            continue;
          }
          if (streamedError === null && readEmbeddedError(chunk) !== null) {
            streamedError = chunk;
          }
          const choiceDelta = chunk.choices?.[0]?.delta;
          const reasoningDelta =
            choiceDelta?.reasoning_content ?? choiceDelta?.reasoning;
          if (typeof reasoningDelta === "string" && reasoningDelta.trim()) {
            streamedReasoning = true;
          }
          if (params.reasoning && typeof reasoningDelta === "string") {
            collector.add(reasoningDelta);
          }
          const delta = choiceDelta?.content;
          if (delta) onContent(delta);
          if (typeof chunk.usage?.total_tokens === "number") {
            tokensUsed = chunk.usage.total_tokens;
          }
          const cached = chunk.usage?.prompt_tokens_details?.cached_tokens;
          if (typeof cached === "number") cachedInputTokens = cached;
          const rt = chunk.usage?.completion_tokens_details?.reasoning_tokens;
          if (typeof rt === "number") reasoningTokens = rt;
          const chunkFinish = chunk.choices?.[0]?.finish_reason;
          if (typeof chunkFinish === "string") finishReason = chunkFinish;
        }
      }
    } catch (err) {
      // An abort (idle stall or client disconnect) mid-stream: if we already
      // assembled usable prose, return it — the user got a real (if clipped)
      // answer and every guard still runs on it. With nothing assembled, this
      // is a hard transport failure for the chain runner to cascade on.
      if (!content) {
        const e = new Error("Local AI stream failed before any content");
        Object.assign(e, {
          httpStatus: 0,
          kind: "stream_aborted",
          upstream: "local",
          cause: err,
        });
        throw e;
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      reader.cancel().catch(() => {});
    }

    // A reply short enough to still sit in the `<think>` detector is prose;
    // an unclosed block is reasoning that ran out of budget.
    // (The closures above move `thinkState`; read it afresh.)
    const endState = thinkState as "detect" | "inside" | "passthrough";
    if (endState === "detect") {
      thinkState = "passthrough";
      passContent(pending);
    } else if (endState === "inside") {
      collector.add(pending);
    }
    pending = "";
    // #1276 — a lone `</think>`, or unlabelled text that filled the ceiling.
    // Sent deltas are a liveness signal only; the guards read `content`.
    const tail = takeReasoning(collector, content, {
      fieldedReasoning: streamedReasoning,
      finishReason,
      reasoningRoom: room,
    });
    content = tail.content;
    if (!content) {
      // A stream that ended with a failure frame and no token reports the
      // failure, not "empty content".
      raiseEmbeddedError(streamedError, {
        upstream: "local",
        label: "local AI endpoint",
        model: this.config.model,
      });
      // An unclosed inline `<think>` block is reasoning too.
      const hadReasoning =
        streamedReasoning || endState === "inside" || tail.took;
      if (this.learnAnswerlessReasoning(params, hadReasoning, finishReason)) {
        return withEarlierSpend(
          this.generateCompletionStream(params, onDelta),
          tokensUsed,
        );
      }
      collector.result(reasoningTokens);
      throw emptyReplyError(hadReasoning, tokensUsed);
    }
    const reasoning = collector.result(reasoningTokens);

    return {
      content,
      tokensUsed,
      cachedInputTokens,
      model: this.config.model,
      providerType: "local",
      finishReason: mapFinishReason(finishReason),
      ...(reasoning ? { reasoning } : {}),
    };
  }
}
