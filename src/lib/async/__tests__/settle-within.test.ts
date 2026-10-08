import { afterEach, describe, expect, it, vi } from "vitest";

import { settleWithin } from "../settle-within";

afterEach(() => {
  vi.useRealTimers();
});

describe("settleWithin", () => {
  it("answers with the work when it lands inside the budget, and leaves no timer", async () => {
    vi.useFakeTimers();
    await expect(
      settleWithin(Promise.resolve("done"), 1_500, null),
    ).resolves.toBe("done");
    // A bare race left the budget timer pending after the work answered.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers with the fallback once the budget runs out", async () => {
    vi.useFakeTimers();
    const pending = settleWithin(new Promise<string>(() => {}), 1_500, null);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(pending).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes a rejection inside the budget through, and clears the timer", async () => {
    vi.useFakeTimers();
    await expect(
      settleWithin(Promise.reject(new Error("boom")), 1_500, null),
    ).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });
});
