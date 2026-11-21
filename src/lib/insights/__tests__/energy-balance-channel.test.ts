/**
 * The ENERGY_BALANCE channel: finished days with a balance only, never a
 * zero for a missing input, and in the intake family so it is never paired
 * with the energy intake it is computed from.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const readEnergyBalanceForUser = vi.fn();
const intakeFindMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    nutrientIntakeDay: { findMany: (a: unknown) => intakeFindMany(a) },
  },
}));
vi.mock("@/lib/nutrients/energy-balance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/nutrients/energy-balance")>()),
  readEnergyBalanceForUser: (...args: unknown[]) =>
    readEnergyBalanceForUser(...args),
}));

import {
  ENERGY_BALANCE_CHANNEL_KEY,
  metricFamily,
} from "@/lib/insights/correlation-discovery";
import {
  ENERGY_BALANCE_SCAN_MAX_DAYS,
  energyBalanceScanDays,
  fetchEnergyBalanceSeries,
} from "@/lib/insights/energy-balance-channel";
import { MIN_PAIRED_N } from "@/lib/insights/correlations";
import type { EnergyBalanceDay } from "@/lib/nutrients/energy-balance";
import {
  correlationChannelSurfaceId,
  surfaceModule,
} from "@/lib/modules/surface";

function day(
  n: number,
  balanceKcal: number | null,
  partial = false,
): EnergyBalanceDay {
  return {
    day: new Date(Date.UTC(2026, 6, n)).toISOString().slice(0, 10),
    intakeKcal: balanceKcal === null ? null : 2000,
    restingKcal: 1600,
    restingEstimated: false,
    activeKcal: 400,
    expenditureKcal: 2000,
    balanceKcal,
    trendKcal: null,
    partial,
  };
}

function balanceOf(days: EnergyBalanceDay[]) {
  return {
    windowDays: days.length,
    days,
    summary: {
      daysWithBalance: 0,
      meanIntakeKcal: null,
      meanExpenditureKcal: null,
      meanBalanceKcal: null,
    },
    estimateGaps: [],
  };
}

describe("fetchEnergyBalanceSeries", () => {
  beforeEach(() => {
    readEnergyBalanceForUser.mockReset();
    intakeFindMany.mockReset();
    intakeFindMany.mockResolvedValue(
      Array.from({ length: MIN_PAIRED_N }, (_, i) => ({ day: `d${i}` })),
    );
  });

  it("reads nothing more when fewer intake days than the floor exist", async () => {
    intakeFindMany.mockResolvedValue([{ day: "2026-08-01" }]);
    const [series] = await fetchEnergyBalanceSeries(
      "u1",
      "UTC",
      new Date("2026-08-01T00:00:00Z"),
      new Date("2026-08-30T00:00:00Z"),
    );
    expect(series.points).toEqual([]);
    expect(readEnergyBalanceForUser).not.toHaveBeenCalled();
  });

  it("keeps only finished days that hold a balance, oldest first", async () => {
    const days = Array.from({ length: 45 }, (_, i) =>
      day(i + 1, i % 3 === 0 ? null : (i - 15) * 10),
    );
    days[44] = day(45, 999, true);
    readEnergyBalanceForUser.mockResolvedValue(balanceOf(days));

    const [series] = await fetchEnergyBalanceSeries(
      "u1",
      "Europe/Berlin",
      new Date("2026-08-01T00:00:00Z"),
      new Date("2026-08-30T12:00:00Z"),
    );
    expect(series.key).toBe(ENERGY_BALANCE_CHANNEL_KEY);
    expect(series.role).toBe("behaviour");
    // Days 1, 4, 7 … have no balance and the partial today is left out.
    expect(series.points.map((p) => p.day)).not.toContain("2026-07-01");
    expect(series.points.map((p) => p.day)).not.toContain("2026-08-14");
    expect(
      series.points.some((p) => p.value === 0 && p.day === "2026-07-16"),
    ).toBe(false);
    expect(series.points.every((p) => Number.isFinite(p.value))).toBe(true);
    expect(series.points).toHaveLength(29);
    const sorted = [...series.points].sort((a, b) => (a.day < b.day ? -1 : 1));
    expect(series.points).toEqual(sorted);
  });

  it("is empty below the paired-day floor", async () => {
    const days = Array.from({ length: MIN_PAIRED_N - 1 }, (_, i) =>
      day(i + 1, 100 + i),
    );
    readEnergyBalanceForUser.mockResolvedValue(balanceOf(days));
    const [series] = await fetchEnergyBalanceSeries(
      "u1",
      "UTC",
      new Date("2026-08-01T00:00:00Z"),
      new Date("2026-08-30T00:00:00Z"),
    );
    expect(series.points).toEqual([]);
  });

  it("reads the scan window, clamped to the read's bounds", () => {
    const now = new Date("2026-08-30T12:00:00Z");
    expect(energyBalanceScanDays(new Date("2026-08-28T12:00:00Z"), now)).toBe(
      7,
    );
    expect(energyBalanceScanDays(new Date("2026-06-01T12:00:00Z"), now)).toBe(
      91,
    );
    expect(energyBalanceScanDays(new Date("2020-01-01T00:00:00Z"), now)).toBe(
      ENERGY_BALANCE_SCAN_MAX_DAYS,
    );
  });
});

describe("the ENERGY_BALANCE channel", () => {
  it("sits in the intake family, so it never pairs with energy intake", () => {
    expect(metricFamily(ENERGY_BALANCE_CHANNEL_KEY)).toBe("NUTRIENTS");
    expect(metricFamily(ENERGY_BALANCE_CHANNEL_KEY)).toBe(
      metricFamily("NUTRIENT:energy"),
    );
  });

  it("is owned by the nutrients module", () => {
    expect(
      surfaceModule(correlationChannelSurfaceId(ENERGY_BALANCE_CHANNEL_KEY)),
    ).toBe("nutrients");
  });
});
