import { describe, expect, it } from "vitest";

import { chooseTickInterval, resolveTargetTickCount } from "../x-axis-density";

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
