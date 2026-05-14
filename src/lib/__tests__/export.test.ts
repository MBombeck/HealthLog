import { describe, it, expect } from "vitest";
import {
  toCSV,
  formatMeasurementsForExport,
  formatIntakeEventsForExport,
  formatMoodEntriesForExport,
} from "../export";

describe("toCSV", () => {
  it("returns empty string for empty array", () => {
    expect(toCSV([])).toBe("");
  });

  it("generates headers and rows", () => {
    const records = [
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 },
    ];
    const csv = toCSV(records);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("name,age");
    expect(lines[1]).toBe("Alice,30");
    expect(lines[2]).toBe("Bob,25");
  });

  it("escapes commas in values", () => {
    const records = [{ note: "hello, world", value: 1 }];
    const csv = toCSV(records);
    expect(csv).toContain('"hello, world"');
  });

  it("escapes quotes in values", () => {
    const records = [{ note: 'say "hi"', value: 1 }];
    const csv = toCSV(records);
    expect(csv).toContain('"say ""hi"""');
  });

  it("handles null and undefined values", () => {
    const records = [{ a: null, b: undefined, c: "ok" }];
    const csv = toCSV(records);
    expect(csv).toBe("a,b,c\n,,ok");
  });

  it("converts Date objects to ISO string", () => {
    const date = new Date("2025-01-15T12:00:00Z");
    const records = [{ date }];
    const csv = toCSV(records);
    expect(csv).toContain("2025-01-15T12:00:00.000Z");
  });
});

describe("formatMeasurementsForExport", () => {
  it("formats measurement records", () => {
    const measurements = [
      {
        type: "WEIGHT",
        value: 75.5,
        unit: "kg",
        measuredAt: new Date("2025-01-15T08:00:00Z"),
        source: "MANUAL",
        notes: null,
      },
    ];

    const result = formatMeasurementsForExport(measurements);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "WEIGHT",
      value: 75.5,
      unit: "kg",
      measuredAt: "2025-01-15T08:00:00.000Z",
      source: "MANUAL",
      notes: "",
      glucoseContext: "",
    });
  });

  it("round-trips glucoseContext on BLOOD_GLUCOSE rows", () => {
    const measurements = [
      {
        type: "BLOOD_GLUCOSE",
        value: 92,
        unit: "mg/dL",
        measuredAt: new Date("2025-01-15T08:00:00Z"),
        source: "MANUAL",
        notes: null,
        glucoseContext: "FASTING",
      },
    ];
    const result = formatMeasurementsForExport(measurements);
    expect(result[0]).toMatchObject({
      type: "BLOOD_GLUCOSE",
      glucoseContext: "FASTING",
    });
  });

  // v1.4.25 W7 — per-user timezone offset in exports (issue #167).
  it("emits ISO-8601 with user-tz offset when userTz is provided", () => {
    const measurements = [
      {
        type: "WEIGHT",
        value: 75.5,
        unit: "kg",
        // 09:00 UTC = 11:00 Europe/Berlin (CEST in May).
        measuredAt: new Date("2026-05-15T09:00:00Z"),
        source: "MANUAL",
        notes: null,
      },
    ];
    const result = formatMeasurementsForExport(measurements, "Europe/Berlin");
    expect(result[0].measuredAt).toBe("2026-05-15T11:00:00+02:00");
  });

  it("emits the user's positive offset for Pacific/Auckland", () => {
    const measurements = [
      {
        type: "WEIGHT",
        value: 75.5,
        unit: "kg",
        measuredAt: new Date("2026-05-15T09:00:00Z"),
        source: "MANUAL",
        notes: null,
      },
    ];
    const result = formatMeasurementsForExport(
      measurements,
      "Pacific/Auckland",
    );
    expect(result[0].measuredAt).toBe("2026-05-15T21:00:00+12:00");
  });

  it("falls back to UTC Z suffix when no userTz is provided", () => {
    const measurements = [
      {
        type: "WEIGHT",
        value: 75.5,
        unit: "kg",
        measuredAt: new Date("2026-05-15T09:00:00Z"),
        source: "MANUAL",
        notes: null,
      },
    ];
    const result = formatMeasurementsForExport(measurements);
    expect(result[0].measuredAt).toBe("2026-05-15T09:00:00.000Z");
  });
});

describe("formatIntakeEventsForExport with userTz", () => {
  it("emits scheduledFor and takenAt with offset", () => {
    const events = [
      {
        medication: { name: "Aspirin" },
        scheduledFor: new Date("2026-05-15T06:00:00Z"),
        takenAt: new Date("2026-05-15T06:05:00Z"),
        skipped: false,
        source: "MANUAL",
      },
    ];
    const result = formatIntakeEventsForExport(events, "Europe/Berlin");
    expect(result[0].scheduledFor).toBe("2026-05-15T08:00:00+02:00");
    expect(result[0].takenAt).toBe("2026-05-15T08:05:00+02:00");
  });

  it("emits empty takenAt for skipped intakes", () => {
    const events = [
      {
        medication: { name: "Aspirin" },
        scheduledFor: new Date("2026-05-15T06:00:00Z"),
        takenAt: null,
        skipped: true,
        source: "MANUAL",
      },
    ];
    const result = formatIntakeEventsForExport(events, "Europe/Berlin");
    expect(result[0].takenAt).toBe("");
  });
});

describe("formatMoodEntriesForExport with userTz", () => {
  it("emits loggedAt with offset while preserving the stored date column", () => {
    const entries = [
      {
        date: "2026-05-15",
        mood: "GREAT",
        score: 5,
        tags: null,
        source: "MANUAL",
        moodLoggedAt: new Date("2026-05-15T18:30:00Z"),
      },
    ];
    const result = formatMoodEntriesForExport(entries, "America/New_York");
    expect(result[0].date).toBe("2026-05-15"); // Stored column unchanged.
    expect(result[0].loggedAt).toBe("2026-05-15T14:30:00-04:00");
  });
});
