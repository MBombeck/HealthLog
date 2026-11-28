import { describe, it, expect } from "vitest";
import { parseCsvMeasurements } from "@/lib/import/csv-measurements";
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

  // Spreadsheet formula injection (OWASP CSV injection): text cells
  // starting with a formula trigger are neutralised with a leading `'`.
  // Third-party text reaches these cells (notes carried in on an import),
  // so a crafted payload must open as literal text.
  it("neutralises formula prefixes in text cells", () => {
    const records = [
      { note: '=HYPERLINK("http://evil","x")' },
      { note: "+SUM(A1:A9)" },
      { note: "-2+3+cmd|' /C calc'!A0" },
      { note: "@SUM(A1)" },
      { note: "\tleading tab" },
    ];
    const lines = toCSV(records).split("\n");
    // RFC 4180 quoting layers on top of the neutralised prefix (the
    // payload carries commas + quotes).
    expect(lines[1]).toBe('"\'=HYPERLINK(""http://evil"",""x"")"');
    expect(lines[2]).toBe("'+SUM(A1:A9)");
    expect(lines[3]).toBe("'-2+3+cmd|' /C calc'!A0");
    expect(lines[4]).toBe("'@SUM(A1)");
    expect(lines[5]).toBe("'\tleading tab");
  });

  it("does not mangle numeric or boolean cells (negative numbers stay bare)", () => {
    const records = [{ delta: -5.2, count: 3, flagged: false }];
    const lines = toCSV(records).split("\n");
    // The number -5.2 is typed `number`, not text — no quote prefix.
    expect(lines[1]).toBe("-5.2,3,false");
  });

  it("leaves benign text cells untouched", () => {
    const records = [{ note: "felt fine after the walk" }];
    expect(toCSV(records).split("\n")[1]).toBe("felt fine after the walk");
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

  // v1.16.16 — glucose unit-at-source. BLOOD_GLUCOSE is stored mg/dL; the
  // CSV export must convert to the user's display unit (matching FHIR) and
  // emit that unit in the `unit` column. mg/dL-preference users unchanged.
  it("keeps BLOOD_GLUCOSE in mg/dL when the user prefers mg/dL", () => {
    const measurements = [
      {
        type: "BLOOD_GLUCOSE",
        value: 100,
        unit: "mg/dL",
        measuredAt: new Date("2025-01-15T08:00:00Z"),
        source: "MANUAL",
        notes: null,
        glucoseContext: "FASTING",
      },
    ];
    const result = formatMeasurementsForExport(measurements, undefined, {
      glucoseUnit: "mg/dL",
    });
    expect(result[0].value).toBe(100);
    expect(result[0].unit).toBe("mg/dL");
  });

  it("converts BLOOD_GLUCOSE value + unit to mmol/L when the user prefers mmol/L", () => {
    const measurements = [
      {
        type: "BLOOD_GLUCOSE",
        value: 100,
        unit: "mg/dL",
        measuredAt: new Date("2025-01-15T08:00:00Z"),
        source: "MANUAL",
        notes: null,
        glucoseContext: "FASTING",
      },
      {
        type: "BLOOD_GLUCOSE",
        value: 126,
        unit: "mg/dL",
        measuredAt: new Date("2025-01-16T08:00:00Z"),
        source: "MANUAL",
        notes: null,
        glucoseContext: "FASTING",
      },
    ];
    const result = formatMeasurementsForExport(measurements, undefined, {
      glucoseUnit: "mmol/L",
    });
    // 100 mg/dL → 5.550 mmol/L, 126 mg/dL → 6.993 mmol/L: three places,
    // so the file reads back as the stored mg/dL value.
    expect(result[0].value).toBe(5.55);
    expect(result[0].unit).toBe("mmol/L");
    expect(result[1].value).toBe(6.993);
    expect(result[1].unit).toBe("mmol/L");
  });

  it("writes mmol/L glucose that the CSV import reads back as the stored value", () => {
    const stored = [54, 70, 99.1, 100, 126, 180, 250.5, 400];
    const records = formatMeasurementsForExport(
      stored.map((value, i) => ({
        type: "BLOOD_GLUCOSE",
        value,
        unit: "mg/dL",
        measuredAt: new Date(Date.UTC(2025, 0, 15, 8, i)),
        source: "MANUAL",
        notes: null,
      })),
      undefined,
      { glucoseUnit: "mmol/L" },
    );
    const back = parseCsvMeasurements(toCSV(records), {
      now: Date.UTC(2025, 1, 1),
    });
    expect(back.rows.map((r) => r.row?.value)).toEqual(stored);
  });

  it("writes mg/dL glucose as stored, tenths included", () => {
    const records = formatMeasurementsForExport(
      [
        {
          type: "BLOOD_GLUCOSE",
          value: 99.1,
          unit: "mg/dL",
          measuredAt: new Date("2025-01-15T08:00:00Z"),
          source: "APPLE_HEALTH",
          notes: null,
        },
      ],
      undefined,
      { glucoseUnit: "mg/dL" },
    );
    expect(records[0].value).toBe(99.1);
  });

  it("does not touch non-glucose rows when a glucose unit is set", () => {
    const measurements = [
      {
        type: "WEIGHT",
        value: 80.4,
        unit: "kg",
        measuredAt: new Date("2025-01-15T08:00:00Z"),
        source: "MANUAL",
        notes: null,
      },
    ];
    const result = formatMeasurementsForExport(measurements, undefined, {
      glucoseUnit: "mmol/L",
    });
    expect(result[0].value).toBe(80.4);
    expect(result[0].unit).toBe("kg");
  });

  // v1.4.25 — per-user timezone offset in exports (issue #167).
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

  // v1.11.5 — sleep collapses to one row per night by default.
  it("collapses SLEEP_DURATION stage rows to one row per night", () => {
    const measurements = [
      {
        type: "SLEEP_DURATION",
        value: 240,
        unit: "minutes",
        measuredAt: new Date("2026-06-04T03:00:00Z"),
        source: "APPLE_HEALTH",
        notes: null,
        sleepStage: "CORE" as const,
      },
      {
        type: "SLEEP_DURATION",
        value: 120,
        unit: "minutes",
        measuredAt: new Date("2026-06-04T05:00:00Z"),
        source: "APPLE_HEALTH",
        notes: null,
        sleepStage: "DEEP" as const,
      },
      {
        type: "SLEEP_DURATION",
        value: 120,
        unit: "minutes",
        measuredAt: new Date("2026-06-04T07:00:00Z"),
        source: "APPLE_HEALTH",
        notes: null,
        sleepStage: "REM" as const,
      },
    ];
    const result = formatMeasurementsForExport(measurements, "UTC", {
      sleepTz: "UTC",
    });
    // One night row, not three stage rows.
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("SLEEP_DURATION");
    // TIME ASLEEP = 240 + 120 + 120 = 480 min.
    expect(result[0].value).toBe(480);
    // Stage breakdown carried in notes.
    expect(String(result[0].notes)).toContain("CORE=240m");
    expect(String(result[0].notes)).toContain("DEEP=120m");
    expect(String(result[0].notes)).toContain("REM=120m");
  });

  it("keeps per-stage sleep rows when granularity is raw", () => {
    const measurements = [
      {
        type: "SLEEP_DURATION",
        value: 240,
        unit: "minutes",
        measuredAt: new Date("2026-06-04T03:00:00Z"),
        source: "APPLE_HEALTH",
        notes: null,
        sleepStage: "CORE" as const,
      },
      {
        type: "SLEEP_DURATION",
        value: 120,
        unit: "minutes",
        measuredAt: new Date("2026-06-04T05:00:00Z"),
        source: "APPLE_HEALTH",
        notes: null,
        sleepStage: "DEEP" as const,
      },
    ];
    const result = formatMeasurementsForExport(measurements, "UTC", {
      granularity: "raw",
    });
    expect(result).toHaveLength(2);
  });

  it("does not collapse non-sleep rows alongside a sleep night", () => {
    const measurements = [
      {
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date("2026-06-04T08:00:00Z"),
        source: "MANUAL",
        notes: null,
      },
      {
        type: "SLEEP_DURATION",
        value: 480,
        unit: "minutes",
        measuredAt: new Date("2026-06-04T06:00:00Z"),
        source: "APPLE_HEALTH",
        notes: null,
        sleepStage: "ASLEEP" as const,
      },
    ];
    const result = formatMeasurementsForExport(measurements, "UTC", {
      sleepTz: "UTC",
    });
    expect(result).toHaveLength(2);
    // Sorted descending by time → WEIGHT (08:00) first, then the sleep night.
    expect(result[0].type).toBe("WEIGHT");
    expect(result[1].type).toBe("SLEEP_DURATION");
    expect(result[1].value).toBe(480);
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

describe("formatMoodEntriesForExport level-A columns", () => {
  const base = {
    date: "2026-05-15",
    mood: "OKAY",
    score: 3,
    tags: null,
    source: "MANUAL",
    moodLoggedAt: new Date("2026-05-15T18:30:00Z"),
  };

  it("appends the five values without moving an existing column", () => {
    const csv = toCSV(
      formatMoodEntriesForExport([
        { ...base, moodA1: 4, stressA2: 9, energyA3: 0 },
      ]),
    );
    const [header, row] = csv.split("\n");
    // The pre-existing columns keep their order and their positions. Somebody's
    // spreadsheet has a formula pointed at column D.
    expect(header).toBe(
      "date,mood,score,tags,note,source,loggedAt,a1,a2,a3,a4,a5",
    );
    expect(row.split(",").slice(0, 3)).toEqual(["2026-05-15", "OKAY", "3"]);
  });

  it("writes an empty cell for an unanswered value and a zero for a zero", () => {
    const csv = toCSV(
      formatMoodEntriesForExport([
        { ...base, moodA1: 4, stressA2: 9, energyA3: 0 },
      ]),
    );
    const cells = csv.split("\n")[1].split(",");
    // a1, a2, a3, a4, a5 — the last two were never answered.
    expect(cells.slice(-5)).toEqual(["4", "9", "0", "", ""]);
  });

  it("leaves every level-A cell empty for an entry written before the columns", () => {
    const csv = toCSV(formatMoodEntriesForExport([base]));
    expect(csv.split("\n")[1].split(",").slice(-5)).toEqual([
      "",
      "",
      "",
      "",
      "",
    ]);
  });
});
