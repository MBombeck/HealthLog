import { describe, it, expect, beforeEach, vi } from "vitest";
import { calculateCompliance, classifyIntakeTiming } from "../compliance";
import type { IntakeTimingClass } from "../compliance";

describe("calculateCompliance", () => {
  // Fix "now" for deterministic tests
  const NOW = new Date("2025-01-15T12:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("returns 100% rate with no schedules", () => {
    const result = calculateCompliance([], [], 7);
    expect(result).toEqual({
      totalExpected: 0,
      taken: 0,
      skipped: 0,
      missed: 0,
      rate: 100,
      streak: 0,
    });
  });

  it("calculates correct totals for taken events", () => {
    const schedules = [{ windowStart: "08:00", windowEnd: "09:00" }];
    const events = [
      {
        takenAt: new Date("2025-01-14T08:30:00Z"),
        skipped: false,
        scheduledFor: new Date("2025-01-14T08:00:00Z"),
      },
      {
        takenAt: new Date("2025-01-13T08:30:00Z"),
        skipped: false,
        scheduledFor: new Date("2025-01-13T08:00:00Z"),
      },
    ];

    const result = calculateCompliance(events, schedules, 7);
    expect(result.totalExpected).toBe(7);
    expect(result.taken).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.missed).toBe(5);
    expect(result.rate).toBe(29); // Math.round(2/7 * 100)
  });

  it("counts skipped events separately from taken", () => {
    const schedules = [{ windowStart: "08:00", windowEnd: "09:00" }];
    const events = [
      {
        takenAt: new Date("2025-01-14T08:30:00Z"),
        skipped: false,
        scheduledFor: new Date("2025-01-14T08:00:00Z"),
      },
      {
        takenAt: null,
        skipped: true,
        scheduledFor: new Date("2025-01-13T08:00:00Z"),
      },
    ];

    const result = calculateCompliance(events, schedules, 7);
    expect(result.taken).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.missed).toBe(5);
    expect(result.rate).toBe(14); // Math.round(1/7 * 100)
  });

  it("calculates streak for consecutive days", () => {
    const schedules = [{ windowStart: "08:00", windowEnd: "09:00" }];

    // Create events for the last 3 consecutive days
    const events = [
      {
        takenAt: new Date("2025-01-14T20:00:00Z"),
        skipped: false,
        scheduledFor: new Date("2025-01-14T20:00:00Z"),
      },
      {
        takenAt: new Date("2025-01-13T20:00:00Z"),
        skipped: false,
        scheduledFor: new Date("2025-01-13T20:00:00Z"),
      },
      {
        takenAt: new Date("2025-01-12T20:00:00Z"),
        skipped: false,
        scheduledFor: new Date("2025-01-12T20:00:00Z"),
      },
    ];

    const result = calculateCompliance(events, schedules, 7);
    // Streak counts backwards from now: day0 = Jan15-Jan14, day1 = Jan14-Jan13, day2 = Jan13-Jan12
    // Events scheduled at 20:00 fall in the right day windows
    expect(result.streak).toBe(3);
  });

  it("streak breaks on missed day", () => {
    const schedules = [{ windowStart: "08:00", windowEnd: "09:00" }];

    // Day d=0 (Jan14-Jan15): taken
    // Day d=1 (Jan13-Jan14): missing!
    // Day d=2 (Jan12-Jan13): taken
    const events = [
      {
        takenAt: new Date("2025-01-14T20:00:00Z"),
        skipped: false,
        scheduledFor: new Date("2025-01-14T20:00:00Z"),
      },
      {
        takenAt: new Date("2025-01-12T20:00:00Z"),
        skipped: false,
        scheduledFor: new Date("2025-01-12T20:00:00Z"),
      },
    ];

    const result = calculateCompliance(events, schedules, 7);
    expect(result.streak).toBe(1); // Only the most recent day
  });

  it("handles multiple schedules per day", () => {
    const schedules = [
      { windowStart: "08:00", windowEnd: "09:00" },
      { windowStart: "20:00", windowEnd: "21:00" },
    ];

    // 2 schedules * 3 days = 6 expected
    const events = [
      {
        takenAt: new Date("2025-01-14T08:30:00Z"),
        skipped: false,
        scheduledFor: new Date("2025-01-14T08:30:00Z"),
      },
      {
        takenAt: new Date("2025-01-14T20:30:00Z"),
        skipped: false,
        scheduledFor: new Date("2025-01-14T20:30:00Z"),
      },
      {
        takenAt: new Date("2025-01-13T08:30:00Z"),
        skipped: false,
        scheduledFor: new Date("2025-01-13T08:30:00Z"),
      },
    ];

    const result = calculateCompliance(events, schedules, 3);
    expect(result.totalExpected).toBe(6);
    expect(result.taken).toBe(3);
    expect(result.missed).toBe(3);
    expect(result.rate).toBe(50);
  });

  it("filters events outside the period", () => {
    const schedules = [{ windowStart: "08:00", windowEnd: "09:00" }];

    const events = [
      // Within period
      {
        takenAt: new Date("2025-01-14T08:30:00Z"),
        skipped: false,
        scheduledFor: new Date("2025-01-14T08:00:00Z"),
      },
      // Outside period (30 days ago)
      {
        takenAt: new Date("2024-12-01T08:30:00Z"),
        skipped: false,
        scheduledFor: new Date("2024-12-01T08:00:00Z"),
      },
    ];

    const result = calculateCompliance(events, schedules, 7);
    expect(result.taken).toBe(1);
  });

  it("handles perfect compliance", () => {
    const schedules = [{ windowStart: "08:00", windowEnd: "09:00" }];

    // Create an event for each of the 7 days
    const events = Array.from({ length: 7 }, (_, i) => ({
      takenAt: new Date(NOW.getTime() - (i + 0.5) * 24 * 60 * 60 * 1000),
      skipped: false,
      scheduledFor: new Date(NOW.getTime() - (i + 0.5) * 24 * 60 * 60 * 1000),
    }));

    const result = calculateCompliance(events, schedules, 7);
    expect(result.rate).toBe(100);
    expect(result.missed).toBe(0);
    expect(result.streak).toBe(7);
  });

  it("caps compliance rate at 100% when more intakes than expected exist", () => {
    const schedules = [{ windowStart: "08:00", windowEnd: "09:00" }];
    const events = Array.from({ length: 10 }, (_, i) => ({
      takenAt: new Date("2025-01-14T08:30:00Z"),
      skipped: false,
      scheduledFor: new Date(`2025-01-14T08:${String(i).padStart(2, "0")}:00Z`),
    }));

    const result = calculateCompliance(events, schedules, 7);
    expect(result.rate).toBe(100);
  });
});

describe("classifyIntakeTiming", () => {
  // v1.4.34 IW-C — the classifier now widens the pre-window grace to
  // 3h and introduces an `early` bucket so a proactive logger (10 min
  // before the window) is no longer flushed to `very_late`. Doses up
  // to 3h past `windowEnd` stay `on_time`; `late` spans the next 2h
  // tail; anything beyond is `very_late`. Overnight windows are
  // exercised in parallel by the parameterised matrix below.
  const scheduledDate = new Date("2025-01-15T00:00:00Z");

  it('returns "missed" when takenAt is null', () => {
    expect(classifyIntakeTiming(null, "08:00", "09:00", scheduledDate)).toBe(
      "missed",
    );
  });

  it('returns "on_time" when taken within the window', () => {
    const takenAt = new Date("2025-01-15T08:30:00Z");
    expect(classifyIntakeTiming(takenAt, "08:00", "09:00", scheduledDate)).toBe(
      "on_time",
    );
  });

  it('returns "on_time" when taken exactly at windowStart', () => {
    const takenAt = new Date("2025-01-15T08:00:00Z");
    expect(classifyIntakeTiming(takenAt, "08:00", "09:00", scheduledDate)).toBe(
      "on_time",
    );
  });

  it('returns "on_time" when taken exactly at windowEnd', () => {
    const takenAt = new Date("2025-01-15T09:00:00Z");
    expect(classifyIntakeTiming(takenAt, "08:00", "09:00", scheduledDate)).toBe(
      "on_time",
    );
  });

  // Parameterised offset matrix relative to a `08:00 → 09:00` window.
  // Negative offsets are minutes before `windowStart` (08:00); positive
  // offsets are minutes after `windowEnd` (09:00). The reference
  // boundaries are: `early` from -180 to -1 min before start; `on_time`
  // from start through windowEnd + 180 min; `late` for the next 120
  // min; `very_late` past that or beyond the 3h pre-window grace.
  it.each<[label: string, offsetMin: number, expected: IntakeTimingClass]>([
    ["3.5h before window → very_late", -210, "very_late"],
    ["exactly 3h before window → early", -180, "early"],
    ["1h before window → early", -60, "early"],
    ["10 min before window → early", -10, "early"],
    ["exactly at windowStart → on_time", 0, "on_time"],
    ["10 min into the window → on_time", 10, "on_time"],
    ["20 min past windowEnd → on_time", 80, "on_time"],
    ["1h past windowEnd → on_time", 120, "on_time"],
    ["exactly 3h past windowEnd → on_time", 240, "on_time"],
    ["3.5h past windowEnd → late", 270, "late"],
    ["5h past windowEnd → late (tail boundary)", 360, "late"],
    ["5h 1min past windowEnd → very_late", 361, "very_late"],
  ])("offset case: %s", (_label, offsetMin, expected) => {
    // The matrix expresses offsets relative to windowStart (negative)
    // or relative to windowEnd (positive). 0 sits at windowStart, +60
    // sits at windowEnd, then positive offsets accumulate past
    // windowEnd. With windowStart=08:00 and windowEnd=09:00, the
    // base instant is 08:00Z; positive offsets walk forward from there.
    const baseMs = new Date("2025-01-15T08:00:00Z").getTime();
    const takenAt = new Date(baseMs + offsetMin * 60 * 1000);
    expect(classifyIntakeTiming(takenAt, "08:00", "09:00", scheduledDate)).toBe(
      expected,
    );
  });

  it('returns "very_late" when taken way before the grace period', () => {
    const takenAt = new Date("2025-01-15T03:00:00Z"); // 5h before 08:00
    expect(classifyIntakeTiming(takenAt, "08:00", "09:00", scheduledDate)).toBe(
      "very_late",
    );
  });

  it('respects the configurable `lateMinutes` tail', () => {
    // With lateMinutes=30 the late tail collapses to 30 min after the
    // 3h on-time grace. windowEnd is 09:00 so `on_time` extends to
    // 12:00 and `late` extends to 12:30. A dose at 12:15 falls in
    // `late`; one at 12:45 falls in `very_late`.
    const takenLate = new Date("2025-01-15T12:15:00Z");
    expect(
      classifyIntakeTiming(takenLate, "08:00", "09:00", scheduledDate, {
        lateMinutes: 30,
      }),
    ).toBe("late");

    const takenVeryLate = new Date("2025-01-15T12:45:00Z");
    expect(
      classifyIntakeTiming(takenVeryLate, "08:00", "09:00", scheduledDate, {
        lateMinutes: 30,
      }),
    ).toBe("very_late");
  });

  it("handles overnight windows (windowEnd < windowStart)", () => {
    // Schedule: 23:00 - 01:00 (overnight)
    const takenAt = new Date("2025-01-15T23:30:00Z");
    expect(classifyIntakeTiming(takenAt, "23:00", "01:00", scheduledDate)).toBe(
      "on_time",
    );
  });

  it("handles overnight window early intake", () => {
    // Schedule: 23:00 - 01:00, taken at 22:30 (30 min before windowStart)
    const takenAt = new Date("2025-01-15T22:30:00Z");
    expect(classifyIntakeTiming(takenAt, "23:00", "01:00", scheduledDate)).toBe(
      "early",
    );
  });

  it("handles overnight window late intake", () => {
    // Schedule: 23:00 - 01:00, taken at 04:30 (3.5h past 01:00)
    const takenAt = new Date("2025-01-16T04:30:00Z");
    expect(classifyIntakeTiming(takenAt, "23:00", "01:00", scheduledDate)).toBe(
      "late",
    );
  });

  it("handles overnight window very late intake", () => {
    // Schedule: 23:00 - 01:00, taken at 07:00 (6h past 01:00)
    const takenAt = new Date("2025-01-16T07:00:00Z");
    expect(classifyIntakeTiming(takenAt, "23:00", "01:00", scheduledDate)).toBe(
      "very_late",
    );
  });
});
