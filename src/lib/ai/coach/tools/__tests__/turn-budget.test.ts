/**
 * v1.41 — the turn budget: limits by payer, the three stop checks in their
 * order, cached input at a tenth, and the final answer always reserved.
 */
import { describe, expect, it } from "vitest";

import {
  CACHED_INPUT_WEIGHT,
  FINAL_ANSWER_TOKENS,
  ROUND_ANSWER_TOKENS,
  TURN_LIMITS,
  createTurnBudget,
  roundOutputAllowance,
  weightedRoundTokens,
} from "../turn-budget";

function clock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("TURN_LIMITS", () => {
  it("gives the person's own plan more than the operator's", () => {
    expect(TURN_LIMITS.user).toEqual({
      tokens: 120_000,
      wallMs: 150_000,
      maxRounds: 12,
    });
    expect(TURN_LIMITS.operator).toEqual({
      tokens: 40_000,
      wallMs: 90_000,
      maxRounds: 6,
    });
  });
});

describe("token accounting", () => {
  it("counts cached input at a tenth", () => {
    expect(weightedRoundTokens({ tokens: 10_000, cachedTokens: 8_000 })).toBe(
      2_000 + 8_000 * CACHED_INPUT_WEIGHT,
    );
    // A cache count above the gross never makes a round cheaper than free.
    expect(weightedRoundTokens({ tokens: 100, cachedTokens: 900 })).toBe(10);
    expect(weightedRoundTokens({ tokens: null, cachedTokens: null })).toBe(0);
  });

  it("adds the thinking budget to a round's output where the level thinks", () => {
    expect(roundOutputAllowance(undefined)).toBe(ROUND_ANSWER_TOKENS);
    expect(roundOutputAllowance("off")).toBe(ROUND_ANSWER_TOKENS);
    expect(roundOutputAllowance("medium")).toBe(ROUND_ANSWER_TOKENS + 4_096);
    expect(roundOutputAllowance("high")).toBe(ROUND_ANSWER_TOKENS + 12_000);
  });
});

describe("check()", () => {
  it("lets a fresh turn keep fetching", () => {
    const budget = createTurnBudget({
      payer: "user",
      initialInputTokens: 10_000,
    });
    budget.endRound({ tokens: 10_600, cachedTokens: 0, durationMs: 4_000 });
    expect(budget.check()).toBeNull();
  });

  it("stops for tokens when the next round and the final answer would not fit", () => {
    const budget = createTurnBudget({
      payer: "operator",
      effort: "medium",
      initialInputTokens: 10_000,
    });
    // 34k spent; the next round with medium thinking and the final answer
    // need about 8k more, past the operator's 40k.
    budget.endRound({ tokens: 34_000, cachedTokens: 0, durationMs: 1_000 });
    expect(budget.check()).toBe("budget");
  });

  it("keeps room for the final answer whatever stops the loop", () => {
    const budget = createTurnBudget({
      payer: "user",
      initialInputTokens: 2_000,
    });
    budget.endRound({ tokens: 2_600, cachedTokens: 0, durationMs: 1_000 });
    expect(budget.finalReserve()).toBeGreaterThanOrEqual(FINAL_ANSWER_TOKENS);
    // Exactly at the edge: spent + next + final must stay inside.
    const edge = createTurnBudget({
      payer: "user",
      initialInputTokens: 2_000,
      limits: { tokens: 0, wallMs: 1e9, maxRounds: 99 },
    });
    edge.endRound({ tokens: 1, cachedTokens: 0, durationMs: 1 });
    expect(edge.check()).toBe("budget");
  });

  it("stops for time before the wall clock is reached, not after", () => {
    const c = clock();
    const budget = createTurnBudget({
      payer: "operator",
      initialInputTokens: 1_000,
      now: c.now,
    });
    c.advance(30_000);
    budget.endRound({ tokens: 1_000, cachedTokens: 0, durationMs: 30_000 });
    // 30 s elapsed + two typical 30 s rounds = 90 s: not over yet.
    expect(budget.check()).toBeNull();
    c.advance(1);
    budget.endRound({ tokens: 1_000, cachedTokens: 900, durationMs: 30_000 });
    expect(budget.check()).toBe("time");
  });

  it("makes the last round the cap allows the final answer", () => {
    const budget = createTurnBudget({
      payer: "operator",
      initialInputTokens: 10,
      limits: { tokens: 1e9, wallMs: 1e9, maxRounds: 6 },
    });
    for (let i = 0; i < 4; i += 1) {
      budget.endRound({ tokens: 10, cachedTokens: 0, durationMs: 1 });
      expect(budget.check()).toBeNull();
    }
    budget.endRound({ tokens: 10, cachedTokens: 0, durationMs: 1 });
    // Five rounds done: the sixth must be the answer.
    expect(budget.check()).toBe("cap");
  });

  it("checks tokens before time and time before the cap", () => {
    const c = clock();
    const budget = createTurnBudget({
      payer: "user",
      initialInputTokens: 10,
      now: c.now,
      limits: { tokens: 100, wallMs: 10, maxRounds: 2 },
    });
    c.advance(1_000);
    budget.endRound({ tokens: 500, cachedTokens: 0, durationMs: 1_000 });
    expect(budget.check()).toBe("budget");
  });

  it("estimates a later round from what the last one cost, not from the whole prompt", () => {
    const budget = createTurnBudget({
      payer: "operator",
      initialInputTokens: 12_000,
    });
    // Round one paid the whole prompt; the provider caches the resent prefix.
    budget.endRound({ tokens: 12_600, cachedTokens: 0, durationMs: 1_000 });
    budget.addInput(1_500);
    // The next round is the cached prefix plus what was added, plus output.
    expect(budget.nextRoundEstimate()).toBeLessThan(12_600);
    expect(budget.check()).toBeNull();
    // A provider that reports no cache on round two is charged in full.
    budget.endRound({ tokens: 14_000, cachedTokens: 0, durationMs: 1_000 });
    expect(budget.nextRoundEstimate()).toBeGreaterThanOrEqual(14_000);
  });
});
