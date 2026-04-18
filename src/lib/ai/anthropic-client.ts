import type { AIProvider, CompletionParams, CompletionResult } from "./types";

interface AnthropicClientConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Wrap the user prompt so Claude reliably emits valid JSON.
 * Anthropic's Messages API has no `response_format: json_object` knob; the
 * documented best-practice is an explicit instruction in the user message.
 */
function wrapForJson(userPrompt: string): string {
  return `${userPrompt}\n\nRespond only with valid JSON matching the requested schema. Do not include any prose, markdown fences, or explanation outside the JSON object.`;
}

export class AnthropicClient implements AIProvider {
  readonly type = "anthropic" as const;
  private config: AnthropicClientConfig;

  constructor(config: AnthropicClientConfig) {
    this.config = config;
  }

  async generateCompletion(params: CompletionParams): Promise<CompletionResult> {
    const baseUrl = (this.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    const url = `${baseUrl}/messages`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: params.maxTokens ?? 1000,
        temperature: params.temperature ?? 0.3,
        system: params.systemPrompt,
        messages: [
          { role: "user", content: wrapForJson(params.userPrompt) },
        ],
      }),
    });

    if (!res.ok) {
      // Mirror the openai-client body-capture so 4xx/5xx upstream incidents
      // (model-not-found, overloaded, rate limit) are diagnosable from logs
      // instead of surfacing as an opaque "Anthropic request failed (5xx)".
      // Strip anything that looks like an Anthropic API key from the excerpt
      // before logging.
      const rawBody = await res.text().catch(() => "");
      const bodyExcerpt = rawBody
        .slice(0, 500)
        .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-***redacted***")
        .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, "Bearer ***redacted***");
      const err = new Error(`Anthropic request failed (${res.status})`);
      Object.assign(err, {
        httpStatus: res.status,
        upstream: "anthropic",
        model: this.config.model,
        bodyExcerpt,
      });
      throw err;
    }

    const json = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const textBlock = json.content?.find((c) => c.type === "text");
    const content = textBlock?.text;

    if (!content) {
      throw new Error("Anthropic returned empty content");
    }

    const inputTokens = json.usage?.input_tokens ?? 0;
    const outputTokens = json.usage?.output_tokens ?? 0;
    const tokensUsed = inputTokens + outputTokens || null;

    return {
      content,
      tokensUsed,
      model: this.config.model,
      providerType: "anthropic",
    };
  }
}
