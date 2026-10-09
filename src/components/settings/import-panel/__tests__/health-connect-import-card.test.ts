import { describe, expect, it } from "vitest";

import {
  healthConnectFailureKind,
  summarizeHealthConnectResult,
} from "../health-connect-import-card";

describe("healthConnectFailureKind", () => {
  it("reads the code at the front of a worker reason", () => {
    expect(
      healthConnectFailureKind("unsupported_version: database version 7"),
    ).toBe("unsupportedVersion");
    expect(healthConnectFailureKind("not_health_connect: no member")).toBe(
      "notHealthConnect",
    );
    expect(healthConnectFailureKind("unsafe_schema: x is a view")).toBe(
      "unsafeSchema",
    );
    expect(healthConnectFailureKind("too_large: 5 GB")).toBe("tooLarge");
    expect(healthConnectFailureKind("staging_missing: gone")).toBe(
      "stagingMissing",
    );
    expect(healthConnectFailureKind("interrupted_by_restart")).toBe(
      "interrupted",
    );
    expect(healthConnectFailureKind("connection reset")).toBe("raw");
    expect(healthConnectFailureKind(null)).toBeNull();
  });
});

describe("summarizeHealthConnectResult", () => {
  it("lists the written types, largest first, and the records left out", () => {
    const summary = summarizeHealthConnectResult({
      perType: {
        WEIGHT: { inserted: 3, updated: 1 },
        PULSE: { inserted: 1440 },
        BODY_FAT: { inserted: 0, skipped: 2 },
      },
      perApp: {
        "com.withings.wiscale2": { records: 12, leftOut: true },
        "com.fitbit.FitbitMobile": { records: 1500, leftOut: false },
      },
      totals: { rowsUpserted: 1444 },
    });
    expect(summary.types).toEqual([
      { type: "PULSE", written: 1440 },
      { type: "WEIGHT", written: 4 },
    ]);
    expect(summary.written).toBe(1444);
    expect(summary.leftOutRecords).toBe(12);
  });

  it("counts genuine refusals, not deliberate skips", () => {
    const summary = summarizeHealthConnectResult({
      totals: { rowsUpserted: 1 },
      skipped: {
        connected_integration: 40,
        "SLEEP_DURATION::out_of_bed": 4,
        "WEIGHT::out_of_range": 2,
      },
    });
    expect(summary.refused).toBe(2);
  });
});
