import { describe, expect, it, vi } from "vitest";

import {
  bucketRowsByUserDay,
  canonicalDailyTimestamp,
  dayKeyForUserTz,
  drainPerSampleCumulative,
  localDayWindow,
  localStartOfDay,
  sumBucketValues,
} from "../drain-per-sample-cumulative";
import type { PrismaClient } from "@/generated/prisma/client";

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

describe("localStartOfDay", () => {
  // v1.4.37 W10 — local 00:00 resolution for any IANA zone. Used by
  // the W7c drill-down to anchor the per-day UTC window.

  it("returns Berlin 00:00 CET in winter (UTC+1)", () => {
    // 2026-01-15 00:00 CET = 2026-01-14 23:00 UTC.
    const ts = localStartOfDay("2026-01-15", "Europe/Berlin");
    expect(ts.toISOString()).toBe("2026-01-14T23:00:00.000Z");
  });

  it("returns Berlin 00:00 CEST in summer (UTC+2)", () => {
    // 2026-05-16 00:00 CEST = 2026-05-15 22:00 UTC.
    const ts = localStartOfDay("2026-05-16", "Europe/Berlin");
    expect(ts.toISOString()).toBe("2026-05-15T22:00:00.000Z");
  });

  it("returns plain UTC midnight for tz=UTC", () => {
    const ts = localStartOfDay("2026-05-16", "UTC");
    expect(ts.toISOString()).toBe("2026-05-16T00:00:00.000Z");
  });

  it("handles half-hour-offset zones (Asia/Kolkata UTC+5:30)", () => {
    // 2026-05-16 00:00 IST = 2026-05-15 18:30 UTC.
    const ts = localStartOfDay("2026-05-16", "Asia/Kolkata");
    expect(ts.toISOString()).toBe("2026-05-15T18:30:00.000Z");
  });
});

describe("localDayWindow — DST-aware [dayStart, dayEnd) drill-down bounds", () => {
  // v1.4.37 W10 H-1 — the previous `canonicalDailyTimestamp ± 12h`
  // shape silently leaked or hid an hour of samples on the two days
  // per year when Europe/Berlin (and every other DST-observing IANA
  // zone) transitions. `localDayWindow` walks the day's true local
  // 00:00 → next-day 00:00 boundary so the window covers the right
  // 23 / 24 / 25-hour span.

  it("spring-forward day (Berlin 2025-03-30) is exactly 23 hours wide", () => {
    const { dayStart, dayEnd } = localDayWindow(
      "2025-03-30",
      "Europe/Berlin",
    );
    // 2025-03-30 00:00 CET = 2025-03-29 23:00 UTC.
    // 2025-03-31 00:00 CEST = 2025-03-30 22:00 UTC.
    expect(dayStart.toISOString()).toBe("2025-03-29T23:00:00.000Z");
    expect(dayEnd.toISOString()).toBe("2025-03-30T22:00:00.000Z");
    expect(dayEnd.getTime() - dayStart.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it("fall-back day (Berlin 2025-10-26) is exactly 25 hours wide", () => {
    const { dayStart, dayEnd } = localDayWindow(
      "2025-10-26",
      "Europe/Berlin",
    );
    // 2025-10-26 00:00 CEST = 2025-10-25 22:00 UTC.
    // 2025-10-27 00:00 CET  = 2025-10-26 23:00 UTC.
    expect(dayStart.toISOString()).toBe("2025-10-25T22:00:00.000Z");
    expect(dayEnd.toISOString()).toBe("2025-10-26T23:00:00.000Z");
    expect(dayEnd.getTime() - dayStart.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it("regular day is exactly 24 hours wide", () => {
    const { dayStart, dayEnd } = localDayWindow(
      "2026-05-16",
      "Europe/Berlin",
    );
    expect(dayEnd.getTime() - dayStart.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("crosses a month boundary cleanly (2026-05-31 → 2026-06-01)", () => {
    const { dayStart, dayEnd } = localDayWindow(
      "2026-05-31",
      "Europe/Berlin",
    );
    expect(dayStart.toISOString()).toBe("2026-05-30T22:00:00.000Z");
    expect(dayEnd.toISOString()).toBe("2026-05-31T22:00:00.000Z");
  });

  it("crosses a year boundary cleanly (2025-12-31 → 2026-01-01)", () => {
    const { dayStart, dayEnd } = localDayWindow(
      "2025-12-31",
      "Europe/Berlin",
    );
    // Berlin in December is CET (UTC+1).
    expect(dayStart.toISOString()).toBe("2025-12-30T23:00:00.000Z");
    expect(dayEnd.toISOString()).toBe("2025-12-31T23:00:00.000Z");
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

// v1.4.37 W7c — the scheduled nightly drain passes a 36 h grace
// window so today + the trailing watch-sync reconciliation period
// stay per-sample for the list view. The test below pins that the
// cutoffHours option filters by `measuredAt: { lt: cutoff }` rather
// than collapsing every row in sight.
describe("drainPerSampleCumulative — cutoffHours", () => {
  function buildPrismaMock() {
    const findManyUser = vi.fn();
    const findManyMeasurement = vi.fn().mockResolvedValue([]);
    return {
      user: { findMany: findManyUser },
      measurement: { findMany: findManyMeasurement },
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({}),
      ),
    } as unknown as PrismaClient & {
      user: { findMany: ReturnType<typeof vi.fn> };
      measurement: { findMany: ReturnType<typeof vi.fn> };
    };
  }

  it("passes a measuredAt cutoff into the per-sample findMany when cutoffHours is set", async () => {
    const prismaMock = buildPrismaMock();
    prismaMock.user.findMany.mockResolvedValue([
      { id: "user-1", timezone: "Europe/Berlin" },
    ]);

    const beforeAt = Date.now();
    await drainPerSampleCumulative(prismaMock, {
      cutoffHours: 36,
      log: () => {},
    });
    const afterAt = Date.now();

    // The helper iterates every cumulative type — assert the first
    // findMany call carries the expected cutoff filter shape.
    const call = prismaMock.measurement.findMany.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.where.source).toBe("APPLE_HEALTH");
    expect(call.where.measuredAt?.lt).toBeInstanceOf(Date);

    const cutoff = call.where.measuredAt!.lt as Date;
    const expectedMin = beforeAt - 36 * 60 * 60 * 1000;
    const expectedMax = afterAt - 36 * 60 * 60 * 1000;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(cutoff.getTime()).toBeLessThanOrEqual(expectedMax);
  });

  it("omits the cutoff filter when cutoffHours is not provided (CLI / admin one-shot)", async () => {
    const prismaMock = buildPrismaMock();
    prismaMock.user.findMany.mockResolvedValue([
      { id: "user-1", timezone: "Europe/Berlin" },
    ]);

    await drainPerSampleCumulative(prismaMock, { log: () => {} });

    const call = prismaMock.measurement.findMany.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.where.source).toBe("APPLE_HEALTH");
    // Legacy callers (CLI, admin endpoint) must keep the all-rows
    // behaviour so a backfill drains everything the operator asked for.
    expect(call.where.measuredAt).toBeUndefined();
  });

  it("ignores a zero cutoffHours value (treat 0 as not-set)", async () => {
    const prismaMock = buildPrismaMock();
    prismaMock.user.findMany.mockResolvedValue([
      { id: "user-1", timezone: "Europe/Berlin" },
    ]);

    await drainPerSampleCumulative(prismaMock, {
      cutoffHours: 0,
      log: () => {},
    });

    const call = prismaMock.measurement.findMany.mock.calls[0]?.[0];
    expect(call.where.measuredAt).toBeUndefined();
  });
});
