import { describe, expect, it, vi } from "vitest";

// The SUM drain now recomputes the affected DAY rollup bucket after each
// per-day fold (so a drained day's stale double-counted sum self-heals).
// Mock it: these are pure-logic tests over a Prisma mock with no DB, and
// the real recompute issues raw SQL against the singleton client.
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
}));
import { recomputeBucketsForMeasurement } from "@/lib/rollups/measurement-rollups";

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
    const { dayStart, dayEnd } = localDayWindow("2025-03-30", "Europe/Berlin");
    // 2025-03-30 00:00 CET = 2025-03-29 23:00 UTC.
    // 2025-03-31 00:00 CEST = 2025-03-30 22:00 UTC.
    expect(dayStart.toISOString()).toBe("2025-03-29T23:00:00.000Z");
    expect(dayEnd.toISOString()).toBe("2025-03-30T22:00:00.000Z");
    expect(dayEnd.getTime() - dayStart.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it("fall-back day (Berlin 2025-10-26) is exactly 25 hours wide", () => {
    const { dayStart, dayEnd } = localDayWindow("2025-10-26", "Europe/Berlin");
    // 2025-10-26 00:00 CEST = 2025-10-25 22:00 UTC.
    // 2025-10-27 00:00 CET  = 2025-10-26 23:00 UTC.
    expect(dayStart.toISOString()).toBe("2025-10-25T22:00:00.000Z");
    expect(dayEnd.toISOString()).toBe("2025-10-26T23:00:00.000Z");
    expect(dayEnd.getTime() - dayStart.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it("regular day is exactly 24 hours wide", () => {
    const { dayStart, dayEnd } = localDayWindow("2026-05-16", "Europe/Berlin");
    expect(dayEnd.getTime() - dayStart.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("crosses a month boundary cleanly (2026-05-31 → 2026-06-01)", () => {
    const { dayStart, dayEnd } = localDayWindow("2026-05-31", "Europe/Berlin");
    expect(dayStart.toISOString()).toBe("2026-05-30T22:00:00.000Z");
    expect(dayEnd.toISOString()).toBe("2026-05-31T22:00:00.000Z");
  });

  it("crosses a year boundary cleanly (2025-12-31 → 2026-01-01)", () => {
    const { dayStart, dayEnd } = localDayWindow("2025-12-31", "Europe/Berlin");
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
      {
        id: "1",
        type: "ACTIVITY_STEPS" as const,
        value: 1200,
        measuredAt: new Date(),
        externalId: null,
      },
      {
        id: "2",
        type: "ACTIVITY_STEPS" as const,
        value: 3400,
        measuredAt: new Date(),
        externalId: null,
      },
      {
        id: "3",
        type: "ACTIVITY_STEPS" as const,
        value: 800,
        measuredAt: new Date(),
        externalId: null,
      },
    ];
    expect(sumBucketValues(rows)).toBe(5400);
  });

  it("returns 0 for an empty bucket", () => {
    expect(sumBucketValues([])).toBe(0);
  });

  it("handles fractional values (e.g. ACTIVE_ENERGY_BURNED kcal)", () => {
    const rows = [
      {
        id: "1",
        type: "ACTIVE_ENERGY_BURNED" as const,
        value: 12.4,
        measuredAt: new Date(),
        externalId: null,
      },
      {
        id: "2",
        type: "ACTIVE_ENERGY_BURNED" as const,
        value: 7.6,
        measuredAt: new Date(),
        externalId: null,
      },
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

// A1 — a late watch sync after a day's total was already collapsed must
// FOLD the new per-sample rows into the existing total, never overwrite
// it with just the partial late sum (the original samples are gone). The
// adopt-in-place write resolves the canonical row by the index-A `stats:`
// externalId first, then adopts it in place (`update`) or mints a fresh row
// (`create`).
describe("drainPerSampleCumulative — late-sync fold into existing total", () => {
  function buildFoldMock(
    existingTotal: number | null,
    aggregationProvenance:
      | "HEALTHKIT_STATISTICS"
      | "EXPORT_XML_SOURCE_MAX"
      | "LEGACY_UNKNOWN" = "LEGACY_UNKNOWN",
  ) {
    const findManyUser = vi
      .fn()
      .mockResolvedValue([{ id: "user-1", timezone: "Europe/Berlin" }]);

    // Only ACTIVITY_STEPS yields the late per-sample rows; every other
    // cumulative type returns an empty scan so the run stays a single bucket.
    const findManyMeasurement = vi.fn(
      async (args: { where: { type: string } }) => {
        if (args.where.type === "ACTIVITY_STEPS") {
          return [
            {
              id: "late-1",
              type: "ACTIVITY_STEPS",
              value: 300,
              measuredAt: new Date("2026-05-16T20:00:00.000Z"),
              externalId: "hk-uuid-late-1",
            },
            {
              id: "late-2",
              type: "ACTIVITY_STEPS",
              value: 200,
              measuredAt: new Date("2026-05-16T21:00:00.000Z"),
              externalId: "hk-uuid-late-2",
            },
          ];
        }
        return [];
      },
    );

    const update = vi.fn().mockResolvedValue({ id: "stats-row" });
    const create = vi.fn().mockResolvedValue({ id: "stats-row-new" });
    const deleteMany = vi.fn().mockResolvedValue({ count: 2 });
    // v1.28.39 F2 — the in-tx re-read of the still-live per-sample contributors
    // (only fires when an index-A `stats:` total already exists). Returns the
    // two late rows so `liveIncrement` sums to the same 500 the pre-scan did on
    // a clean single run.
    const findMany = vi
      .fn()
      .mockResolvedValue([{ value: 300 }, { value: 200 }]);
    // v1.28.39 F2 — the per-bucket advisory lock (`pg_advisory_xact_lock`).
    const $queryRaw = vi.fn().mockResolvedValue([{ locked: 1 }]);

    // `findFirst` serves three roles inside `writeDay`:
    //   1. index-A lookup (filters on `externalId`) → the existing collapsed
    //      total when one exists.
    //   2. index-B slot lookup (filters on `measuredAt`) → null here (no row
    //      sits on the canonical instant).
    //   3. `resolveCanonicalUnit` (filters on neither, selects `unit`) → unit.
    const findFirst = vi.fn(
      async (args: {
        where: Record<string, unknown>;
        select?: Record<string, unknown>;
      }) => {
        if ("externalId" in args.where) {
          return existingTotal === null
            ? null
            : {
                id: "stats-row",
                value: existingTotal,
                aggregationProvenance,
              };
        }
        if ("measuredAt" in args.where) return null; // no index-B collision
        return { unit: "count" }; // resolveCanonicalUnit
      },
    );

    const tx = {
      $queryRaw,
      measurement: { update, create, deleteMany, findFirst, findMany },
    };

    return {
      prisma: {
        user: { findMany: findManyUser },
        measurement: { findMany: findManyMeasurement },
        $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) =>
          cb(tx),
        ),
      } as unknown as PrismaClient,
      update,
      create,
      deleteMany,
    };
  }

  it("folds late samples into a pre-existing collapsed total (no shrink)", async () => {
    // Day already collapsed to 9000 on an earlier run; a late sync of
    // 300 + 200 = 500 must take the row to 9500, not down to 500.
    const { prisma, update, create } = buildFoldMock(9000);

    await drainPerSampleCumulative(prisma, { log: () => {} });

    // The index-A row is adopted in place — updated, never re-created.
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    const updateArg = update.mock.calls[0]?.[0] as { data: { value: number } };
    expect(updateArg.data.value).toBe(9500);
    expect(updateArg.data).toMatchObject({
      aggregationProvenance: "LEGACY_UNKNOWN",
      syncVersion: { increment: 1 },
    });
  });

  it("mints the partial sum when no collapsed total exists yet", async () => {
    const { prisma, update, create } = buildFoldMock(null);

    await drainPerSampleCumulative(prisma, { log: () => {} });

    // Fresh day: no canonical row to adopt → a new row is created with the
    // raw sum.
    expect(update).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    const createArg = create.mock.calls[0]?.[0] as { data: { value: number } };
    expect(createArg.data.value).toBe(500);
    expect(createArg.data).toMatchObject({
      aggregationProvenance: "LEGACY_UNKNOWN",
    });
  });

  it.each(["HEALTHKIT_STATISTICS", "EXPORT_XML_SOURCE_MAX"] as const)(
    "drains late source rows without changing %s authority",
    async (aggregationProvenance) => {
      const { prisma, update, create, deleteMany } = buildFoldMock(
        9_000,
        aggregationProvenance,
      );

      await drainPerSampleCumulative(prisma, { log: () => {} });

      expect(update).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ["late-1", "late-2"], not: "stats-row" } },
      });
    },
  );

  it("recomputes the DAY rollup bucket for the drained day so the stale sum self-heals", async () => {
    vi.mocked(recomputeBucketsForMeasurement).mockClear();
    const { prisma } = buildFoldMock(null);

    await drainPerSampleCumulative(prisma, { log: () => {} });

    // Without this the rollup tier keeps serving the pre-drain
    // double-counted sumValue forever (it reads only deleted_at IS NULL).
    expect(recomputeBucketsForMeasurement).toHaveBeenCalledTimes(1);
    const [userId, type, canonicalTs] = vi.mocked(
      recomputeBucketsForMeasurement,
    ).mock.calls[0]!;
    expect(userId).toBe("user-1");
    expect(type).toBe("ACTIVITY_STEPS");
    // Canonical local-noon of the Berlin day 2026-05-16 (CEST, UTC+2).
    expect((canonicalTs as Date).toISOString()).toBe(
      "2026-05-16T10:00:00.000Z",
    );
  });
});

// Root cause of the v1.18.10 bloat: a single day whose mint collided with the
// canonical-noon unique index threw and aborted the ENTIRE global walk (3 s
// die-early, 0 collapsed). The per-day error boundary must step the poisoned
// day over so every other day still collapses; the adopt-in-place path must
// absorb an index-B slot collision rather than throw at all.
describe("drainPerSampleCumulative — colliding day does not abort the walk", () => {
  it("steps over a poisoned day and still collapses the others", async () => {
    const findManyUser = vi
      .fn()
      .mockResolvedValue([{ id: "user-1", timezone: "Europe/Berlin" }]);

    // Two ACTIVITY_STEPS days: 2026-05-16 (poison) and 2026-05-17 (clean).
    const findManyMeasurement = vi.fn(
      async (args: { where: { type: string } }) => {
        if (args.where.type === "ACTIVITY_STEPS") {
          return [
            {
              id: "d16-a",
              type: "ACTIVITY_STEPS",
              value: 1000,
              measuredAt: new Date("2026-05-16T09:00:00.000Z"),
              externalId: "hk-uuid-16a",
            },
            {
              id: "d17-a",
              type: "ACTIVITY_STEPS",
              value: 2000,
              measuredAt: new Date("2026-05-17T09:00:00.000Z"),
              externalId: "hk-uuid-17a",
            },
          ];
        }
        return [];
      },
    );

    const create = vi.fn(async (args: { data: { measuredAt: Date } }) => {
      // The 2026-05-16 day mint throws a NON-P2002 error on every attempt —
      // a genuinely poisoned day the adopt path can't recover. Berlin local
      // noon on 2026-05-16 (CEST) is 10:00 UTC.
      const iso = args.data.measuredAt.toISOString();
      if (iso === "2026-05-16T10:00:00.000Z") {
        throw new Error("simulated poison-day write failure");
      }
      return { id: "stats-row-new" };
    });
    const update = vi.fn().mockResolvedValue({ id: "stats-row" });
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const findFirst = vi.fn(
      async (args: { where: Record<string, unknown> }) => {
        if ("externalId" in args.where) return null; // no existing total
        if ("measuredAt" in args.where) return null; // no index-B collision
        return { unit: "count" };
      },
    );
    const findMany = vi.fn().mockResolvedValue([]);
    const $queryRaw = vi.fn().mockResolvedValue([{ locked: 1 }]);

    const tx = {
      $queryRaw,
      measurement: { update, create, deleteMany, findFirst, findMany },
    };
    const prisma = {
      user: { findMany: findManyUser },
      measurement: { findMany: findManyMeasurement },
      $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) =>
        cb(tx),
      ),
    } as unknown as PrismaClient;

    const summary = await drainPerSampleCumulative(prisma, { log: () => {} });

    // The poisoned day is stepped over, NOT rethrown; the clean day collapses.
    expect(summary.totals.daysFailed).toBe(1);
    expect(summary.totals.bucketsCollapsed).toBe(1);
    expect(summary.totals.usersScanned).toBe(1);
    // The clean 2026-05-17 mint went through.
    expect(create).toHaveBeenCalledTimes(2); // both days attempt a create
  });

  it("adopts an index-B canonical-noon row in place instead of colliding", async () => {
    const findManyUser = vi
      .fn()
      .mockResolvedValue([{ id: "user-1", timezone: "Europe/Berlin" }]);

    const findManyMeasurement = vi.fn(
      async (args: { where: { type: string } }) => {
        if (args.where.type === "ACTIVITY_STEPS") {
          return [
            {
              id: "samp-1",
              type: "ACTIVITY_STEPS",
              value: 1500,
              measuredAt: new Date("2026-05-16T09:00:00.000Z"),
              externalId: "hk-uuid-1",
            },
          ];
        }
        return [];
      },
    );

    const update = vi.fn().mockResolvedValue({ id: "slot-row" });
    const create = vi.fn().mockResolvedValue({ id: "should-not-be-called" });
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    // No index-A stats row, but a DIFFERENT row already sits on the canonical
    // local-noon instant (index B) — e.g. a manual daily entry. The drain must
    // adopt it in place, never `create` (which would P2002 against index B).
    const findFirst = vi.fn(
      async (args: { where: Record<string, unknown> }) => {
        if ("externalId" in args.where) return null;
        if ("measuredAt" in args.where) return { id: "slot-row" };
        return { unit: "count" };
      },
    );
    const findMany = vi.fn().mockResolvedValue([]);
    const $queryRaw = vi.fn().mockResolvedValue([{ locked: 1 }]);

    const tx = {
      $queryRaw,
      measurement: { update, create, deleteMany, findFirst, findMany },
    };
    const prisma = {
      user: { findMany: findManyUser },
      measurement: { findMany: findManyMeasurement },
      $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) =>
        cb(tx),
      ),
    } as unknown as PrismaClient;

    const summary = await drainPerSampleCumulative(prisma, { log: () => {} });

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    const updateArg = update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { externalId: string; value: number };
    };
    // The slot row is adopted: stamped with the target stats externalId and
    // the bucket's value, no collision, no throw.
    expect(updateArg.where.id).toBe("slot-row");
    expect(updateArg.data.value).toBe(1500);
    expect(updateArg.data.externalId).toContain("stats:");
    expect(summary.totals.daysFailed).toBe(0);
    expect(summary.totals.bucketsCollapsed).toBe(1);
  });
});

// v1.28.39 F1 — the cumulative drain was the ONLY one of the four consolidation
// drains whose scan `where` omitted `deletedAt: null`, so a soft-deleted
// non-`stats:` APPLE_HEALTH sample was re-summed into the day total AND
// hard-deleted (resurrecting a user-deleted grace-window sample and erasing the
// legacy-steps audit tombstones into a double-counted second `stats:` total).
// The scan must pin live rows only, matching the three siblings.
describe("drainPerSampleCumulative — scan excludes soft-deleted rows (F1)", () => {
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

  it("pins the per-sample scan to deletedAt: null so tombstones are never re-summed or hard-deleted", async () => {
    const prismaMock = buildPrismaMock();
    prismaMock.user.findMany.mockResolvedValue([
      { id: "user-1", timezone: "Europe/Berlin" },
    ]);

    await drainPerSampleCumulative(prismaMock, { log: () => {} });

    const call = prismaMock.measurement.findMany.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.where.source).toBe("APPLE_HEALTH");
    // The fix: the scan is live-rows-only. Pre-fix this key was absent and a
    // soft-deleted Apple sample fell into the sum + hard delete.
    expect(call.where.deletedAt).toBeNull();
  });
});

// v1.28.39 F2 — the additive late-fold merge (`eidRow.value + <increment>`)
// double-counted under two overlapping runs of the same (user, type, day): both
// scan the same live per-sample rows, the winner mints+hard-deletes, and the
// loser re-added its now-stale scan sum onto the winner's committed total → a
// permanent 2× that never self-healed. The per-bucket advisory lock serialises
// the folds and the in-tx re-read makes the serialised-second fold contribute
// zero.
describe("drainPerSampleCumulative — concurrent fold does not double-count (F2)", () => {
  it("re-reads the live contributors in-tx so a second overlapping drain adds zero", async () => {
    const findManyUser = vi
      .fn()
      .mockResolvedValue([{ id: "user-1", timezone: "Europe/Berlin" }]);

    // This run's SCAN still sees the two per-sample rows (it scanned before the
    // sibling committed) summing to 500 in `reducedValue`.
    const findManyMeasurement = vi.fn(
      async (args: { where: { type: string } }) => {
        if (args.where.type === "ACTIVITY_STEPS") {
          return [
            {
              id: "s-1",
              type: "ACTIVITY_STEPS",
              value: 300,
              measuredAt: new Date("2026-05-16T20:00:00.000Z"),
              externalId: "hk-uuid-1",
            },
            {
              id: "s-2",
              type: "ACTIVITY_STEPS",
              value: 200,
              measuredAt: new Date("2026-05-16T21:00:00.000Z"),
              externalId: "hk-uuid-2",
            },
          ];
        }
        return [];
      },
    );

    const update = vi.fn().mockResolvedValue({ id: "stats-row" });
    const create = vi.fn().mockResolvedValue({ id: "stats-row-new" });
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    // The sibling run already collapsed the day to 9000 (index-A row exists)…
    const findFirst = vi.fn(
      async (args: { where: Record<string, unknown> }) => {
        if ("externalId" in args.where) return { id: "stats-row", value: 9000 };
        if ("measuredAt" in args.where) return null;
        return { unit: "count" };
      },
    );
    // …AND already HARD-DELETED s-1 / s-2, so the in-tx re-read of the live
    // contributors returns nothing → increment 0, not the stale 500.
    const findMany = vi.fn().mockResolvedValue([]);
    const $queryRaw = vi.fn().mockResolvedValue([{ locked: 1 }]);

    const tx = {
      $queryRaw,
      measurement: { update, create, deleteMany, findFirst, findMany },
    };
    const prisma = {
      user: { findMany: findManyUser },
      measurement: { findMany: findManyMeasurement },
      $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) =>
        cb(tx),
      ),
    } as unknown as PrismaClient;

    await drainPerSampleCumulative(prisma, { log: () => {} });

    // The advisory lock fired for the bucket.
    expect($queryRaw).toHaveBeenCalledTimes(1);
    // The row is left at 9000 — NOT 9500 — without a non-material update or
    // syncVersion bump. Pre-fix the merge added the stale reducedValue (500)
    // onto the committed total.
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
