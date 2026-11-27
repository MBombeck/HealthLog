import { describe, it, expect } from "vitest";
import { MGDL_PER_MMOL, mgdlToMmol } from "@/lib/glucose";

import {
  parseCsvMeasurements,
  splitCsvRows,
} from "@/lib/import/csv-measurements";

// Pin the clock so the entry-instant bound is deterministic. All fixture
// timestamps sit comfortably in the past relative to this.
const NOW = new Date("2026-06-01T00:00:00.000Z").getTime();

const HEADER = "type,value,unit,measuredAt,glucoseContext,notes,externalId";

function parse(rows: string[]) {
  return parseCsvMeasurements([HEADER, ...rows].join("\n"), { now: NOW });
}

describe("splitCsvRows", () => {
  it("handles CRLF, quoted commas, escaped quotes, and a BOM", () => {
    const csv = '﻿a,b,c\r\n1,"x,y","he said ""hi"""\r\n2,plain,z\r\n';
    const grid = splitCsvRows(csv);
    expect(grid).toEqual([
      ["a", "b", "c"],
      ["1", "x,y", 'he said "hi"'],
      ["2", "plain", "z"],
    ]);
  });

  it("drops trailing blank lines", () => {
    expect(splitCsvRows("a,b\n1,2\n\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("parseCsvMeasurements — header validation", () => {
  it("is fatal when a required column is missing", () => {
    const out = parseCsvMeasurements("type,value,unit\nWEIGHT,80,kg", {
      now: NOW,
    });
    expect(out.fatal?.reason).toBe("missing_required_column");
    expect(out.rows).toEqual([]);
  });

  it("is fatal on an empty file", () => {
    const out = parseCsvMeasurements("", { now: NOW });
    expect(out.fatal?.reason).toBe("missing_required_column");
  });

  it("accepts columns in any order", () => {
    const out = parseCsvMeasurements(
      [
        "unit,measuredAt,type,value",
        "kg,2026-05-01T08:00:00Z,WEIGHT,80.5",
      ].join("\n"),
      { now: NOW },
    );
    expect(out.fatal).toBeUndefined();
    expect(out.rows[0].status).toBe("ok");
    expect(out.rows[0].row?.value).toBe(80.5);
  });
});

describe("parseCsvMeasurements — per-row partial failure", () => {
  it("imports the good rows and skips the bad ones with distinct reasons", () => {
    const out = parse([
      "WEIGHT,80.5,kg,2026-05-01T08:00:00Z,,morning,", // ok
      "NOPE,1,kg,2026-05-01T08:00:00Z,,,", // unknown_type
      "WEIGHT,9999,kg,2026-05-01T08:00:00Z,,,", // value_out_of_range
      "WEIGHT,80,kg,2026-05-01T08:00:00,,,", // missing_timezone_offset
    ]);
    const byLine = Object.fromEntries(
      out.rows.map((r) => [r.line, { status: r.status, reason: r.reason }]),
    );
    expect(byLine[2]).toEqual({ status: "ok", reason: undefined });
    expect(byLine[3]).toEqual({ status: "skipped", reason: "unknown_type" });
    expect(byLine[4]).toEqual({
      status: "skipped",
      reason: "value_out_of_range",
    });
    expect(byLine[5]).toEqual({
      status: "skipped",
      reason: "missing_timezone_offset",
    });
  });

  it("reports line numbers 1-based with the header as line 1", () => {
    const out = parse(["WEIGHT,80,kg,2026-05-01T08:00:00Z,,,"]);
    expect(out.rows[0].line).toBe(2);
  });
});

describe("parseCsvMeasurements — unit conversion", () => {
  it("converts glucose mmol/L to canonical mg/dL", () => {
    const out = parse([
      "BLOOD_GLUCOSE,5.3,mmol/L,2026-05-01T08:00:00Z,FASTING,,",
    ]);
    expect(out.rows[0].status).toBe("ok");
    expect(out.rows[0].row?.unit).toBe("mg/dL");
    // The one factor the app converts glucose by, both directions. The
    // literal that used to sit here was 18.016 while every display path
    // divided by 18.0182, so a reading imported in mmol/L did not read back
    // as the number it went in as.
    expect(out.rows[0].row?.value).toBe(
      Math.round(5.3 * MGDL_PER_MMOL * 10) / 10,
    );
    expect(mgdlToMmol(out.rows[0].row?.value ?? 0)).toBe(5.3);
  });

  it("converts weight lb to canonical kg", () => {
    const out = parse(["WEIGHT,180,lb,2026-05-01T08:00:00Z,,,"]);
    expect(out.rows[0].status).toBe("ok");
    expect(out.rows[0].row?.unit).toBe("kg");
    expect(out.rows[0].row?.value).toBeCloseTo(180 * 0.453592, 3);
  });

  it("accepts the canonical unit case-insensitively", () => {
    const out = parse(["WEIGHT,80,KG,2026-05-01T08:00:00Z,,,"]);
    expect(out.rows[0].status).toBe("ok");
    expect(out.rows[0].row?.unit).toBe("kg");
  });

  it("skips an unrecognised unit rather than mis-storing", () => {
    const out = parse(["WEIGHT,80,stone,2026-05-01T08:00:00Z,,,"]);
    expect(out.rows[0]).toMatchObject({
      status: "skipped",
      reason: "unknown_unit",
    });
  });
});

describe("parseCsvMeasurements — timezone + entry-instant bound", () => {
  it("skips a timestamp without an offset (no silent local interpretation)", () => {
    const out = parse(["WEIGHT,80,kg,2026-05-01T08:00:00,,,"]);
    expect(out.rows[0].reason).toBe("missing_timezone_offset");
  });

  it("accepts both Z and ±HH:MM offsets", () => {
    const out = parse([
      "WEIGHT,80,kg,2026-05-01T08:00:00Z,,,",
      "WEIGHT,81,kg,2026-05-01T08:00:00+02:00,,,",
    ]);
    expect(out.rows.map((r) => r.status)).toEqual(["ok", "ok"]);
  });

  it("reads an offset with or without a colon, and a space before the time", () => {
    const out = parse([
      "WEIGHT,80,kg,2026-05-01T08:00:00+0200,,,",
      "WEIGHT,81,kg,2026-05-01 08:00+02:00,,,",
      "WEIGHT,82,kg,2026-05-01T08:00:00.250-03:30,,,",
    ]);
    expect(out.rows.map((r) => r.row?.measuredAt.toISOString())).toEqual([
      "2026-05-01T06:00:00.000Z",
      "2026-05-01T06:00:00.000Z",
      "2026-05-01T11:30:00.250Z",
    ]);
  });

  it("does not take the year of a day-first date for an offset", () => {
    // `-2026` looked like an offset, and the date was then read month-first
    // in the server's zone: 5 November instead of 11 May.
    const out = parse([
      "WEIGHT,80,kg,11-05-2026,,,",
      "WEIGHT,80,kg,11.05.2026 08:00+02:00,,,",
      "WEIGHT,80,kg,05/11/2026 08:00Z,,,",
    ]);
    expect(out.rows.map((r) => r.reason)).toEqual([
      "invalid_timestamp",
      "invalid_timestamp",
      "invalid_timestamp",
    ]);
  });

  it("refuses a day that does not exist", () => {
    const out = parse(["WEIGHT,80,kg,2026-02-30T08:00:00Z,,,"]);
    expect(out.rows[0].reason).toBe("invalid_timestamp");
  });

  it("rejects a future-dated row via the entry-instant bound", () => {
    // 10 minutes past NOW — beyond the 5-min skew tolerance.
    const future = new Date(NOW + 10 * 60 * 1000).toISOString();
    const out = parse([`WEIGHT,80,kg,${future},,,`]);
    expect(out.rows[0]).toMatchObject({
      status: "skipped",
      reason: "implausible_timestamp",
    });
  });

  it("rejects a pre-1900 row", () => {
    const out = parse(["WEIGHT,80,kg,1899-12-31T00:00:00Z,,,"]);
    expect(out.rows[0]).toMatchObject({
      status: "skipped",
      reason: "implausible_timestamp",
    });
  });
});

describe("parseCsvMeasurements — glucose context", () => {
  // #640 — a continuous-sensor export carries a value and a timestamp per
  // reading and classifies nothing. Refusing those rows rejected the normal
  // case; the reading is accepted and the context stays absent.
  it("accepts a BLOOD_GLUCOSE row with no context", () => {
    const out = parse(["BLOOD_GLUCOSE,95,mg/dL,2026-05-01T08:00:00Z,,,"]);
    expect(out.rows[0]).toMatchObject({ status: "ok" });
    expect(out.rows[0].row).toBeDefined();
    expect(out.rows[0].row).not.toHaveProperty("glucoseContext");
  });

  it("accepts a contextless mmol/L reading at a +HHMM offset", () => {
    const out = parse([
      "BLOOD_GLUCOSE,5.3,mmol/L,2024-04-03T13:15:00+1100,,Sensor,sensor-1",
      "BLOOD_GLUCOSE,5.3,mmol/L,2024-04-17T08:06:00+1000,,Sensor,sensor-2",
    ]);
    expect(out.rows.map((r) => r.status)).toEqual(["ok", "ok"]);
    for (const result of out.rows) {
      expect(result.row).not.toHaveProperty("glucoseContext");
      expect(result.row?.unit).toBe("mg/dL");
      expect(result.row?.value).toBe(Math.round(5.3 * MGDL_PER_MMOL * 10) / 10);
    }
    expect(out.rows[0].row?.measuredAt.toISOString()).toBe(
      "2024-04-03T02:15:00.000Z",
    );
    expect(out.rows[1].row?.measuredAt.toISOString()).toBe(
      "2024-04-16T22:06:00.000Z",
    );
  });

  it("still accepts every enum context", () => {
    const out = parse(
      ["FASTING", "POSTPRANDIAL", "RANDOM", "BEDTIME"].map(
        (ctx) => `BLOOD_GLUCOSE,95,mg/dL,2026-05-01T08:00:00Z,${ctx},,`,
      ),
    );
    expect(out.rows.map((r) => r.row?.glucoseContext)).toEqual([
      "FASTING",
      "POSTPRANDIAL",
      "RANDOM",
      "BEDTIME",
    ]);
  });

  it("rejects a context on a non-glucose row", () => {
    const out = parse(["WEIGHT,80,kg,2026-05-01T08:00:00Z,FASTING,,"]);
    expect(out.rows[0]).toMatchObject({
      status: "skipped",
      reason: "unexpected_glucose_context",
    });
  });

  it("rejects an unknown context value", () => {
    const out = parse(["BLOOD_GLUCOSE,95,mg/dL,2026-05-01T08:00:00Z,LUNCH,,"]);
    expect(out.rows[0]).toMatchObject({
      status: "skipped",
      reason: "invalid_glucose_context",
    });
  });
});

describe("parseCsvMeasurements — optional columns", () => {
  it("carries externalId through and trims notes", () => {
    const out = parse(["WEIGHT,80,kg,2026-05-01T08:00:00Z,, after run ,ext-9"]);
    expect(out.rows[0].row).toMatchObject({
      externalId: "ext-9",
      notes: "after run",
    });
  });

  it("works without the optional columns present at all", () => {
    const out = parseCsvMeasurements(
      ["type,value,unit,measuredAt", "WEIGHT,80,kg,2026-05-01T08:00:00Z"].join(
        "\n",
      ),
      { now: NOW },
    );
    expect(out.rows[0].status).toBe("ok");
    expect(out.rows[0].row?.externalId).toBeUndefined();
  });
});

describe("parseCsvMeasurements — external-id stability floor", () => {
  /**
   * The CSV route upserts on `(userId, type, source=IMPORT, externalId)`,
   * so an id that cannot be stable between two exports re-imports as a
   * fresh row every time instead of converging on the one it already
   * wrote. This importer has no Zod field to hang a refine on — its
   * contract is a per-row `reason`, so the refusal lands there and every
   * other row still parses.
   */
  it("skips a row whose externalId is an object description", () => {
    const out = parse([
      "WEIGHT,80,kg,2026-05-01T08:00:00Z,,,<HKQuantitySample: 0x12568db80>",
    ]);
    expect(out.rows[0]).toMatchObject({
      status: "skipped",
      reason: "unstable_external_id",
    });
    expect(out.rows[0].row).toBeUndefined();
  });

  it("skips a row whose externalId is a bare memory address", () => {
    expect(
      parse(["WEIGHT,80,kg,2026-05-01T08:00:00Z,,,0x126b25160"]).rows[0],
    ).toMatchObject({ status: "skipped", reason: "unstable_external_id" });
  });

  it("skips only the offending row — the rest of the file still imports", () => {
    const out = parse([
      "WEIGHT,80,kg,2026-05-01T08:00:00Z,,,scale-row-42",
      "WEIGHT,81,kg,2026-05-02T08:00:00Z,,,<HKQuantitySample: 0x12568db80>",
      "WEIGHT,82,kg,2026-05-03T08:00:00Z,,,scale-row-43",
    ]);
    expect(out.rows.map((r) => r.status)).toEqual(["ok", "skipped", "ok"]);
    expect(out.rows[1].reason).toBe("unstable_external_id");
    expect(out.rows[0].row?.externalId).toBe("scale-row-42");
    expect(out.rows[2].row?.externalId).toBe("scale-row-43");
    expect(out.fatal).toBeUndefined();
  });

  it("accepts the spreadsheet / meter-export id shapes a real file carries", () => {
    const out = parse([
      "WEIGHT,80,kg,2026-05-01T08:00:00Z,,,scale-row-42",
      "WEIGHT,81,kg,2026-05-02T08:00:00Z,,,8AD2A9CB-3F0C-4E4D-9C1E-4B7E2A1D6F30",
      "WEIGHT,82,kg,2026-05-03T08:00:00Z,,,stats:HKQuantityTypeIdentifierBodyMass:2026-05-03",
      "WEIGHT,83,kg,2026-05-04T08:00:00Z,,,Morning Weigh-In 4",
    ]);
    expect(out.rows.every((r) => r.status === "ok")).toBe(true);
  });

  it("leaves a row with no externalId alone — an absent id is not a blank one", () => {
    const out = parse(["WEIGHT,80,kg,2026-05-01T08:00:00Z,,,"]);
    expect(out.rows[0].status).toBe("ok");
    expect(out.rows[0].row?.externalId).toBeUndefined();
  });
});
