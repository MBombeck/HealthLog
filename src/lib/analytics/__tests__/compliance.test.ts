import { describe, it, expect, beforeEach, vi } from "vitest";
import { calculateCompliance } from "../compliance";

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
});
