/**
 * v1.5.6 — unit coverage for the extractable bucketing + summation
 * helpers behind the legacy step-consolidation pass. The DB-touching
 * end-to-end contract lives in
 * `tests/integration/consolidate-legacy-steps.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  bucketLegacyStepRows,
  sumLegacyStepValues,
  STEP_DAILY_STATS_PREFIX,
} from "../consolidate-legacy-steps";
import type { PerSampleRow } from "../drain-per-sample-cumulative";

function row(
  partial: Partial<PerSampleRow> & { measuredAt: Date },
): PerSampleRow {
  return {
    id: partial.id ?? "id-1",
    type: partial.type ?? "ACTIVITY_STEPS",
    value: partial.value ?? 100,
    measuredAt: partial.measuredAt,
    externalId: partial.externalId ?? null,
  };
}

describe("bucketLegacyStepRows", () => {
  it("groups rows by the user's calendar day", () => {
    const tz = "Europe/Berlin";
    const rows = [
      row({ id: "a", measuredAt: new Date("2026-05-16T08:00:00.000Z") }),
      row({ id: "b", measuredAt: new Date("2026-05-16T20:00:00.000Z") }),
      row({ id: "c", measuredAt: new Date("2026-05-17T06:00:00.000Z") }),
    ];
    const byDay = bucketLegacyStepRows(rows, tz);
    expect(byDay.get("2026-05-16")).toHaveLength(2);
    expect(byDay.get("2026-05-17")).toHaveLength(1);
  });

  it("skips rows already in the daily-stats shape", () => {
    const tz = "Europe/Berlin";
    const rows = [
      row({
        id: "total",
        externalId: `${STEP_DAILY_STATS_PREFIX}2026-05-16`,
        measuredAt: new Date("2026-05-16T10:00:00.000Z"),
      }),
      row({ id: "legacy", measuredAt: new Date("2026-05-16T08:00:00.000Z") }),
    ];
    const byDay = bucketLegacyStepRows(rows, tz);
    expect(byDay.get("2026-05-16")).toHaveLength(1);
    expect(byDay.get("2026-05-16")?.[0].id).toBe("legacy");
  });

  it("buckets a late-evening UTC sample into the next local day", () => {
    // 23:30 UTC on 2026-05-16 is 01:30 on 2026-05-17 in Berlin (UTC+2).
    const byDay = bucketLegacyStepRows(
      [row({ id: "late", measuredAt: new Date("2026-05-16T23:30:00.000Z") })],
      "Europe/Berlin",
    );
    expect(byDay.has("2026-05-17")).toBe(true);
    expect(byDay.has("2026-05-16")).toBe(false);
  });
});

describe("sumLegacyStepValues", () => {
  it("sums the values in a bucket", () => {
    const rows = [
      row({ value: 1200, measuredAt: new Date("2026-05-16T08:00:00.000Z") }),
      row({ value: 3400, measuredAt: new Date("2026-05-16T14:00:00.000Z") }),
      row({ value: 800, measuredAt: new Date("2026-05-16T20:00:00.000Z") }),
    ];
    expect(sumLegacyStepValues(rows)).toBe(5400);
  });

  it("returns 0 for an empty bucket", () => {
    expect(sumLegacyStepValues([])).toBe(0);
  });
});
