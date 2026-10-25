import { callTimeoutMs } from "./effective-timeout";
import { annotate } from "@/lib/logging/context";
import { aiEgressPolicyFor } from "./local-host-allowlist";
import type { AIProvider, CompletionParams, CompletionResult } from "./types";
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
import { emptyReplyError, withStrictJsonPrefix } from "./local-wire";
import { RequestHops } from "./request-hops";
import { learnFromRefusal } from "./wire-refusal";
import type { ReasoningEffort } from "./reasoning-effort";
import {
  ANSWERS_ONLY_UNREASONED,
  learnedReasoningDialect,
  noteReasoningSeen,
  refusesReasoningField,
} from "./reasoning/dialect-cache";
import { uncontrolledThinkingRoom } from "./reasoning/levels";
import {
  askAgainUnreasoned,
  knownReasoner,
  reasonsUnasked,
  repeatUnreasoned,
} from "./reasoning/answerless";
import {
  ReasoningCollector,
  StreamedThinkSplitter,
  separateMessage,
  takeReasoning,
  type LocalReasoner,
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

/**
 * #470 — the per-endpoint JSON-mode dialect, learned at runtime in
 * `json-dialect.ts` (one cache keyed by base URL, shared with the gateway
 * client). The names stay exported here for this client's first consumers.
 */
type LocalJsonDialect = JsonModeDialect;

/** Test hook — clears the learned per-endpoint dialect cache. */
export const resetLocalJsonDialectCache = resetJsonModeDialectCache;

export { isResponseFormatRejection };

/**
 * #89 — the streaming path's absolute backstop. The real ceiling is the
 * per-idle-gap timer; this only stops a server that streams forever.
 */
const STREAM_ABSOLUTE_CEILING_MS = 10 * 60_000;

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
 * Tool calling degrades silently: most local servers reject an unknown
 * `tools` field, so the client never forwards it (`supportsTools`), and the
 * Coach's tool loop answers from base context. Prompt caching, where the
 * server has it (vLLM / Ollama prefix cache), is transparent.
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
      // #1279 — not once the endpoint refused the field.
      ...(!params.reasoning &&
      this.reasoningEffort &&
      callEffort === null &&
      this.sentReasoningEffort(params) !== null
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
    if (refusesReasoningField(learned)) return null;
    return params.reasoning.effort === "off" ? "none" : params.reasoning.effort;
  }

  /**
   * #1276 — what this endpoint and model have shown of their reasoning, for
   * one request (`LocalReasoner`). Seen on a request that asked to reason
   * counts only for requests that ask too.
   */
  private reasoner(params: CompletionParams, room: boolean): LocalReasoner {
    const key = this.reasoningDialectKey();
    const sent = this.sentReasoningEffort(params);
    const asked = sent !== null && sent !== "none";
    return {
      room,
      known: knownReasoner(key, asked),
      seen: () => noteReasoningSeen(key, asked),
    };
  }

  /**
   * The `reasoning_effort` this request carries, whichever level decided it:
   * the call's own (`callReasoningEffort`), else the entry's #1126 setting,
   * unless the endpoint refused the field (#1279).
   */
  private sentReasoningEffort(params: CompletionParams): string | null {
    const call = this.callReasoningEffort(params);
    if (call !== null || params.reasoning) return call;
    const learned = learnedReasoningDialect(this.reasoningDialectKey());
    return refusesReasoningField(learned) ? null : this.reasoningEffort;
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
   * to ask once more (#1279: at most once, and never again for a model whose
   * `none` reply was answerless too). False when the empty reply is final.
   */
  private learnAnswerlessReasoning(
    params: CompletionParams,
    hops: RequestHops,
    hadReasoning: boolean,
    finishReason: string | undefined,
  ): boolean {
    return (
      // The lesson holds even when the budget leaves no repeat for it.
      askAgainUnreasoned({
        key: this.reasoningDialectKey(),
        provider: "local",
        signals: "ai.local",
        sent: this.sentReasoningEffort(params),
        hadReasoning,
        finishReason,
      }) && hops.canSend
    );
  }

  /**
   * #1279 — the call once more with `none` (streamed when `onDelta` is
   * given), carrying this reply's spend; see `repeatUnreasoned`.
   */
  private askUnreasoned(
    params: CompletionParams,
    hops: RequestHops,
    reply: { hadReasoning: boolean; spent: number | null },
    onDelta?: (delta: string) => void,
  ): Promise<CompletionResult> {
    return repeatUnreasoned(
      onDelta
        ? this.generateCompletionStream(params, onDelta, hops)
        : this.generateCompletion(params, hops),
      reply.spent,
      () => emptyReplyError(reply.hadReasoning, reply.spent),
    );
  }

  /**
   * A non-2xx reply. A refused reasoning field or JSON flag is learned and
   * the call asked once more without it (`wire-refusal.ts`), and a refused
   * stream (`streamed`; some servers 400 on `stream` / `stream_options`)
   * once more buffered, while the call's request budget allows. Otherwise
   * the structured error; local endpoints and their proxies commonly leak
   * bearer tokens in error envelopes, so the excerpt is stripped first.
   */
  private async failed(
    res: Response,
    params: CompletionParams,
    hops: RequestHops,
    sent: { effort: string | null; json: boolean; streamed: boolean },
  ): Promise<CompletionResult> {
    const bodyExcerpt = sanitiseBodyExcerpt(await res.text().catch(() => ""));
    const lesson = learnFromRefusal({
      status: res.status,
      body: bodyExcerpt,
      model: this.config.model,
      reasoning: sent.effort
        ? {
            sent: sent.effort,
            key: this.reasoningDialectKey(),
            provider: "local",
            names: /reasoning|think/i,
          }
        : null,
      json: sent.json
        ? { endpoint: this.config.baseUrl, action: "ai.local.jsonDialect" }
        : null,
    });
    if ((lesson || sent.streamed) && hops.canSend) {
      return this.generateCompletion(params, hops);
    }
    throw Object.assign(new Error(`Local AI request failed (${res.status})`), {
      httpStatus: res.status,
      upstream: "local",
      model: this.config.model,
      baseUrl: this.config.baseUrl,
      bodyExcerpt,
      ...(lesson === "reasoning" ? { reasoningRefused: true } : {}),
    });
  }

  /**
   * `hops` is the call's request budget (`request-hops.ts`): a caller never
   * passes it, every repeat inside the call hands it on.
   */
  async generateCompletion(
    params: CompletionParams,
    hops: RequestHops = new RequestHops(),
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
    const res = await hops.fetch(
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
      return this.failed(res, params, hops, {
        effort: this.sentReasoningEffort(params),
        json:
          params.responseFormat === "json" && jsonDialect === "response_format",
        streamed: false,
      });
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
      this.reasoner(params, room),
    );
    if (!content) {
      const spent = json.usage?.total_tokens ?? null;
      if (this.learnAnswerlessReasoning(params, hops, hadReasoning, finish)) {
        return this.askUnreasoned(params, hops, { hadReasoning, spent });
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
   * A server that ignored the stream flag and answered buffered (or sent no
   * readable body): parsed like the non-streaming path rather than paying a
   * second round-trip, and the answer handed to `onDelta` whole.
   */
  private async bufferedInsteadOfStream(
    res: Response,
    params: CompletionParams,
    onDelta: (delta: string) => void,
    hops: RequestHops,
    room: boolean,
  ): Promise<CompletionResult> {
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
      this.reasoner(params, room),
    );
    if (!content) {
      const spent = json?.usage?.total_tokens ?? null;
      const finish = json?.choices?.[0]?.finish_reason;
      if (this.learnAnswerlessReasoning(params, hops, hadReasoning, finish)) {
        return this.askUnreasoned(
          params,
          hops,
          { hadReasoning, spent },
          onDelta,
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
    hops: RequestHops = new RequestHops(),
  ): Promise<CompletionResult> {
    const { url, headers, body, jsonDialect, room } = this.buildRequest(
      params,
      true,
    );
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
      res = await hops.fetch(
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
    } catch (err) {
      // Network / private-host / abort before the stream opened → fall back to
      // the buffered path, which surfaces the structured error the chain runner
      // understands (or succeeds on a server that simply doesn't stream).
      if (!hops.canSend) throw err;
      return this.generateCompletion(params, hops);
    }

    if (!res.ok) {
      return this.failed(res, params, hops, {
        effort: this.sentReasoningEffort(params),
        json:
          params.responseFormat === "json" && jsonDialect === "response_format",
        streamed: true,
      });
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream") || !res.body) {
      return this.bufferedInsteadOfStream(res, params, onDelta, hops, room);
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
    const splitter = new StreamedThinkSplitter(collector, (text) => {
      if (!text) return;
      collector.finish();
      content += text;
      onDelta(text);
    });

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
          if (delta) splitter.push(delta);
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

    const { unclosed } = splitter.end();
    // #1276 — a lone `</think>`, or unlabelled text that filled the ceiling.
    // Sent deltas are a liveness signal only; the guards read `content`.
    const reasoner = this.reasoner(params, room);
    const tail = takeReasoning(collector, content, {
      fieldedReasoning: streamedReasoning,
      finishReason,
      reasoner,
    });
    if (streamedReasoning || splitter.opened || tail.took) reasoner.seen();
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
      const hadReasoning = streamedReasoning || unclosed || tail.took;
      if (
        this.learnAnswerlessReasoning(params, hops, hadReasoning, finishReason)
      ) {
        return this.askUnreasoned(
          params,
          hops,
          { hadReasoning, spent: tokensUsed },
          onDelta,
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
