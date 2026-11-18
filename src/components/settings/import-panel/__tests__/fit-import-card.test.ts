import { describe, expect, it } from "vitest";

import { fitFailureCodeOf } from "@/lib/fit/errors";
import { summarizeFitResult } from "../fit-import-card";

describe("summarizeFitResult", () => {
  it("lists the non-zero rows in order and counts what was written", () => {
    expect(
      summarizeFitResult({
        sessions: 2,
        sessionsSkipped: 0,
        imported: 1,
        merged: 1,
        alreadyPresent: 0,
        withSeries: 2,
        withRoute: 0,
      }),
    ).toEqual({
      written: 2,
      rows: [
        { key: "imported", count: 1 },
        { key: "merged", count: 1 },
        { key: "withSeries", count: 2 },
      ],
    });
  });

  it("reads nothing into a missing or malformed result", () => {
    expect(summarizeFitResult(null)).toEqual({ written: 0, rows: [] });
    expect(summarizeFitResult({ imported: -3, merged: Number.NaN })).toEqual({
      written: 0,
      rows: [],
    });
  });
});

describe("fitFailureCodeOf", () => {
  it("reads the code at the front of a worker reason", () => {
    expect(fitFailureCodeOf("crc_mismatch: file checksum")).toBe(
      "crc_mismatch",
    );
    expect(fitFailureCodeOf("not_activity: the file is not an activity")).toBe(
      "not_activity",
    );
    expect(fitFailureCodeOf("connection reset")).toBeNull();
    expect(fitFailureCodeOf(null)).toBeNull();
  });
});
