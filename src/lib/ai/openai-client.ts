import { safeFetch } from "@/lib/safe-fetch";
import { annotate } from "@/lib/logging/context";
import type { AIProvider, CompletionParams, CompletionResult } from "./types";
import { selectOpenAIChatCompletionsCapabilities } from "./openai-capabilities";
import {
  hasLearnedJsonModeDialect,
  isResponseFormatRejection,
  jsonModeDialectFor,
  rememberJsonModeDialect,
} from "./json-dialect";
import { requirePublicHostFor } from "./local-host-allowlist";
import {
  buildOpenAIMessages,
  buildOpenAITools,
  mapFinishReason,
  parseCachedTokens,
  parseOpenAIToolCalls,
  raiseEmbeddedError,
  sanitiseBodyExcerpt,
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
}

type OpenAIProviderType = "admin-key" | "codex" | "openai-compatible";

export class OpenAIClient implements AIProvider {
  readonly type: OpenAIProviderType;
  private config: OpenAIClientConfig;

  constructor(config: OpenAIClientConfig) {
    this.config = config;
    this.type = config.providerType ?? "admin-key";
  }

  /**
   * True only for the user-configured gateway. Read it as "the base URL came
   * from a person, not from this repository" — every behaviour that must not
   * change for `api.openai.com` is gated on it.
   */
  private get isGateway(): boolean {
    return this.type === "openai-compatible";
  }

  async generateCompletion(
    params: CompletionParams,
  ): Promise<CompletionResult> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;

    // System turn first (the stable cache prefix — OpenAI prefix-caches a
    // byte-identical ≥1024-token prefix automatically, no API flag), then the
    // conversation turns mapped 1:1. Vision parts (Lab-OCR) become the
    // multimodal `image_url` content array `gpt-4o`-class models accept. The
    // image is framed as untrusted DATA by the system prompt.
    const messages = buildOpenAIMessages(params.system, params.messages);

    // v1.20.0 — tool plumbing. The defs map onto the OpenAI `function` tool
    // wire; F1 supplies real defs and consumes the parsed `toolCalls`. No F4
    // call site sets `tools`, so the text-only body is unchanged.
    const hasTools = !!params.tools && params.tools.length > 0;
    const tools = hasTools ? buildOpenAITools(params.tools!) : undefined;

    // Only force OpenAI's strict JSON mode when the caller actually consumes a
    // JSON object AND no tools are in play — mirrors the Anthropic client's
    // `usePrefill` gate. JSON mode coerces `message.content` into a valid JSON
    // object, which contradicts the Coach prose contract; the F1 tool loop's
    // forced-final round (toolChoice:"none", no tools, no responseFormat) must
    // therefore stay out of JSON mode, and every tool round is non-JSON by
    // construction. Insight/extraction callers opt in with `responseFormat:"json"`.
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
    const tokenBudget = params.maxTokens ?? 1000;
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

    const res = await safeFetch(
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
        }),
      },
      // 60 s ceiling so a tar-pit upstream cannot pin a worker
      // indefinitely. Real completions land well inside this budget.
      // v1.11.2 — the base URL is user/admin-overridable (BYO gateway), so pin
      // the connect-time DNS check: a base URL resolving to a private/metadata
      // address is rejected, closing the SSRF/rebinding surface.
      // v1.20.1 — compose the caller's cancel signal (Coach SSE disconnect) so
      // a mid-generation abort tears the upstream call down early.
      // v1.21.5 — honour the caller's per-request timeout override; default 60 s.
      // v1.33.1 (#470) — the gateway tag reuses the Local provider's host
      // policy verbatim: public hosts always; a private host only when the
      // operator allowlisted it via ALLOW_LOCAL_AI_PRIVATE_HOSTS.
      //
      // v1.37.30 — the `admin-key` tag consults the same policy. Its base URL
      // is the one other operator-typed URL in this client (an operator can
      // point the global provider at a private OpenAI-compatible proxy, e.g.
      // an OAuth sidecar), and both ends of the grant are the operator's own:
      // the URL comes from the admin settings, the allowlist from the
      // operator's environment. Every non-operator construction of this tag
      // pins the public `api.openai.com` constant, for which the policy
      // resolves to `true` without ever consulting the allowlist — so the
      // personal-key posture is unchanged. The `codex` tag keeps the hard
      // pin: its base URL is a repository constant, there is nothing an
      // operator legitimately redirects.
      {
        timeoutMs: params.timeoutMs ?? 60_000,
        requirePublicHost:
          this.isGateway || this.type === "admin-key"
            ? requirePublicHostFor(this.config.baseUrl)
            : true,
        signal: params.signal,
      },
    );

    if (!res.ok) {
      // Pull as much of the body as we can so upstream incidents (OpenAI 5xx,
      // model-not-found, quota exceeded) are diagnosable from logs instead of
      // surfacing as an opaque "OpenAI request failed (500)". Strip anything
      // that looks like an API key from the excerpt before logging.
      const rawBody = await res.text().catch(() => "");
      const bodyExcerpt = sanitiseBodyExcerpt(rawBody);
      // v1.33.1 (#470) — dialect self-heal, gateway only. A 4xx whose body
      // names `response_format` (or an unknown parameter) means this endpoint
      // rejects the standard JSON flag: learn the no-flag dialect for the base
      // URL and retry ONCE without it. The recursion terminates because the
      // cached dialect is now "none". Unrelated 4xx/5xx errors are not retried
      // and surface as the structured error they always were.
      if (
        this.isGateway &&
        sendJsonFormat &&
        isResponseFormatRejection(res.status, bodyExcerpt)
      ) {
        rememberJsonModeDialect(this.config.baseUrl, "none");
        annotate({
          action: { name: "ai.compat.jsonDialect" },
          meta: { dialect: "none", httpStatus: res.status },
        });
        return this.generateCompletion(params);
      }
      const err = new Error(
        `${this.isGateway ? "OpenAI-compatible gateway" : "OpenAI"} request failed (${res.status})`,
      );
      // Keep the body in a structured field rather than the message so
      // Error.message stays short and the excerpt lands in dedicated log
      // fields (bodyExcerpt) that can be filtered/truncated centrally.
      Object.assign(err, {
        httpStatus: res.status,
        upstream: this.isGateway ? "openai-compatible" : "openai",
        model: this.config.model,
        bodyExcerpt,
      });
      throw err;
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
    let content = choice?.message?.content;
    const toolCalls = parseOpenAIToolCalls(choice);

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
    const trimmedContent = content?.trim() ?? "";
    if (useJsonFormat && (trimmedContent === "" || trimmedContent === "{}")) {
      const args = choice?.message?.tool_calls?.[0]?.function?.arguments;
      if (typeof args === "string" && args.trim().length > 0) {
        content = args;
      }
    }

    // A reply with tool calls and no prose is valid (F1 tool loop); only an
    // empty reply with neither content NOR tool calls is an error.
    if (!content && !toolCalls) {
      // v1.20.1 — tag the empty-reply throw with a sentinel `httpStatus: 0` +
      // `kind` so the provider-chain classifier can tell an empty 200-OK reply
      // apart from a genuine transport failure (ECONNRESET, DNS, timeout) in
      // observability. The cascade is unchanged: `isHardProviderFailure`
      // already treats `status <= 0` as a hard failure and walks to the next
      // provider.
      const err = new Error(
        `${this.isGateway ? "OpenAI-compatible gateway" : "OpenAI"} returned empty content`,
      );
      Object.assign(err, {
        httpStatus: 0,
        kind: "empty_response",
        upstream: this.isGateway ? "openai-compatible" : "openai",
      });
      throw err;
    }

    return {
      content: content ?? "",
      tokensUsed: json.usage?.total_tokens ?? null,
      cachedInputTokens: parseCachedTokens(json),
      model: this.config.model,
      providerType: this.type,
      ...(toolCalls ? { toolCalls } : {}),
      finishReason: mapFinishReason(choice?.finish_reason),
    };
  }
}
