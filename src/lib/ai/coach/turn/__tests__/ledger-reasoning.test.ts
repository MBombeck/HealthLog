/**
 * v1.41 — the turn's ledger books round by round (one message, every round
 * settled against its own reservation, the unused reserve given back once),
 * and the effective reasoning level is capped again when the operator pays.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const b = vi.hoisted(() => ({
  reserveBudget: vi.fn(),
  reconcileSpend: vi.fn(),
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: () => "2026-10-06",
  reserveBudget: b.reserveBudget,
  reconcileSpend: b.reconcileSpend,
  resolveCostOwner: (chain: Array<{ providerType: string }>) =>
    chain[0]?.providerType.startsWith("admin-") ? "operator" : "user",
  resolveDailyCap: () => 2_000_000,
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { reserveTurnBudget } from "../budget";
import { reasoningForTurn } from "../reasoning";

const allowed = (reserved: number, owner = "user") => ({
  allowed: true,
  reserved,
  totalAfter: reserved,
  owner,
  operatorAfter: 0,
  limit: null,
});

beforeEach(() => {
  for (const fn of Object.values(b)) fn.mockReset();
  b.reconcileSpend.mockResolvedValue(undefined);
});

describe("reserveTurnBudget and the turn ledger", () => {
  async function ledger() {
    b.reserveBudget.mockResolvedValueOnce(allowed(9_000));
    const out = await reserveTurnBudget({
      userId: "u1",
      chain: [{ providerType: "codex", instance: {} }] as never,
      toolMode: true,
      firstRound: 7_000,
      finalReserve: 2_000,
    });
    if (!out.ok) throw new Error("refused");
    return out.ledger;
  }

  it("reserves round one and the final answer as one message", async () => {
    await ledger();
    expect(b.reserveBudget).toHaveBeenCalledWith(
      "u1",
      9_000,
      "2026-10-06",
      2_000_000,
      "user",
      "coach",
    );
  });

  it("books each further round without counting another message", async () => {
    const l = await ledger();
    b.reserveBudget.mockResolvedValueOnce(allowed(3_000));
    await expect(l.reserveRound(3_000)).resolves.toBe(true);
    expect(b.reserveBudget.mock.calls[1]).toEqual([
      "u1",
      3_000,
      "2026-10-06",
      2_000_000,
      "user",
      "coach",
      undefined,
      { countMessage: false },
    ]);
  });

  it("settles each round against its own reservation and gives back the unused reserve once", async () => {
    const l = await ledger();
    b.reserveBudget.mockResolvedValueOnce(allowed(3_000));
    await l.reserveRound(3_000);
    await l.settleRound({
      tokens: 6_500,
      cachedTokens: 500,
      servedBy: "codex",
      final: false,
    });
    await l.settleRound({
      tokens: 2_100,
      cachedTokens: 0,
      servedBy: "codex",
      final: false,
    });
    await l.close();
    await l.close();
    expect(
      b.reconcileSpend.mock.calls.map((c) => [c[1], c[2], c[4], c[5].servedBy]),
    ).toEqual([
      [7_000, 6_500, 500, "codex"],
      [3_000, 2_100, 0, "codex"],
      // The final reserve, never used: back to the day.
      [2_000, 0, 0, null],
    ]);
  });

  it("settles a forced final round against the final reserve", async () => {
    const l = await ledger();
    await l.settleRound({
      tokens: 6_000,
      cachedTokens: 0,
      servedBy: "codex",
      final: false,
    });
    await l.settleRound({
      tokens: 1_500,
      cachedTokens: 0,
      servedBy: "codex",
      final: true,
    });
    await l.close();
    expect(b.reconcileSpend.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [7_000, 6_000],
      [2_000, 1_500],
    ]);
  });

  it("answers false when the day's ceiling refuses a round, and books nothing", async () => {
    const l = await ledger();
    b.reserveBudget.mockResolvedValueOnce({
      ...allowed(3_000),
      allowed: false,
      limit: "owner-cap",
    });
    await expect(l.reserveRound(3_000)).resolves.toBe(false);
    await l.close();
    // Only round one's reservation and the final reserve go back.
    expect(b.reconcileSpend.mock.calls.map((c) => c[1])).toEqual([9_000]);
  });

  it("refunds everything still reserved when the provider failed", async () => {
    const l = await ledger();
    await l.close();
    expect(b.reconcileSpend).toHaveBeenCalledWith(
      "u1",
      9_000,
      0,
      "2026-10-06",
      0,
      { servedBy: null, reservedOwner: "user" },
    );
  });

  it("refuses the turn up front with the budget frame", async () => {
    b.reserveBudget.mockResolvedValueOnce({
      ...allowed(9_000),
      allowed: false,
      limit: "owner-cap",
    });
    const out = await reserveTurnBudget({
      userId: "u1",
      chain: [{ providerType: "codex", instance: {} }] as never,
      toolMode: true,
      firstRound: 7_000,
      finalReserve: 2_000,
    });
    expect(out.ok).toBe(false);
  });
});

describe("the turn's reasoning", () => {
  it("keeps the effective level on the person's own plan", () => {
    expect(reasoningForTurn("high", "user")).toEqual({
      effort: "high",
      summaries: true,
    });
    expect(reasoningForTurn("medium", "user")).toEqual({
      effort: "medium",
      summaries: true,
    });
  });

  it("caps at medium when the operator pays", () => {
    expect(reasoningForTurn("high", "operator").effort).toBe("medium");
    expect(reasoningForTurn("low", "operator").effort).toBe("low");
  });

  it("asks for no summaries when reasoning is off", () => {
    expect(reasoningForTurn("off", "user")).toEqual({
      effort: "off",
      summaries: false,
    });
  });
});
