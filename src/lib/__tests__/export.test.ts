import { describe, it, expect } from "vitest";
import { toCSV, formatMeasurementsForExport } from "../export";

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
    });
  });
});
