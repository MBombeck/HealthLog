import { describe, expect, it } from "vitest";

import { daysBetweenDateKeys, shiftDateKey } from "@/lib/tz/format";

describe("shiftDateKey", () => {
  it("steps a day key backward and forward", () => {
    expect(shiftDateKey("2026-06-15", -1)).toBe("2026-06-14");
    expect(shiftDateKey("2026-06-15", 1)).toBe("2026-06-16");
  });

  it("rolls over a month boundary", () => {
    expect(shiftDateKey("2026-06-01", -1)).toBe("2026-05-31");
    expect(shiftDateKey("2026-05-31", 1)).toBe("2026-06-01");
  });

  it("rolls over a year boundary", () => {
    expect(shiftDateKey("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDateKey("2025-12-31", 1)).toBe("2026-01-01");
  });

  it("is unaffected by DST transitions (pure UTC-anchored calendar math)", () => {
    // Europe/Berlin spring-forward day 2026-03-29 — the day key itself is
    // just a calendar date, so stepping across it is a plain +/-1 day.
    expect(shiftDateKey("2026-03-29", 1)).toBe("2026-03-30");
    expect(shiftDateKey("2026-03-29", -1)).toBe("2026-03-28");
  });

  it("supports multi-day deltas", () => {
    expect(shiftDateKey("2026-06-15", 7)).toBe("2026-06-22");
    expect(shiftDateKey("2026-06-15", -30)).toBe("2026-05-16");
  });
});

describe("day-key arithmetic across month, year and DST boundaries", () => {
  it("steps calendar days, not 24-hour spans", () => {
    expect(shiftDateKey("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDateKey("2024-02-28", 1)).toBe("2024-02-29");
    // Europe's spring-forward and fall-back days are ordinary calendar steps.
    expect(shiftDateKey("2026-03-28", 1)).toBe("2026-03-29");
    expect(shiftDateKey("2026-03-29", 1)).toBe("2026-03-30");
    expect(shiftDateKey("2026-10-25", -1)).toBe("2026-10-24");
    expect(daysBetweenDateKeys("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysBetweenDateKeys("2026-10-26", "2026-10-24")).toBe(-2);
  });
});
