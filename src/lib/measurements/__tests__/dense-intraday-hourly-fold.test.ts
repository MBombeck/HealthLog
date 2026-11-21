/**
 * v1.28.31 — hourly-grain primitives of the dense intra-day retention tier.
 *
 * Pins the pure helpers the hourly fold and the history rebuild share: the
 * per-LOCAL-hour bucketing (tz-correct, DST-safe on both transition days),
 * the `stats:<HK>:<YYYY-MM-DD>T<HH>` externalId shape (the `stats:` prefix
 * is load-bearing for the scan's re-fold exclusion), and the local-HH:30
 * anchor instant (mirrors the local-noon daily convention one grain down).
 */
import { describe, it, expect } from "vitest";

import {
  bucketRowsByLocalHour,
  hourlyStatsExternalId,
} from "../dense-intraday-retention";
import {
  canonicalHourlyTimestamp,
  hourOfDayForUserTz,
} from "../consolidation-tz";
import type { PerSampleRow } from "../consolidation-tz";
import type { MeasurementType } from "@/generated/prisma/client";
import { userDayKey } from "@/lib/tz/format";

function row(id: string, iso: string, value = 50): PerSampleRow {
  return {
    id,
    type: "HEART_RATE_VARIABILITY" as MeasurementType,
    value,
    measuredAt: new Date(iso),
    externalId: null,
    unit: "ms",
  };
}

describe("hourlyStatsExternalId", () => {
  it("emits stats:<HK>:<YYYY-MM-DD>T<HH> with a zero-padded hour", () => {
    expect(
      hourlyStatsExternalId(
        "HKQuantityTypeIdentifierHeartRate",
        "2026-05-01",
        7,
      ),
    ).toBe("stats:HKQuantityTypeIdentifierHeartRate:2026-05-01T07");
    expect(
      hourlyStatsExternalId(
        "HKQuantityTypeIdentifierHeartRate",
        "2026-05-01",
        23,
      ),
    ).toBe("stats:HKQuantityTypeIdentifierHeartRate:2026-05-01T23");
  });

  it("stays under the stats: prefix (the scan's re-fold exclusion)", () => {
    const id = hourlyStatsExternalId("X", "2026-05-01", 0);
    expect(id.startsWith("stats:")).toBe(true);
  });

  it("never collides with the daily externalId of the same day", () => {
    // The daily id is `stats:X:2026-05-01`; every hourly id appends T<HH>.
    for (let hour = 0; hour < 24; hour++) {
      expect(hourlyStatsExternalId("X", "2026-05-01", hour)).not.toBe(
        "stats:X:2026-05-01",
      );
    }
  });
});

describe("bucketRowsByLocalHour — timezone correctness", () => {
  it("buckets by the USER-LOCAL hour, not the UTC hour", () => {
    // Berlin is UTC+2 on 2026-05-01: 08:15Z and 08:45Z are local hour 10.
    const buckets = bucketRowsByLocalHour(
      [
        row("a", "2026-05-01T08:15:00.000Z"),
        row("b", "2026-05-01T08:45:00.000Z"),
        row("c", "2026-05-01T09:15:00.000Z"), // local hour 11
      ],
      "Europe/Berlin",
    );
    expect([...buckets.keys()].sort((x, y) => x - y)).toEqual([10, 11]);
    expect(buckets.get(10)).toHaveLength(2);
    expect(buckets.get(11)).toHaveLength(1);
  });

  it("west-of-UTC zones bucket into their own local hours", () => {
    // New York is UTC-4 on 2026-05-01: 02:30Z is local hour 22 (prev day).
    const buckets = bucketRowsByLocalHour(
      [row("a", "2026-05-01T02:30:00.000Z")],
      "America/New_York",
    );
    expect([...buckets.keys()]).toEqual([22]);
  });

  it("spring-forward day: the skipped local hour never appears", () => {
    // Europe/Berlin 2026-03-29: 02:00 CET jumps to 03:00 CEST — local hour
    // 2 does not exist. 00:30Z = 01:30 CET (hour 1); 01:30Z = 03:30 CEST
    // (hour 3).
    const buckets = bucketRowsByLocalHour(
      [
        row("a", "2026-03-29T00:30:00.000Z"),
        row("b", "2026-03-29T01:30:00.000Z"),
      ],
      "Europe/Berlin",
    );
    expect([...buckets.keys()].sort((x, y) => x - y)).toEqual([1, 3]);
  });

  it("fall-back day: both instants of the repeated local hour share ONE bucket", () => {
    // Europe/Berlin 2026-10-25: 03:00 CEST falls back to 02:00 CET — the
    // 02:xx wall-clock hour happens twice. 00:30Z = 02:30 CEST; 01:30Z =
    // 02:30 CET. One bucket, two rows.
    const buckets = bucketRowsByLocalHour(
      [
        row("a", "2026-10-25T00:30:00.000Z"),
        row("b", "2026-10-25T01:30:00.000Z"),
      ],
      "Europe/Berlin",
    );
    expect([...buckets.keys()]).toEqual([2]);
    expect(buckets.get(2)).toHaveLength(2);
  });
});

describe("canonicalHourlyTimestamp — local HH:30 anchor", () => {
  it("anchors at the middle of the local hour", () => {
    // Berlin UTC+2: local 09:30 on 2026-05-01 is 07:30Z.
    expect(
      canonicalHourlyTimestamp("2026-05-01", 9, "Europe/Berlin").toISOString(),
    ).toBe("2026-05-01T07:30:00.000Z");
    // UTC: identity.
    expect(canonicalHourlyTimestamp("2026-05-01", 9, "UTC").toISOString()).toBe(
      "2026-05-01T09:30:00.000Z",
    );
  });

  it("round-trips back to its own (day, hour) for regular days", () => {
    for (const tz of ["Europe/Berlin", "America/New_York", "Asia/Kathmandu"]) {
      for (const hour of [0, 6, 12, 23]) {
        const anchor = canonicalHourlyTimestamp("2026-05-01", hour, tz);
        expect(userDayKey(anchor, tz)).toBe("2026-05-01");
        expect(hourOfDayForUserTz(anchor, tz)).toBe(hour);
      }
    }
  });

  it("resolves the ambiguous fall-back hour to an instant INSIDE that local hour", () => {
    // 2026-10-25, Europe/Berlin: local 02:30 exists twice. Whichever
    // instant is picked must read back as (2026-10-25, hour 2) — that is
    // all the fold needs, the externalId is the row identity.
    const anchor = canonicalHourlyTimestamp("2026-10-25", 2, "Europe/Berlin");
    expect(userDayKey(anchor, "Europe/Berlin")).toBe("2026-10-25");
    expect(hourOfDayForUserTz(anchor, "Europe/Berlin")).toBe(2);
  });

  it("produces 24 DISTINCT anchors per regular day (index-B identities cannot collide)", () => {
    const anchors = new Set(
      Array.from({ length: 24 }, (_, hour) =>
        canonicalHourlyTimestamp("2026-05-01", hour, "Europe/Berlin").getTime(),
      ),
    );
    expect(anchors.size).toBe(24);
  });
});
