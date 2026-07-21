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

function isModernCanonicalModel(model: string): boolean {
  const normalizedModel = model.toLowerCase();

  return (
    normalizedModel === "gpt-5" ||
    normalizedModel.startsWith("gpt-5-") ||
    normalizedModel.startsWith("gpt-5.") ||
    normalizedModel === "o1" ||
    normalizedModel.startsWith("o1-") ||
    normalizedModel === "o3" ||
    normalizedModel.startsWith("o3-") ||
    normalizedModel === "o4" ||
    normalizedModel.startsWith("o4-")
  );
}

function isCanonicalOpenAIEndpoint(baseUrl: string): boolean {
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
