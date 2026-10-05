import { describe, expect, it } from "vitest";

import type {
  ProviderChainData,
  UserAIProvider,
} from "@/components/settings/ai/shared";

import {
  chainWithFirst,
  modelControlFor,
  reasoningFieldFor,
  selectableProviders,
} from "../coach-model-picker";

const CHAIN: ProviderChainData["configuredChain"] = [
  { providerType: "codex", enabled: true, available: false },
  { providerType: "openai", enabled: true, available: true },
  { providerType: "anthropic", enabled: false, available: true },
  { providerType: "local", enabled: true, available: true },
  { providerType: "admin-openai", enabled: true, available: true },
];

function userProvider(over: Partial<UserAIProvider> = {}): UserAIProvider {
  return {
    provider: "OPENAI",
    model: "gpt-4o",
    baseUrl: null,
    hasAnthropicKey: false,
    anthropicKeyPreview: null,
    hasLocalKey: false,
    hasOpenaiKey: true,
    openaiKeyPreview: "sk-…abcd",
    compatBaseUrl: null,
    compatModel: null,
    hasCompatKey: false,
    responseTimeoutSeconds: null,
    localReasoningEffort: null,
    compatReasoningEffort: null,
    ...over,
  };
}

describe("chainWithFirst", () => {
  it("moves the chosen provider to the front and keeps the rest in order", () => {
    expect(chainWithFirst(CHAIN, "local")).toEqual([
      { providerType: "local", priority: 1, enabled: true },
      { providerType: "codex", priority: 2, enabled: true },
      { providerType: "openai", priority: 3, enabled: true },
      { providerType: "anthropic", priority: 4, enabled: false },
      { providerType: "admin-openai", priority: 5, enabled: true },
    ]);
  });

  it("never sends a reasoning setting, so the server keeps the stored one", () => {
    for (const entry of chainWithFirst(CHAIN, "openai")) {
      expect(Object.keys(entry).sort()).toEqual([
        "enabled",
        "priority",
        "providerType",
      ]);
    }
  });
});

describe("selectableProviders", () => {
  it("offers only enabled providers that can answer", () => {
    expect(selectableProviders(CHAIN)).toEqual([
      "openai",
      "local",
      "admin-openai",
    ]);
  });
});

describe("modelControlFor", () => {
  it("offers the presets for the provider whose key the person saved", () => {
    const control = modelControlFor("openai", userProvider());
    expect(control.kind).toBe("preset");
    if (control.kind === "preset") expect(control.value).toBe("gpt-4o");
  });

  it("does not offer a model for a provider the shared model column is not set up for", () => {
    // The column belongs to OpenAI here; a Claude model name written for the
    // Anthropic entry would be sent to OpenAI.
    expect(modelControlFor("anthropic", userProvider()).kind).toBe("managed");
  });

  it("keeps the operator's provider and Codex read-only", () => {
    expect(modelControlFor("admin-openai", userProvider()).kind).toBe(
      "managed",
    );
    expect(modelControlFor("codex", userProvider()).kind).toBe("managed");
    expect(modelControlFor(null, userProvider()).kind).toBe("managed");
  });

  it("gives the gateway its own free-text model", () => {
    expect(
      modelControlFor(
        "openai-compatible",
        userProvider({ compatModel: "qwen3:32b" }),
      ),
    ).toEqual({ kind: "gateway", value: "qwen3:32b" });
  });
});

describe("reasoningFieldFor", () => {
  it("writes the Local and gateway entries' own reasoning fields", () => {
    expect(
      reasoningFieldFor("local", userProvider({ localReasoningEffort: "low" })),
    ).toEqual({ field: "localReasoningEffort", value: "low" });
    expect(reasoningFieldFor("openai-compatible", userProvider())).toEqual({
      field: "compatReasoningEffort",
      value: null,
    });
  });

  it("has nothing for providers without a reasoning setting", () => {
    expect(reasoningFieldFor("openai", userProvider())).toBeNull();
    expect(reasoningFieldFor("codex", userProvider())).toBeNull();
  });
});
