import { describe, expect, it } from "vitest";

import {
  bucketRowsByUserDay,
  canonicalDailyTimestamp,
  dayKeyForUserTz,
  sumBucketValues,
} from "../drain-per-sample-cumulative";

describe("dayKeyForUserTz", () => {
  it("anchors the calendar day to the user's IANA zone", () => {
    // 23:45 NZST on 2026-05-16 is still 11:45 UTC on the same day, but
    // the user's calendar day in Europe/Berlin would be the previous day
    // because Berlin is 10-11h behind NZST.
    const instant = new Date("2026-05-16T11:45:00.000Z");
    expect(dayKeyForUserTz(instant, "Pacific/Auckland")).toBe("2026-05-16");
    // Europe/Berlin: same instant resolves to local 13:45 — still 2026-05-16.
    expect(dayKeyForUserTz(instant, "Europe/Berlin")).toBe("2026-05-16");
    // America/Los_Angeles (UTC-7 in DST): same instant resolves to 04:45 — 2026-05-16.
    expect(dayKeyForUserTz(instant, "America/Los_Angeles")).toBe("2026-05-16");
  });

  it("uses sv-SE Intl formatting so output is ISO-shaped", () => {
    const instant = new Date("2026-01-01T00:00:00.000Z");
    expect(dayKeyForUserTz(instant, "UTC")).toBe("2026-01-01");
    // The Pacific/Auckland clock is 13h ahead → already 2026-01-01 mid-afternoon at UTC midnight.
    expect(dayKeyForUserTz(instant, "Pacific/Auckland")).toBe("2026-01-01");
    // Europe/Berlin (UTC+1 in standard time): same instant → 01:00 local → still 2026-01-01.
    expect(dayKeyForUserTz(instant, "Europe/Berlin")).toBe("2026-01-01");
  });
});

describe("canonicalDailyTimestamp", () => {
  it("anchors a Berlin day-key to the local-noon instant", () => {
    // 12:00 local in Berlin during DST (CEST, UTC+2) is 10:00 UTC.
    const ts = canonicalDailyTimestamp("2026-05-16", "Europe/Berlin");
    expect(ts.toISOString()).toBe("2026-05-16T10:00:00.000Z");
  });

  it("anchors a UTC day-key to plain 12:00 UTC", () => {
    const ts = canonicalDailyTimestamp("2026-05-16", "UTC");
    expect(ts.toISOString()).toBe("2026-05-16T12:00:00.000Z");
  });

  it("anchors a Pacific/Auckland day-key to the local-noon instant", () => {
    // 12:00 NZST (UTC+12) → 00:00 UTC on the same day.
    const ts = canonicalDailyTimestamp("2026-05-16", "Pacific/Auckland");
    expect(ts.toISOString()).toBe("2026-05-16T00:00:00.000Z");
  });

  it("handles half-hour-offset zones (India IST = UTC+5:30)", () => {
    // 12:00 IST → 06:30 UTC on the same day.
    const ts = canonicalDailyTimestamp("2026-05-16", "Asia/Kolkata");
    expect(ts.toISOString()).toBe("2026-05-16T06:30:00.000Z");
  });
});

describe("bucketRowsByUserDay", () => {
  it("groups per-sample rows by the user's calendar day", () => {
    const rows = [
      {
        id: "m-1",
        type: "ACTIVITY_STEPS" as const,
        value: 1200,
        measuredAt: new Date("2026-05-16T08:00:00.000Z"), // 10:00 Berlin
        externalId: "hk-uuid-1",
      },
      {
        id: "m-2",
        type: "ACTIVITY_STEPS" as const,
        value: 3400,
        measuredAt: new Date("2026-05-16T14:00:00.000Z"), // 16:00 Berlin
        externalId: "hk-uuid-2",
      },
      {
        id: "m-3",
        type: "ACTIVITY_STEPS" as const,
        value: 800,
        measuredAt: new Date("2026-05-17T06:00:00.000Z"), // 08:00 Berlin, next day
        externalId: "hk-uuid-3",
      },
    ];
    const { byDay } = bucketRowsByUserDay(rows, "Europe/Berlin");
    expect(byDay.size).toBe(2);
    expect(byDay.get("2026-05-16")?.length).toBe(2);
    expect(byDay.get("2026-05-17")?.length).toBe(1);
  });

  it("skips rows whose externalId is already in stats:... shape (idempotent re-run)", () => {
    const rows = [
      {
        id: "m-1",
        type: "ACTIVITY_STEPS" as const,
        value: 5000,
        measuredAt: new Date("2026-05-16T10:00:00.000Z"),
        externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-05-16",
      },
      {
        id: "m-2",
        type: "ACTIVITY_STEPS" as const,
        value: 1200,
        measuredAt: new Date("2026-05-16T08:00:00.000Z"),
        externalId: "hk-uuid-pre-drain",
      },
    ];
    const { byDay } = bucketRowsByUserDay(rows, "Europe/Berlin");
    // The already-collapsed row is skipped; only the per-sample row
    // remains in the bucket.
    expect(byDay.get("2026-05-16")?.length).toBe(1);
    expect(byDay.get("2026-05-16")?.[0]?.id).toBe("m-2");
  });

  it("groups rows with NULL externalId (manual entries) like any other per-sample row", () => {
    const rows = [
      {
        id: "m-1",
        type: "ACTIVITY_STEPS" as const,
        value: 1200,
        measuredAt: new Date("2026-05-16T08:00:00.000Z"),
        externalId: null,
      },
    ];
    const { byDay } = bucketRowsByUserDay(rows, "Europe/Berlin");
    expect(byDay.get("2026-05-16")?.length).toBe(1);
  });

  it("returns an empty map when the input is empty", () => {
    const { byDay } = bucketRowsByUserDay([], "Europe/Berlin");
    expect(byDay.size).toBe(0);
  });
});

describe("sumBucketValues", () => {
  it("sums a non-empty bucket", () => {
    const rows = [
      { id: "1", type: "ACTIVITY_STEPS" as const, value: 1200, measuredAt: new Date(), externalId: null },
      { id: "2", type: "ACTIVITY_STEPS" as const, value: 3400, measuredAt: new Date(), externalId: null },
      { id: "3", type: "ACTIVITY_STEPS" as const, value: 800, measuredAt: new Date(), externalId: null },
    ];
    expect(sumBucketValues(rows)).toBe(5400);
  });

  it("returns 0 for an empty bucket", () => {
    expect(sumBucketValues([])).toBe(0);
  });

  it("handles fractional values (e.g. ACTIVE_ENERGY_BURNED kcal)", () => {
    const rows = [
      { id: "1", type: "ACTIVE_ENERGY_BURNED" as const, value: 12.4, measuredAt: new Date(), externalId: null },
      { id: "2", type: "ACTIVE_ENERGY_BURNED" as const, value: 7.6, measuredAt: new Date(), externalId: null },
    ];
    expect(sumBucketValues(rows)).toBeCloseTo(20.0);
  });
});
