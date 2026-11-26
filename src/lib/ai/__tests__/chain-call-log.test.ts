/**
 * #1404 — every AI call names the chain and provider that served it, or the
 * reason it did not, on a line of its own an operator can grep for
 * (`ai.chain.served` / `ai.chain.failed`). Most callers pick a chain entry and
 * call it directly, outside the chain runner, and used to leave no line.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/signal", () => ({
  emitOutcome: vi.fn(),
  emitSignal: vi.fn(),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { emitOutcome, emitSignal } from "@/lib/logging/signal";
import type { AIProvider, CompletionParams } from "../types";
import { chainLabelFor, logChainCalls } from "../chain-call-log";

const PARAMS = {} as CompletionParams;

function provider(
  impl: () => Promise<unknown>,
  stream?: () => Promise<unknown>,
): AIProvider {
  return {
    type: "local",
    generateCompletion: vi.fn(impl),
    ...(stream ? { generateCompletionStream: vi.fn(stream) } : {}),
  } as unknown as AIProvider;
}

beforeEach(() => {
  vi.mocked(emitOutcome).mockReset();
  vi.mocked(emitSignal).mockReset();
});

describe("chainLabelFor", () => {
  it("names the main chain, a default named chain and a pinned one", () => {
    expect(chainLabelFor({ kind: "main" }, "coach")).toEqual({
      chain: "main",
      capability: "coach",
    });
    expect(
      chainLabelFor({ kind: "default", chainId: "cloud", entries: [] }, null),
    ).toEqual({ chain: "default:cloud", capability: null });
    expect(
      chainLabelFor(
        { kind: "pinned", chainId: "c1", entries: ["local"] },
        "documentAi",
      ),
    ).toEqual({ chain: "pinned:c1", capability: "documentAi" });
  });
});

describe("logChainCalls", () => {
  const label = { chain: "pinned:c1", capability: "documentAi" as const };

  it("writes ai.chain.served for a call that answered", async () => {
    const p = logChainCalls(
      provider(async () => ({ content: "ok" })),
      "local",
      label,
    );
    await p.generateCompletion(PARAMS);
    expect(emitOutcome).toHaveBeenCalledWith({
      action: "ai.chain.served",
      meta: { chain: "pinned:c1", capability: "documentAi", provider: "local" },
      durationMs: expect.any(Number),
    });
    expect(emitSignal).not.toHaveBeenCalled();
  });

  it("writes ai.chain.failed with the failure kind, and rethrows", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), {
      cause: { code: "ECONNREFUSED" },
    });
    const p = logChainCalls(
      provider(async () => {
        throw refused;
      }),
      "local",
      label,
    );
    await expect(p.generateCompletion(PARAMS)).rejects.toBe(refused);
    expect(emitSignal).toHaveBeenCalledWith({
      action: "ai.chain.failed",
      level: "warn",
      meta: {
        chain: "pinned:c1",
        capability: "documentAi",
        provider: "local",
        failure: "refused",
        code: "ECONNREFUSED",
      },
      durationMs: expect.any(Number),
    });
    expect(emitOutcome).not.toHaveBeenCalled();
  });

  // #1404 — the line said duration_ms=0 for a call that ran ten minutes.
  it("measures the call itself, from start to failure", async () => {
    vi.useFakeTimers();
    try {
      const p = logChainCalls(
        provider(
          () =>
            new Promise((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    Object.assign(new Error("timeout"), {
                      name: "TimeoutError",
                    }),
                  ),
                600_000,
              ),
            ),
        ),
        "local",
        label,
      );
      const call = expect(p.generateCompletion(PARAMS)).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(600_000);
      await call;
      const line = vi.mocked(emitSignal).mock.calls[0]?.[0];
      expect(line?.durationMs).toBeGreaterThanOrEqual(600_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("covers the streaming call too", async () => {
    const p = logChainCalls(
      provider(
        async () => ({ content: "buffered" }),
        async () => ({ content: "streamed" }),
      ),
      "openai-compatible",
      { chain: "main", capability: "coach" },
    );
    await p.generateCompletionStream!(PARAMS, () => {});
    expect(emitOutcome).toHaveBeenCalledWith({
      action: "ai.chain.served",
      meta: {
        chain: "main",
        capability: "coach",
        provider: "openai-compatible",
      },
      durationMs: expect.any(Number),
    });
  });

  it("wraps an instance once, and leaves it comparing as before", async () => {
    const raw = provider(async () => ({ content: "ok" }));
    const keys = Object.keys(raw);
    const p = logChainCalls(logChainCalls(raw, "local", label), "local", label);
    expect(Object.keys(p)).toEqual(keys);
    await p.generateCompletion(PARAMS);
    expect(emitOutcome).toHaveBeenCalledTimes(1);
  });
});
