import { safeFetch } from "@/lib/safe-fetch";
import type { AIProvider, CompletionParams, CompletionResult } from "./types";

interface LocalClientConfig {
  apiKey?: string | null;
  model: string;
  baseUrl: string;
}

/**
 * Talks to OpenAI-compatible local servers (Ollama, LocalAI, LM Studio,
 * vLLM, …). Same wire format as OpenAI but without
 * `response_format: { type: "json_object" }` — many local models reject the
 * field outright. Instead we prepend a strict-JSON instruction to the user
 * message, which is what most local model templates respect.
 */
export class LocalOpenAICompatibleClient implements AIProvider {
  readonly type = "local" as const;
  private config: LocalClientConfig;

  constructor(config: LocalClientConfig) {
    this.config = config;
  }

  async generateCompletion(
    params: CompletionParams,
  ): Promise<CompletionResult> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    // Some local servers (LM Studio with auth, vLLM behind a proxy) require a
    // bearer; Ollama does not. Send the header only when an actual key is set.
    const trimmedKey = this.config.apiKey?.trim();
    if (trimmedKey) {
      headers.Authorization = `Bearer ${trimmedKey}`;
    }

    const userPrompt = `Return strict JSON only, no markdown, no commentary.\n\n${params.userPrompt}`;

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
    // RFC1918 address opt out via `ALLOW_LOCAL_AI_PRIVATE_HOSTS=true`
    // (also enforced at write-time in /api/user/ai-provider).
    const allowPrivate = process.env.ALLOW_LOCAL_AI_PRIVATE_HOSTS === "true";
    const res = await safeFetch(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: "system", content: params.systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: params.temperature ?? 0.3,
          max_tokens: params.maxTokens ?? 1000,
        }),
      },
      { timeoutMs: 60_000, requirePublicHost: !allowPrivate },
    );

    if (!res.ok) {
      // Mirror the openai-client structured-error pattern. Local endpoints
      // also commonly leak bearer tokens in error envelopes (proxies), so
      // strip anything that looks like a key before logging.
      const rawBody = await res.text().catch(() => "");
      const bodyExcerpt = rawBody
        .slice(0, 500)
        .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***redacted***")
        .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, "Bearer ***redacted***");
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

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
    };

    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Local AI returned empty content");
    }

    return {
      content,
      tokensUsed: json.usage?.total_tokens ?? null,
      model: this.config.model,
      providerType: "local",
    };
  }
}
