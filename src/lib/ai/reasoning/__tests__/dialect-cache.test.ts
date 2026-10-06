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
});
