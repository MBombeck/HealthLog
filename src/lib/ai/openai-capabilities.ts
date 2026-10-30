import { openAIModelFamily } from "./openai-model-family";

export type OpenAIChatCompletionsCapabilities =
  | {
      tokenBudgetField: "max_completion_tokens";
      supportsSamplingControls: false;
    }
  | {
      tokenBudgetField: "max_tokens";
      supportsSamplingControls: true;
    };

const MODERN_CANONICAL_CAPABILITIES = {
  tokenBudgetField: "max_completion_tokens",
  supportsSamplingControls: false,
} as const;

const LEGACY_COMPATIBLE_CAPABILITIES = {
  tokenBudgetField: "max_tokens",
  supportsSamplingControls: true,
} as const;

/**
 * A reasoning model (gpt-5 on, the gpt-6 line included, the o-series) takes
 * `max_completion_tokens` and refuses sampling controls; the family reading
 * is shared with the reasoning and vision gates.
 */
function isModernCanonicalModel(model: string): boolean {
  return openAIModelFamily(model)?.reasoning != null;
}

export function isCanonicalOpenAIEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      url.protocol === "https:" &&
      url.hostname === "api.openai.com" &&
      url.port === "" &&
      url.pathname.replace(/\/+$/, "") === "/v1" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

/** The hosts an Azure OpenAI resource is served from. */
const AZURE_OPENAI_HOST =
  /^[a-z0-9][a-z0-9-]*\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/;

/**
 * #1304 — an Azure OpenAI resource's v1 endpoint
 * (`https://<resource>.openai.azure.com/openai/v1`). It speaks the same
 * request contract as `api.openai.com` for the same model, but the model
 * field carries the deployment name, which only identifies the model when
 * the deployment was named after it. An opaque alias is caught by the
 * refusal it draws instead (`rememberMaxTokensRefused`).
 */
export function isAzureOpenAIV1Endpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      url.protocol === "https:" &&
      AZURE_OPENAI_HOST.test(url.hostname) &&
      url.port === "" &&
      url.pathname.replace(/\/+$/, "") === "/openai/v1" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

/**
 * #1304 — endpoint and model pairs that refused `max_tokens`, for the
 * process lifetime. Keyed by both, because one gateway can front a legacy
 * model and a reasoning model side by side.
 */
const maxTokensRefused = new Set<string>();

function refusalKey(baseUrl: string, model: string): string {
  return `${baseUrl}\n${model}`;
}

export function rememberMaxTokensRefused(baseUrl: string, model: string): void {
  maxTokensRefused.add(refusalKey(baseUrl, model));
}

/** Test hook — clears the learned `max_tokens` refusals. */
export function resetMaxTokensRefusals(): void {
  maxTokensRefused.clear();
}

/**
 * True when a 400 says the model takes `max_completion_tokens` and not
 * `max_tokens`: it names the replacement, or it refuses `max_tokens` by
 * name. A complaint about the value ("max_tokens is too large") or about
 * another field that echoes the request is not a refusal of the field.
 */
export function isMaxTokensRejection(status: number, body: string): boolean {
  if (status !== 400 || !/\bmax_tokens\b/.test(body)) return false;
  return (
    /max_completion_tokens/.test(body) ||
    /unsupported[\s_-]*parameter\W{0,4}max_tokens\b|\bmax_tokens\W{0,4}(is\s+)?(not\s+supported|unsupported)/i.test(
      body,
    )
  );
}

/**
 * Select Chat Completions request capabilities from both endpoint and model.
 * Custom OpenAI-compatible gateways retain the broadly supported legacy wire,
 * even when their model name resembles a modern OpenAI model, until the
 * endpoint refuses `max_tokens` for that model. `api.openai.com` and an
 * Azure OpenAI v1 endpoint take the modern wire for a reasoning model.
 */
export function selectOpenAIChatCompletionsCapabilities(
  baseUrl: string,
  model: string,
): OpenAIChatCompletionsCapabilities {
  if (maxTokensRefused.has(refusalKey(baseUrl, model))) {
    return MODERN_CANONICAL_CAPABILITIES;
  }
  return (isCanonicalOpenAIEndpoint(baseUrl) ||
    isAzureOpenAIV1Endpoint(baseUrl)) &&
    isModernCanonicalModel(model)
    ? MODERN_CANONICAL_CAPABILITIES
    : LEGACY_COMPATIBLE_CAPABILITIES;
}
