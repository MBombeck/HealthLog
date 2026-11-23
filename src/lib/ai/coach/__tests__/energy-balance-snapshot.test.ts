/**
 * The Coach's energy-balance line: window means only, behind the nutrients
 * module and the lookback limit, null without a balance.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const isModuleEnabled = vi.fn();
const readEnergyBalanceForUser = vi.fn();
vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: (...a: unknown[]) => isModuleEnabled(...a),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/nutrients/energy-balance", () => ({
  readEnergyBalanceForUser: (...a: unknown[]) => readEnergyBalanceForUser(...a),
}));

import {
  ENERGY_BALANCE_SNAPSHOT_DAYS,
  buildEnergyBalanceSnapshotBlock,
} from "@/lib/ai/coach/energy-balance-snapshot";
import { UNBOUNDED_REACH } from "@/lib/ai/coach/history-reach";

function balance(daysWithBalance: number) {
  const days = Array.from({ length: ENERGY_BALANCE_SNAPSHOT_DAYS }, (_, i) => ({
    day: `2026-11-${String(i + 1).padStart(2, "0")}`,
    intakeKcal: 2100,
    restingKcal: 1650,
    restingEstimated: i < 3,
    activeKcal: 500,
    expenditureKcal: 2150,
    balanceKcal: i < daysWithBalance ? -50 : null,
    trendKcal: null,
    partial: i === ENERGY_BALANCE_SNAPSHOT_DAYS - 1,
  }));
  return {
    windowDays: days.length,
    days,
    summary: {
      daysWithBalance,
      meanIntakeKcal: daysWithBalance ? 2100 : null,
      meanExpenditureKcal: daysWithBalance ? 2150 : null,
      meanBalanceKcal: daysWithBalance ? -50 : null,
    },
    estimateGaps: [],
  };
}

describe("buildEnergyBalanceSnapshotBlock", () => {
  beforeEach(() => {
    isModuleEnabled.mockReset().mockResolvedValue(true);
    readEnergyBalanceForUser.mockReset().mockResolvedValue(balance(10));
  });

  it("carries the window means and the estimated-day count, no day rows", async () => {
    const block = await buildEnergyBalanceSnapshotBlock(
      "u1",
      "Europe/Berlin",
      UNBOUNDED_REACH,
    );
    expect(block).toEqual({
      windowDays: ENERGY_BALANCE_SNAPSHOT_DAYS - 1,
      daysWithBalance: 10,
      meanIntakeKcal: 2100,
      meanExpenditureKcal: 2150,
      meanBalanceKcal: -50,
      restingEstimatedDays: 3,
      basis: expect.stringContaining("not a target"),
    });
    expect(JSON.stringify(block).length).toBeLessThan(300);
    expect(readEnergyBalanceForUser).toHaveBeenCalledWith({
      userId: "u1",
      tz: "Europe/Berlin",
      days: ENERGY_BALANCE_SNAPSHOT_DAYS,
    });
  });

  it("reads nothing with the nutrients module off", async () => {
    isModuleEnabled.mockResolvedValue(false);
    expect(
      await buildEnergyBalanceSnapshotBlock("u1", "UTC", UNBOUNDED_REACH),
    ).toBeNull();
    expect(isModuleEnabled).toHaveBeenCalledWith("u1", "nutrients");
    expect(readEnergyBalanceForUser).not.toHaveBeenCalled();
  });

  it("is left out under a lookback limit shorter than its window", async () => {
    expect(
      await buildEnergyBalanceSnapshotBlock("u1", "UTC", {
        window: "last7days",
        days: 7,
      }),
    ).toBeNull();
    expect(readEnergyBalanceForUser).not.toHaveBeenCalled();
  });

  it("is null when no finished day holds a balance", async () => {
    readEnergyBalanceForUser.mockResolvedValue(balance(0));
    expect(
      await buildEnergyBalanceSnapshotBlock("u1", "UTC", UNBOUNDED_REACH),
    ).toBeNull();
  });

  it("leaves the line out when the read fails", async () => {
    readEnergyBalanceForUser.mockRejectedValue(new Error("db down"));
    expect(
      await buildEnergyBalanceSnapshotBlock("u1", "UTC", UNBOUNDED_REACH),
    ).toBeNull();
  });
});
