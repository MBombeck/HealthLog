/**
 * The nutrient read stops at a row cap, ordered by day. A cap that falls in
 * the middle of a day leaves that day with some of its sources, and the
 * day-total rule (the largest whole-day source wins) would then judge it on
 * whatever happened to be read. The read keeps whole days only.
 */
import { describe, expect, it, vi } from "vitest";

const nutrientFindMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    nutrientIntakeDay: { findMany: (a: unknown) => nutrientFindMany(a) },
  },
}));

import { fetchNutrientSeries } from "@/lib/insights/correlation-channel-series";

const CAP = 20_000;

function dayKey(offset: number): string {
  return new Date(Date.UTC(2026, 5, 30) - offset * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

describe("fetchNutrientSeries", () => {
  it("drops the oldest day when the cap cut it", async () => {
    // Newest first, as the read orders them: one caffeine row a day, then the
    // oldest day's water, of which only the smaller source made the cut.
    const rows: Array<{
      day: string;
      nutrient: string;
      amount: number;
      source: string;
    }> = [];
    for (let i = 0; rows.length < CAP - 1; i += 1) {
      rows.push({
        day: dayKey(i),
        nutrient: "water",
        amount: 2_000,
        source: "APPLE_HEALTH",
      });
    }
    const oldest = dayKey(CAP);
    rows.push({
      day: oldest,
      nutrient: "water",
      amount: 300,
      source: "HEALTH_CONNECT",
    });
    nutrientFindMany.mockResolvedValueOnce(rows);

    const series = await fetchNutrientSeries(
      "user-1",
      "UTC",
      new Date("1960-01-01T00:00:00Z"),
    );
    const water = series.find((s) => s.key === "HYDRATION");
    expect(water?.points.some((p) => p.day === oldest)).toBe(false);
    expect(water?.points).toHaveLength(CAP - 1);
  });

  it("keeps every day when the read did not reach the cap", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      day: dayKey(i),
      nutrient: "water",
      amount: 1_500,
      source: "APPLE_HEALTH",
    }));
    nutrientFindMany.mockResolvedValueOnce(rows);
    const series = await fetchNutrientSeries(
      "user-1",
      "UTC",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(series.find((s) => s.key === "HYDRATION")?.points).toHaveLength(30);
  });
});
