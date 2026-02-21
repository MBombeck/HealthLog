import { describe, it, expect, beforeEach, vi } from "vitest";
import { calculateCompliance, classifyIntakeTiming } from "../compliance";

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

  it('returns "on_time" when taken within 1h grace period before windowStart', () => {
    const takenAt = new Date("2025-01-15T07:15:00Z"); // 45 min before 08:00
    expect(classifyIntakeTiming(takenAt, "08:00", "09:00", scheduledDate)).toBe(
      "on_time",
    );
  });

  it('returns "late" when taken within 2h after windowEnd', () => {
    const takenAt = new Date("2025-01-15T10:30:00Z"); // 1.5h after 09:00
    expect(classifyIntakeTiming(takenAt, "08:00", "09:00", scheduledDate)).toBe(
      "late",
    );
  });

  it('returns "late" when taken right after windowEnd', () => {
    const takenAt = new Date("2025-01-15T09:01:00Z"); // 1 min after 09:00
    expect(classifyIntakeTiming(takenAt, "08:00", "09:00", scheduledDate)).toBe(
      "late",
    );
  });

  it('returns "very_late" when taken more than 2h after windowEnd', () => {
    const takenAt = new Date("2025-01-15T14:00:00Z"); // 5h after 09:00
    expect(classifyIntakeTiming(takenAt, "08:00", "09:00", scheduledDate)).toBe(
      "very_late",
    );
  });

  it('returns "very_late" when taken way before the grace period', () => {
    const takenAt = new Date("2025-01-15T03:00:00Z"); // 5h before 08:00
    expect(classifyIntakeTiming(takenAt, "08:00", "09:00", scheduledDate)).toBe(
      "very_late",
    );
  });

  it("handles overnight windows (windowEnd < windowStart)", () => {
    // Schedule: 23:00 - 01:00 (overnight)
    const takenAt = new Date("2025-01-15T23:30:00Z");
    expect(classifyIntakeTiming(takenAt, "23:00", "01:00", scheduledDate)).toBe(
      "on_time",
    );
  });

  it("handles overnight window late intake", () => {
    // Schedule: 23:00 - 01:00, taken at 02:00 (1h late)
    const takenAt = new Date("2025-01-16T02:00:00Z");
    expect(classifyIntakeTiming(takenAt, "23:00", "01:00", scheduledDate)).toBe(
      "late",
    );
  });

  it("handles overnight window very late intake", () => {
    // Schedule: 23:00 - 01:00, taken at 04:00 (3h late)
    const takenAt = new Date("2025-01-16T04:00:00Z");
    expect(classifyIntakeTiming(takenAt, "23:00", "01:00", scheduledDate)).toBe(
      "very_late",
    );
  });
});
