import { describe, expect, it } from "vitest";

import { boundInstantSql } from "@/lib/analytics/request-clock-sql";
import { canonicalMeasurementsCte } from "@/lib/analytics/source-rank-sql";

import { seriesRowsFrom } from "../series-canonical";

const SINCE = new Date("2026-03-01T06:30:00.000Z");

describe("seriesRowsFrom", () => {
  it("collapses a type that has a ladder to the ladder's source per day", () => {
    const sql = seriesRowsFrom(null, "PULSE", SINCE);
    expect(sql).toContain("canonical_source");
    // Scoped to the one metric in the helper's one scan.
    expect(sql).toContain(`mm."type" = 'PULSE'::"measurement_type"`);
    expect(sql.trimEnd().endsWith(") m")).toBe(true);
  });

  it("reads one day wider than the request, so the edge day is picked from all its readings", () => {
    const sql = seriesRowsFrom(null, "WEIGHT", SINCE);
    expect(
      sql.match(/>= '2026-03-01 06:30:00.000'::timestamp - INTERVAL '1 day'/g),
    ).toHaveLength(1);
    // Counted from the caller's `since`, never from the database clock.
    expect(sql).not.toMatch(/NOW\(\)/i);
  });

  it("applies the person's ladder, not only the default one", () => {
    const first = seriesRowsFrom(
      { pulse: ["FITBIT", "APPLE_HEALTH"] },
      "PULSE",
      SINCE,
    );
    const second = seriesRowsFrom(
      { pulse: ["APPLE_HEALTH", "FITBIT"] },
      "PULSE",
      SINCE,
    );
    expect(first).not.toEqual(second);
    expect(first).toMatch(/WHEN 'FITBIT' THEN 0 WHEN 'APPLE_HEALTH' THEN 1/);
    expect(second).toMatch(/WHEN 'APPLE_HEALTH' THEN 0 WHEN 'FITBIT' THEN 1/);
  });

  it.each(["BLOOD_GLUCOSE", "TOTAL_BODY_WATER", "BONE_MASS"] as const)(
    "keeps every source for %s, which has no ladder",
    (type) => {
      const sql = seriesRowsFrom(null, type, SINCE);
      expect(sql).not.toContain("canonical_source");
      expect(sql).toContain(`mm."type" = '${type}'::"measurement_type"`);
      expect(sql).toContain(`mm."user_id" = $1`);
      expect(sql).toContain(`mm."deleted_at" IS NULL`);
    },
  );

  it("refuses an invalid instant", () => {
    expect(() => seriesRowsFrom(null, "PULSE", new Date(Number.NaN))).toThrow(
      /invalid instant/,
    );
  });
});

describe("canonicalMeasurementsCte, one-metric scope", () => {
  const rank = `CASE "source" WHEN 'A' THEN 0 ELSE 90 END`;
  const NINETY_DAYS = { from: boundInstantSql(2), interval: "90 days" };

  it("is unchanged when no type is given", () => {
    const sql = canonicalMeasurementsCte(rank, NINETY_DAYS);
    expect(sql).not.toContain("measurement_type");
  });

  it("scopes the scan to the type when one is given", () => {
    const sql = canonicalMeasurementsCte(rank, NINETY_DAYS, "PULSE");
    expect(sql.match(/'PULSE'::"measurement_type"/g)).toHaveLength(1);
  });

  it("refuses anything that is not a closed-enum literal", () => {
    expect(() =>
      canonicalMeasurementsCte(rank, undefined, "PULSE'; DROP" as never),
    ).toThrow(/unsafe enum literal/);
  });
});
