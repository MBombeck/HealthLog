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

/**
 * Select Chat Completions request capabilities from both endpoint and model.
 * Custom OpenAI-compatible gateways retain the broadly supported legacy wire,
 * even when their model name resembles a modern OpenAI model.
 */
export function selectOpenAIChatCompletionsCapabilities(
  baseUrl: string,
  model: string,
): OpenAIChatCompletionsCapabilities {
  return isCanonicalOpenAIEndpoint(baseUrl) && isModernCanonicalModel(model)
    ? MODERN_CANONICAL_CAPABILITIES
    : LEGACY_COMPATIBLE_CAPABILITIES;
}
