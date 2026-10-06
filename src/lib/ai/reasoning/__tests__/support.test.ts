import { describe, expect, it } from "vitest";
import {
  anthropicModelVersion,
  anthropicRefusesSampling,
  anthropicThinkingDialect,
  anthropicThinksAlways,
  isOpenRouterEndpoint,
  levelOfWireEffort,
  openAIOffEffort,
  openAIReasoningFamily,
  reasoningSupport,
  reasoningTitleOf,
  splitThinkTags,
} from "../support";

describe("anthropicModelVersion", () => {
  it.each([
    ["claude-sonnet-4-6", { major: 4, minor: 6 }],
    ["claude-opus-4-7", { major: 4, minor: 7 }],
    ["claude-opus-5", { major: 5, minor: 0 }],
    ["claude-opus-5-5", { major: 5, minor: 5 }],
    ["claude-fable-5-1", { major: 5, minor: 1 }],
    ["claude-haiku-4-5", { major: 4, minor: 5 }],
    // An eight-digit segment is a snapshot date, not a minor.
    ["claude-opus-4-20250514", { major: 4, minor: 0 }],
    ["claude-opus-4-1-20250805", { major: 4, minor: 1 }],
    ["claude-sonnet-4.5", { major: 4, minor: 5 }],
    ["anthropic/claude-sonnet-4.6", { major: 4, minor: 6 }],
    ["claude-3-7-sonnet-latest", { major: 3, minor: 7 }],
    ["claude-3-5-sonnet-latest", { major: 3, minor: 5 }],
  ])("%s", (model, expected) => {
    expect(anthropicModelVersion(model)).toEqual(expected);
  });

  it("returns null for a name it cannot read", () => {
    expect(anthropicModelVersion("my-claude-proxy")).toBeNull();
  });
});

describe("anthropicThinkingDialect", () => {
  it.each([
    ["claude-3-5-sonnet-latest", "none"],
    ["claude-3-7-sonnet-latest", "manual"],
    ["claude-opus-4-20250514", "manual"],
    ["claude-haiku-4-5", "manual"],
    ["claude-sonnet-4-5", "manual"],
    // budget_tokens is deprecated on 4.6 and refused from 4.7 on.
    ["claude-sonnet-4-6", "adaptive"],
    ["claude-opus-4-7", "adaptive"],
    ["claude-opus-5", "adaptive"],
    ["claude-sonnet-5", "adaptive"],
    // Unknown names try the current form first and learn from a refusal.
    ["my-claude-proxy", "adaptive"],
  ])("%s → %s", (model, dialect) => {
    expect(anthropicThinkingDialect(model)).toBe(dialect);
  });

  it("refuses sampling from 4.7 on, never for an unknown name", () => {
    expect(anthropicRefusesSampling("claude-sonnet-4-6")).toBe(false);
    expect(anthropicRefusesSampling("claude-opus-4-7")).toBe(true);
    expect(anthropicRefusesSampling("claude-sonnet-5")).toBe(true);
    expect(anthropicRefusesSampling("claude-opus-5-5")).toBe(true);
    expect(anthropicRefusesSampling("my-claude-proxy")).toBe(false);
  });

  it("thinks always from the 5 generation on", () => {
    expect(anthropicThinksAlways("claude-opus-4-8")).toBe(false);
    expect(anthropicThinksAlways("claude-opus-5")).toBe(true);
    expect(anthropicThinksAlways("claude-sonnet-5")).toBe(true);
  });
});

describe("OpenAI families", () => {
  it.each([
    ["gpt-5.5", "gpt-5.1+", "none"],
    ["gpt-5.1-mini", "gpt-5.1+", "none"],
    ["gpt-5", "gpt-5", "minimal"],
    ["gpt-5-mini", "gpt-5", "minimal"],
    ["o3", "o", "low"],
    ["o4-mini", "o", "low"],
  ] as const)("%s", (model, family, off) => {
    expect(openAIReasoningFamily(model)).toBe(family);
    expect(openAIOffEffort(family)).toBe(off);
  });

  it("does not treat a non-reasoning model as one", () => {
    expect(openAIReasoningFamily("gpt-4o")).toBeNull();
    expect(openAIReasoningFamily("gpt-4.1-mini")).toBeNull();
  });

  it("recognises OpenRouter by host only", () => {
    expect(isOpenRouterEndpoint("https://openrouter.ai/api/v1")).toBe(true);
    expect(isOpenRouterEndpoint("https://eu.openrouter.ai/api/v1")).toBe(true);
    expect(isOpenRouterEndpoint("https://openrouter.ai.evil.example/v1")).toBe(
      false,
    );
    expect(isOpenRouterEndpoint("not a url")).toBe(false);
  });
});

describe("reasoningSupport", () => {
  it("reports the matrix per provider", () => {
    expect(reasoningSupport("codex", "gpt-5.5")).toEqual({
      effort: true,
      summaries: true,
      liveSummaries: true,
      stateRoundTrip: true,
      offIsReal: true,
    });
    expect(reasoningSupport("anthropic", "claude-opus-5").offIsReal).toBe(
      false,
    );
    expect(reasoningSupport("anthropic", "claude-sonnet-4-6").offIsReal).toBe(
      true,
    );
    expect(
      reasoningSupport("anthropic", "claude-3-5-sonnet-latest").effort,
    ).toBe(false);
    expect(reasoningSupport("admin-key", "gpt-4o").effort).toBe(false);
    expect(reasoningSupport("admin-key", "gpt-5").offIsReal).toBe(false);
    expect(
      reasoningSupport("openai-compatible", "x", {
        baseUrl: "https://openrouter.ai/api/v1",
      }).stateRoundTrip,
    ).toBe(true);
    expect(
      reasoningSupport("openai-compatible", "x", {
        baseUrl: "https://litellm.example.com/v1",
      }).stateRoundTrip,
    ).toBe(false);
    expect(reasoningSupport("local", "qwen3").liveSummaries).toBe(true);
    expect(reasoningSupport("none", "").effort).toBe(false);
  });
});

describe("parsing helpers", () => {
  it("reads a bold first line as the title, and nothing else", () => {
    expect(reasoningTitleOf("**Checking the window**\n\nBody")).toBe(
      "Checking the window",
    );
    expect(reasoningTitleOf("**Checking the window**")).toBe(
      "Checking the window",
    );
    expect(reasoningTitleOf("**Checking the")).toBeNull();
    expect(reasoningTitleOf("Plain first line\n**Later**")).toBeNull();
  });

  it("splits a leading think block and leaves later mentions alone", () => {
    expect(splitThinkTags("<think>a plan</think>\n\nThe answer.")).toEqual({
      content: "The answer.",
      reasoning: "a plan",
    });
    expect(splitThinkTags("The answer mentions <think>.")).toEqual({
      content: "The answer mentions <think>.",
      reasoning: null,
    });
    // Unclosed: the budget ran out inside the reasoning.
    expect(splitThinkTags("<think>still going")).toEqual({
      content: "",
      reasoning: "still going",
    });
  });

  it("maps wire efforts back onto levels", () => {
    expect(levelOfWireEffort("none")).toBe("off");
    expect(levelOfWireEffort("minimal")).toBe("off");
    expect(levelOfWireEffort("medium")).toBe("medium");
    expect(levelOfWireEffort("xhigh")).toBe("high");
    expect(levelOfWireEffort(null)).toBe("off");
  });
});
