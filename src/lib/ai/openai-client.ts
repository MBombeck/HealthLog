import { safeFetch } from "@/lib/safe-fetch";
import type { AIProvider, CompletionParams, CompletionResult } from "./types";
import { selectOpenAIChatCompletionsCapabilities } from "./openai-capabilities";
import {
  buildOpenAIMessages,
  buildOpenAITools,
  mapFinishReason,
  parseCachedTokens,
  parseOpenAIToolCalls,
  type OpenAIResponseJson,
} from "./openai-wire";

interface OpenAIClientConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  /**
   * Override the provider tag used in logs and analytics. Defaults to
   * "admin-key". The Codex flow uses the same OpenAI API but the key
   * was obtained via the token-exchange grant against a ChatGPT
   * subscription — for billing and observability we want that path
   * to log as "codex" instead.
   */
  providerType?: "admin-key" | "codex";
}

type OpenAIProviderType = "admin-key" | "codex";

export class OpenAIClient implements AIProvider {
  readonly type: OpenAIProviderType;
  private config: OpenAIClientConfig;

  constructor(config: OpenAIClientConfig) {
    this.config = config;
    this.type = config.providerType ?? "admin-key";
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

    const res = await safeFetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          ...capabilityParams,
          ...(useJsonFormat
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
      {
        timeoutMs: params.timeoutMs ?? 60_000,
        requirePublicHost: true,
        signal: params.signal,
      },
    );

    if (!res.ok) {
      // Pull as much of the body as we can so upstream incidents (OpenAI 5xx,
      // model-not-found, quota exceeded) are diagnosable from logs instead of
      // surfacing as an opaque "OpenAI request failed (500)". Strip anything
      // that looks like an API key from the excerpt before logging.
      const rawBody = await res.text().catch(() => "");
      const bodyExcerpt = rawBody
        .slice(0, 500)
        .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***redacted***")
        .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, "Bearer ***redacted***");
      const err = new Error(`OpenAI request failed (${res.status})`);
      // Keep the body in a structured field rather than the message so
      // Error.message stays short and the excerpt lands in dedicated log
      // fields (bodyExcerpt) that can be filtered/truncated centrally.
      Object.assign(err, {
        httpStatus: res.status,
        upstream: "openai",
        model: this.config.model,
        bodyExcerpt,
      });
      throw err;
    }

    const json = (await res.json()) as OpenAIResponseJson;
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
      const err = new Error("OpenAI returned empty content");
      Object.assign(err, {
        httpStatus: 0,
        kind: "empty_response",
        upstream: "openai",
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
