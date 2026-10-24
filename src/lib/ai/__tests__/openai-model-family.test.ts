import { describe, expect, it } from "vitest";
import { OPENAI_MODEL_PRESETS } from "@/components/settings/ai/shared";
import { openAIModelFamily } from "../openai-model-family";

describe("openAIModelFamily", () => {
  it.each([
    // The gpt-6 line as the upstream Codex catalog lists it.
    ["gpt-6-sol", "gpt-5.1+", true],
    ["gpt-6-luna", "gpt-5.1+", true],
    ["gpt-6-astra", "gpt-5.1+", true],
    ["gpt-6.1-sol", "gpt-5.1+", true],
    ["gpt-6", "gpt-5.1+", true],
    ["GPT-6.1-Sol", "gpt-5.1+", true],
    ["openai/gpt-6-luna", "gpt-5.1+", true],
    // A later generation reads like the newest one this file knows.
    ["gpt-7", "gpt-5.1+", true],
    // gpt-5.x
    ["gpt-5.6-terra", "gpt-5.1+", true],
    ["gpt-5.5", "gpt-5.1+", true],
    ["gpt-5.3-codex", "gpt-5.1+", true],
    ["gpt-5.1-codex-mini", "gpt-5.1+", true],
    ["gpt-5", "gpt-5", true],
    ["gpt-5-mini", "gpt-5", true],
    ["gpt-5-codex", "gpt-5", true],
    ["gpt-5-2025-08-07", "gpt-5", true],
    // o-series: full models read images, -mini / -preview do not.
    ["o1", "o", true],
    ["o3", "o", true],
    ["o4", "o", true],
    ["o1-mini", "o", false],
    ["o1-preview", "o", false],
    ["o3-mini", "o", false],
    ["o4-mini-2025-04-16", "o", false],
    // gpt-4 class: no reasoning; vision on 4o, 4.1 and turbo only.
    ["gpt-4o", null, true],
    ["gpt-4o-mini", null, true],
    ["gpt-4.1", null, true],
    ["gpt-4.1-mini", null, true],
    ["gpt-4-turbo", null, true],
    ["gpt-4", null, false],
    ["gpt-3.5-turbo", null, false],
  ] as const)("%s", (model, reasoning, vision) => {
    expect(openAIModelFamily(model)).toEqual({ reasoning, vision });
  });

  it("does not recognise names outside the OpenAI families", () => {
    for (const model of [
      "llama3.1:8b",
      "claude-opus-5",
      "gpt-daybreak-blue-latest",
      "gpt-60x",
      "o2",
      "o3x",
      "",
    ]) {
      expect(openAIModelFamily(model), model).toBeNull();
    }
  });

  it("recognises every OpenAI model the settings offer as a preset", () => {
    for (const model of OPENAI_MODEL_PRESETS) {
      expect(openAIModelFamily(model), model).not.toBeNull();
    }
  });
});
