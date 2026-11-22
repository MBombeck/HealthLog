import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  COACH_BUDGET_BOUNDS,
  COACH_MAX_TURN_MS,
  DEFAULT_SNAPSHOT_CHARS,
  coachBudgetInputSchema,
  coachBudgetsAfterWrite,
  coachTurnWindowMs,
  parseCoachBudgets,
  resolveCoachLimits,
} from "../coach-budgets";
import { MAX_SNAPSHOT_CHARS } from "../snapshot-prelude";
import { TURN_LIMITS } from "../tools/turn-budget";

const local = { providerType: "local" as const };
const gateway = { providerType: "openai-compatible" as const };
const openai = { providerType: "openai" as const };
const adminOpenai = { providerType: "admin-openai" as const };

describe("coach budgets", () => {
  it("keeps the built-in snapshot cap equal to the builder's", () => {
    expect(DEFAULT_SNAPSHOT_CHARS).toBe(MAX_SNAPSHOT_CHARS);
  });

  it("runs on the built-in limits when nothing is stored", () => {
    const limits = resolveCoachLimits({
      payer: "user",
      chain: [local],
      budgets: {},
    });
    expect(limits).toEqual({
      snapshotChars: MAX_SNAPSHOT_CHARS,
      turn: TURN_LIMITS.user,
      custom: false,
    });
  });

  it("applies the first provider's budget to the turn and the snapshot", () => {
    const limits = resolveCoachLimits({
      payer: "user",
      chain: [local],
      budgets: {
        local: {
          snapshotChars: 60_000,
          turnTokens: 400_000,
          maxRounds: 20,
          turnSeconds: 480,
        },
      },
    });
    expect(limits).toEqual({
      snapshotChars: 60_000,
      turn: { tokens: 400_000, maxRounds: 20, wallMs: 480_000 },
      custom: true,
    });
  });

  it("never lets a person raise what the operator pays for", () => {
    const limits = resolveCoachLimits({
      payer: "operator",
      chain: [adminOpenai],
      budgets: { local: { snapshotChars: 60_000, turnTokens: 600_000 } },
    });
    expect(limits.turn).toEqual(TURN_LIMITS.operator);
    expect(limits.snapshotChars).toBe(MAX_SNAPSHOT_CHARS);
    expect(limits.custom).toBe(false);
  });

  it("caps the snapshot at the built-in size behind an operator fallback", () => {
    const limits = resolveCoachLimits({
      payer: "user",
      chain: [local, adminOpenai],
      budgets: { local: { snapshotChars: 60_000 } },
    });
    expect(limits.snapshotChars).toBe(MAX_SNAPSHOT_CHARS);
  });

  it("caps the turn at the built-in limits behind an operator fallback", () => {
    // The fallback hop runs on the operator's key: a larger budget set for
    // the person's own model must not carry over to it.
    const limits = resolveCoachLimits({
      payer: "user",
      chain: [local, adminOpenai],
      budgets: {
        local: { turnTokens: 600_000, maxRounds: 24, turnSeconds: 600 },
      },
    });
    expect(limits.turn).toEqual(TURN_LIMITS.user);
    expect(limits.custom).toBe(false);
  });

  it("keeps a smaller budget behind an operator fallback", () => {
    const limits = resolveCoachLimits({
      payer: "user",
      chain: [local, { providerType: "admin-codex" as const }],
      budgets: {
        local: { turnTokens: 40_000, maxRounds: 24, turnSeconds: 60 },
      },
    });
    expect(limits.turn).toEqual({
      tokens: 40_000,
      maxRounds: TURN_LIMITS.user.maxRounds,
      wallMs: 60_000,
    });
    expect(limits.custom).toBe(true);
  });

  it("takes the smaller snapshot of a later provider", () => {
    const limits = resolveCoachLimits({
      payer: "user",
      chain: [gateway, local],
      budgets: {
        "openai-compatible": { snapshotChars: 40_000, turnTokens: 300_000 },
        local: { snapshotChars: 6_000, turnTokens: 30_000 },
      },
    });
    expect(limits.snapshotChars).toBe(6_000);
    // The turn is sized for the first provider only.
    expect(limits.turn.tokens).toBe(300_000);
  });

  it("gives a hosted provider no budget of its own", () => {
    const limits = resolveCoachLimits({
      payer: "user",
      chain: [openai],
      budgets: parseCoachBudgets({ openai: { snapshotChars: 90_000 } }),
    });
    expect(limits.snapshotChars).toBe(MAX_SNAPSHOT_CHARS);
  });

  it("clamps whatever is stored", () => {
    expect(
      parseCoachBudgets({
        local: { snapshotChars: 10, turnTokens: 9e9, maxRounds: "8" },
        "openai-compatible": "nonsense",
      }),
    ).toEqual({
      local: {
        snapshotChars: COACH_BUDGET_BOUNDS.snapshotChars.min,
        turnTokens: COACH_BUDGET_BOUNDS.turnTokens.max,
      },
    });
    expect(parseCoachBudgets(null)).toEqual({});
    expect(parseCoachBudgets([1, 2])).toEqual({});
  });

  it("merges a write and clears what is left empty", () => {
    const first = coachBudgetsAfterWrite(null, "local", {
      snapshotChars: 6_000,
      maxRounds: 4,
    });
    expect(first).toEqual({ local: { snapshotChars: 6_000, maxRounds: 4 } });
    const second = coachBudgetsAfterWrite(first, "local", {
      maxRounds: null,
    });
    expect(second).toEqual({ local: { snapshotChars: 6_000 } });
    expect(coachBudgetsAfterWrite(second, "local", null)).toBeNull();
  });

  it("refuses an out-of-range value at the write", () => {
    expect(
      coachBudgetInputSchema.safeParse({ snapshotChars: 999_999 }).success,
    ).toBe(false);
    expect(coachBudgetInputSchema.safeParse({ maxRounds: 2.5 }).success).toBe(
      false,
    );
    expect(coachBudgetInputSchema.safeParse({ maxRounds: 4 }).success).toBe(
      true,
    );
  });

  it("holds the turn slot for the longest turn a budget allows", () => {
    expect(COACH_MAX_TURN_MS).toBe(COACH_BUDGET_BOUNDS.turnSeconds.max * 1000);
  });

  it("holds the long turn slot only for a stored longer turn", () => {
    expect(coachTurnWindowMs({})).toBe(TURN_LIMITS.user.wallMs);
    expect(coachTurnWindowMs({ local: { snapshotChars: 60_000 } })).toBe(
      TURN_LIMITS.user.wallMs,
    );
    expect(coachTurnWindowMs({ local: { turnSeconds: 60 } })).toBe(
      TURN_LIMITS.user.wallMs,
    );
    expect(
      coachTurnWindowMs({
        local: { turnSeconds: 300 },
        "openai-compatible": { turnSeconds: 480 },
      }),
    ).toBe(480_000);
  });
});
