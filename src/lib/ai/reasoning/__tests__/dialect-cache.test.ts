import { beforeEach, describe, expect, it, vi } from "vitest";

const annotations = vi.hoisted(
  () => [] as Array<{ action?: unknown; meta?: Record<string, unknown> }>,
);
vi.mock("@/lib/logging/context", () => ({
  annotate: (fields: { action?: unknown; meta?: Record<string, unknown> }) =>
    annotations.push(fields),
}));

import {
  annotateReasoningDowngrade,
  DIALECT_TTL_MS,
  isReasoningParameterRejection,
  learnedReasoningDialect,
  rememberReasoningDialect,
  resetReasoningDialectCache,
} from "../dialect-cache";

beforeEach(() => {
  resetReasoningDialectCache();
  annotations.length = 0;
});

describe("reasoning dialect cache", () => {
  it("keys on provider, endpoint and model together", () => {
    const key = { provider: "local", endpoint: "http://a/v1", model: "m1" };
    rememberReasoningDialect(key, "none");
    expect(learnedReasoningDialect(key)).toBe("none");
    expect(learnedReasoningDialect({ ...key, model: "m2" })).toBeUndefined();
    expect(
      learnedReasoningDialect({ ...key, endpoint: "http://b/v1" }),
    ).toBeUndefined();
    expect(
      learnedReasoningDialect({ ...key, provider: "openai" }),
    ).toBeUndefined();
    resetReasoningDialectCache();
    expect(learnedReasoningDialect(key)).toBeUndefined();
  });

  it("marks a downgrade with meta keys only, never the action", () => {
    annotateReasoningDowngrade("codex", "high", "medium");
    expect(annotations).toEqual([
      {
        meta: {
          ai_reasoning_downgraded: true,
          ai_reasoning_downgraded_provider: "codex",
          ai_reasoning_downgraded_from: "high",
          ai_reasoning_downgraded_to: "medium",
        },
      },
    ]);
  });

  it("forgets a learned value after the TTL, and a re-learn restarts it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const key = { provider: "openai", endpoint: "http://g/v1", model: "m" };
      rememberReasoningDialect(key, "none");
      vi.advanceTimersByTime(DIALECT_TTL_MS - 1);
      expect(learnedReasoningDialect(key)).toBe("none");
      vi.advanceTimersByTime(1);
      expect(learnedReasoningDialect(key)).toBeUndefined();
      rememberReasoningDialect(key, "none");
      vi.advanceTimersByTime(DIALECT_TTL_MS / 2);
      expect(learnedReasoningDialect(key)).toBe("none");
      expect(DIALECT_TTL_MS).toBe(60 * 60 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("isReasoningParameterRejection", () => {
  const REASONING = /reasoning|thinking/i;
  const learns = (
    status: number,
    message: string,
    model = "m",
    param: string | null = null,
  ) =>
    isReasoningParameterRejection(
      status,
      JSON.stringify({ error: { message, param } }),
      REASONING,
      model,
    );

  it.each([
    "Unrecognized request argument supplied: reasoning_effort",
    "reasoning_effort: Extra inputs are not permitted",
    "Reasoning is not supported for this model.",
    "thinking.type.enabled is not supported for this model.",
    "thinking.type: Input tag 'adaptive' found using 'type' does not match any of the expected tags: 'disabled', 'enabled'",
    "Invalid value for 'reasoning.summary'.",
  ])("learns from a 400 that refuses the parameter: %s", (message) => {
    expect(learns(400, message)).toBe(true);
  });

  it("learns from a refusal that names the parameter only in `param`", () => {
    expect(
      learns(
        400,
        "Unsupported value: 'minimal' is not supported with the 'gpt-5.5' model.",
        "gpt-5.5",
        "reasoning.effort",
      ),
    ).toBe(true);
  });

  it.each([401, 403, 404, 422, 429, 500, 503])(
    "never learns from HTTP %i",
    (status) => {
      expect(learns(status, "reasoning_effort is not supported")).toBe(false);
    },
  );

  it.each([
    "Expected `thinking` or `redacted_thinking`, but found `text`. When `thinking` is enabled, a final `assistant` message must start with a thinking block.",
    "messages.1.content.0: Invalid `signature` in `thinking` block",
    "Item with id 'rs_1' not found. Items are not persisted when `store` is set to false.",
    "Item 'rs_1' of type 'reasoning' was provided without its required following item.",
    "The encrypted content for item rs_1 could not be verified; reasoning is not supported for replay.",
  ])("never learns from a replay error: %s", (message) => {
    expect(learns(400, message)).toBe(false);
  });

  it("never learns from a model name that merely contains the word", () => {
    expect(
      learns(
        400,
        "The model `deepseek-reasoner` does not support this request format.",
        "deepseek-reasoner",
      ),
    ).toBe(false);
    expect(
      learns(
        400,
        "qwen3-thinking is not supported on this server.",
        "qwen3-thinking",
      ),
    ).toBe(false);
  });

  it("never learns from a 400 about something else", () => {
    expect(learns(400, "messages: too long")).toBe(false);
    expect(learns(400, "Invalid schema for function 'get_weather'.")).toBe(
      false,
    );
  });
});
