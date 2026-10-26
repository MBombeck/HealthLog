import { describe, expect, it } from "vitest";

import {
  chooseTickInterval,
  computeTickPositions,
  resolveTargetTickCount,
} from "../x-axis-density";

describe("resolveTargetTickCount (v1.4.19 legacy cap helper)", () => {
  it("caps Galaxy Fold compact (≤360px) at 4 ticks", () => {
    expect(resolveTargetTickCount(280)).toBe(4);
    expect(resolveTargetTickCount(360)).toBe(4);
  });

  it("caps Pixel 5 / iPhone 12 (≤480px) at 6 ticks", () => {
    expect(resolveTargetTickCount(361)).toBe(6);
    expect(resolveTargetTickCount(390)).toBe(6);
    expect(resolveTargetTickCount(393)).toBe(6);
    expect(resolveTargetTickCount(480)).toBe(6);
  });

  it("caps small tablet (≤768px) at 8 ticks", () => {
    expect(resolveTargetTickCount(481)).toBe(8);
    expect(resolveTargetTickCount(768)).toBe(8);
  });

  it("caps desktop (>768px) at 10 ticks", () => {
    expect(resolveTargetTickCount(1024)).toBe(10);
    expect(resolveTargetTickCount(1920)).toBe(10);
  });

  it("falls back to desktop default for invalid input", () => {
    expect(resolveTargetTickCount(0)).toBe(10);
    expect(resolveTargetTickCount(-100)).toBe(10);
    expect(resolveTargetTickCount(Number.NaN)).toBe(10);
  });
});

describe("chooseTickInterval (v1.4.25 W3b day-aware policy)", () => {
  // v1.4.25 W3b tunes the policy to calendar-aware buckets so the
  // medication-compliance chart on /insights doesn't paint every-5th-day
  // labels. The policy reads off two viewport classes (mobile <640px,
  // desktop ≥640px) and four data-span buckets keyed on point count.

  describe("mobile (<640px viewport)", () => {
    it("renders every tick for 1-7 daily points (7d compliance window)", () => {
      expect(chooseTickInterval(7, 393)).toBe(0);
    });

    it("steps to every 7th day at 8-31 daily points (30d window)", () => {
      // 30d window on Pixel 5 was the original bug — pre-W3b it produced
      // interval 4 (every-5th-day labels). The new policy snaps to a
      // calendar-week rhythm so labels land on the same weekday across
      // the chart.
      expect(chooseTickInterval(30, 393)).toBe(6);
    });

    it("steps to every 14th day at 32-90 daily points (90d window)", () => {
      expect(chooseTickInterval(90, 393)).toBe(13);
    });

    it("steps to ~monthly at 90+ daily points (365d window)", () => {
      expect(chooseTickInterval(180, 393)).toBe(29);
      expect(chooseTickInterval(365, 393)).toBe(29);
    });
  });

  describe("desktop (≥640px viewport)", () => {
    it("renders every tick for 1-14 daily points", () => {
      expect(chooseTickInterval(14, 1280)).toBe(0);
    });

    it("steps to every 7th day at 15-60 daily points (30d window)", () => {
      // Desktop has more pixel budget so 30 daily ticks could fit, but
      // the calendar-week rhythm is the readability win — and it keeps
      // mobile / desktop labels visually aligned for cross-device users.
      expect(chooseTickInterval(30, 1280)).toBe(6);
    });

    it("steps to every 14th day at 60-180 daily points", () => {
      expect(chooseTickInterval(90, 1280)).toBe(13);
      expect(chooseTickInterval(180, 1280)).toBe(13);
    });

    it("steps to ~monthly at 180+ daily points", () => {
      expect(chooseTickInterval(365, 1280)).toBe(29);
    });
  });

  describe("edge cases", () => {
    it("returns 0 for invalid point count", () => {
      expect(chooseTickInterval(0, 393)).toBe(0);
      expect(chooseTickInterval(-1, 393)).toBe(0);
      expect(chooseTickInterval(Number.NaN, 393)).toBe(0);
    });

    it("falls back to desktop policy for invalid viewport", () => {
      // 30 points at any reasonable viewport sits in the "every 7th
      // day" bucket; an invalid viewport defaults to the desktop
      // policy which lands the same way.
      expect(chooseTickInterval(30, 0)).toBe(6);
      expect(chooseTickInterval(30, Number.NaN)).toBe(6);
    });

    it("never returns a negative interval", () => {
      for (const n of [1, 2, 3, 4, 5, 6, 100, 365]) {
        for (const w of [200, 300, 393, 768, 1280, 1920]) {
          expect(chooseTickInterval(n, w)).toBeGreaterThanOrEqual(0);
        }
      }
    });
  });
});

describe("computeTickPositions — ticks on a calendar grid", () => {
  const DAY = 86_400_000;
  /** Daily points at noon UTC from `start`, leaving out the `missing` days. */
  function daily(start: string, count: number, missing: number[] = []) {
    const t0 = Date.parse(`${start}T12:00:00.000Z`);
    return Array.from({ length: count }, (_, i) => i)
      .filter((i) => !missing.includes(i))
      .map((i) => ({ timestamp: t0 + i * DAY }));
  }
  const dates = (data: { timestamp: number }[], ticks: number[]) =>
    ticks.map((i) => new Date(data[i]!.timestamp).toISOString().slice(0, 10));

  it("returns [] for an empty chart and [0] for one point", () => {
    expect(computeTickPositions([], 393)).toEqual([]);
    expect(computeTickPositions([{ timestamp: 0 }], 393)).toEqual([0]);
  });

  it("labels every day of a week where the width holds it, every other on a phone", () => {
    const data = daily("2026-10-17", 7);
    expect(computeTickPositions(data, 1440)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const phone = dates(data, computeTickPositions(data, 393));
    expect(phone).toHaveLength(3);
  });

  it("puts a 90-day chart with missed days on a two-week grid of Mondays", () => {
    // The reported chart: readings with gaps, labelled every n-th point,
    // fell 18, 14, 13, 17 and 23 days apart.
    const data = daily(
      "2026-07-23",
      90,
      [10, 11, 12, 40, 41, 70, 71, 72, 73, 80],
    );
    const ticks = dates(data, computeTickPositions(data, 1440));
    // 3 August is a grid Monday with no reading; the nearest day stands in.
    expect(ticks).toEqual([
      "2026-08-01",
      "2026-08-17",
      "2026-08-31",
      "2026-09-14",
      "2026-09-28",
      "2026-10-12",
    ]);
    for (const tick of ticks.slice(1)) {
      expect(new Date(`${tick}T12:00:00Z`).getUTCDay()).toBe(1);
    }
  });

  it("takes the nearest point within half a step when the grid date has none", () => {
    // 2026-09-14 (a grid Monday) is missing; the 13th or 15th stands in.
    const data = daily("2026-08-03", 60, [42]);
    const ticks = dates(data, computeTickPositions(data, 1440));
    expect(ticks).toContain("2026-08-17");
    expect(ticks.some((t) => t === "2026-09-13" || t === "2026-09-15")).toBe(
      true,
    );
  });

  it("does not force the last point in, so the final label never crowds", () => {
    const data = daily("2026-07-23", 90);
    const ticks = computeTickPositions(data, 1440);
    expect(ticks[ticks.length - 1]).not.toBe(data.length - 1);
  });

  it("steps to calendar months and quarters on longer spans", () => {
    const year = daily("2025-10-23", 365);
    const months = dates(year, computeTickPositions(year, 1440));
    expect(months.length).toBeGreaterThanOrEqual(4);
    for (const tick of months) expect(tick.endsWith("-01")).toBe(true);

    // Weekly buckets over a year and a bit, on a phone: quarter starts, each
    // taken by the nearest weekly point.
    const weeks = Array.from({ length: 58 }, (_, i) => ({
      timestamp: Date.parse("2025-10-01T12:00:00Z") + i * 7 * DAY,
    }));
    for (const tick of dates(weeks, computeTickPositions(weeks, 393))) {
      const at = Date.parse(`${tick}T12:00:00Z`);
      const quarter = [0, 3, 6, 9].flatMap((m) =>
        [2025, 2026, 2027].map((y) => Date.UTC(y, m, 1, 12)),
      );
      const off = Math.min(...quarter.map((q) => Math.abs(q - at))) / DAY;
      expect(off).toBeLessThanOrEqual(3.5);
    }
  });

  it("keeps under the width's cap, with no duplicate or out-of-range index", () => {
    for (const [width, cap] of [
      [393, 5],
      [1440, 8],
    ] as const) {
      for (const length of [2, 7, 14, 30, 90, 180, 365, 730]) {
        const data = daily("2024-01-01", length);
        const ticks = computeTickPositions(data, width);
        expect(ticks.length).toBeLessThanOrEqual(cap);
        expect(new Set(ticks).size).toBe(ticks.length);
        expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
        for (const t of ticks) {
          expect(t).toBeGreaterThanOrEqual(0);
          expect(t).toBeLessThan(data.length);
        }
      }
    }
  });
});
