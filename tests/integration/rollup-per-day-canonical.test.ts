/**
 * Coarse buckets pick the canonical source per DAY, on both read paths.
 *
 * The rollup writer mints one row per (type, bucket, source). Collapsing the
 * stored WEEK / MONTH / YEAR rows picked ONE source for the whole bucket, so a
 * month of manual blood-pressure readings plus one synced reading reported the
 * synced day alone, and a step month that switched devices lost every day the
 * losing device carried. The live weekly / monthly fold made the same pick.
 *
 * This suite seeds real rows, folds the rollups through the real writer, and
 * pins that the rollup readers (`readRollupBuckets`,
 * `readBestGranularityRollups`) and the live fold (`readLiveBuckets`) agree
 * with each other and with the per-day arithmetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import {
  readRollupBuckets,
  recomputeUserRollups,
} from "@/lib/rollups/measurement-rollups";
import { readLiveBuckets } from "@/lib/measurements/daily-series-read";
import { readTieredRollupSeries } from "@/lib/rollups/measurement-read-wmy";
import { readAllTimeExtremes } from "@/lib/insights/feature-blocks";
import { computeSummariesSlice } from "@/lib/analytics/summaries-slice";
import type { MeasurementType } from "@/generated/prisma/client";

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

const DAY_MS = 86_400_000;
const FROM = new Date("2025-11-01T00:00:00.000Z");
const TO = new Date("2025-12-01T00:00:00.000Z");

let seq = 0;
async function seedUser() {
  seq += 1;
  return getPrismaClient().user.create({
    data: {
      username: `per-day-canonical-${seq}`,
      email: `per-day-canonical-${seq}@example.test`,
      role: "USER",
    },
  });
}

type Row = {
  type: MeasurementType;
  source: "MANUAL" | "WITHINGS" | "APPLE_HEALTH" | "FITBIT";
  value: number;
  at: Date;
};

async function seed(userId: string, rows: Row[]) {
  await getPrismaClient().measurement.createMany({
    data: rows.map((r) => ({
      userId,
      type: r.type,
      value: r.value,
      unit: r.type === "ACTIVITY_STEPS" ? "count" : "mmHg",
      source: r.source,
      measuredAt: r.at,
    })),
  });
  await recomputeUserRollups(userId, {
    from: new Date("2025-10-01T00:00:00.000Z"),
    to: new Date("2026-01-01T00:00:00.000Z"),
  });
}

function day(n: number, hour = 8): Date {
  return new Date(FROM.getTime() + n * DAY_MS + hour * 3_600_000);
}

async function live(
  userId: string,
  type: MeasurementType,
  grain: "weekly" | "monthly",
) {
  return readLiveBuckets({
    userId,
    type,
    from: FROM,
    to: new Date(TO.getTime() - 1),
    cap: 100,
    priorityJson: null,
    grain,
    timeZone: "UTC",
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("coarse buckets — canonical source per day", () => {
  it("counts every manual day of a month that also carries one synced day", async () => {
    const user = await seedUser();
    const rows: Row[] = [];
    for (let i = 0; i < 20; i++) {
      rows.push({
        type: "BLOOD_PRESSURE_SYS",
        source: "MANUAL",
        value: 150,
        at: day(i),
      });
    }
    // WITHINGS leads the blood-pressure ladder; it owns day 24 only.
    rows.push({
      type: "BLOOD_PRESSURE_SYS",
      source: "WITHINGS",
      value: 120,
      at: day(24),
    });
    await seed(user.id, rows);

    const [month] = await readRollupBuckets(
      user.id,
      "BLOOD_PRESSURE_SYS",
      "MONTH",
      FROM,
      TO,
    );
    expect(month.count).toBe(21);
    expect(month.mean).toBeCloseTo((20 * 150 + 120) / 21, 9);

    const [liveMonth] = await live(user.id, "BLOOD_PRESSURE_SYS", "monthly");
    expect(liveMonth.count).toBe(21);
    expect(liveMonth.value).toBeCloseTo(month.mean, 9);
  });

  it("sums a step month that switches device, and keeps one source on a shared day", async () => {
    const user = await seedUser();
    const rows: Row[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push({
        type: "ACTIVITY_STEPS",
        source: "FITBIT",
        value: 8000,
        at: day(i),
      });
    }
    for (let i = 10; i < 30; i++) {
      rows.push({
        type: "ACTIVITY_STEPS",
        source: "APPLE_HEALTH",
        value: 8000,
        at: day(i),
      });
    }
    // Day 12 also carries a Fitbit total; Apple Health leads the ladder.
    rows.push({
      type: "ACTIVITY_STEPS",
      source: "FITBIT",
      value: 9999,
      at: day(12),
    });
    await seed(user.id, rows);

    const monthly = await readRollupBuckets(
      user.id,
      "ACTIVITY_STEPS",
      "MONTH",
      FROM,
      TO,
    );
    expect(monthly).toHaveLength(1);
    expect(monthly[0].count).toBe(30);
    expect(monthly[0].mean * monthly[0].count).toBeCloseTo(240_000, 6);

    const [liveMonth] = await live(user.id, "ACTIVITY_STEPS", "monthly");
    expect(liveMonth.value).toBeCloseTo(240_000, 6);
    expect(liveMonth.count).toBe(30);
  });

  it("the rollup and live weekly folds agree bucket for bucket", async () => {
    const user = await seedUser();
    const rows: Row[] = [];
    for (let i = 0; i < 30; i++) {
      // Two manual readings on most days, a synced one every fifth day, and
      // both sources on every tenth day.
      if (i % 5 !== 0 || i % 10 === 0) {
        rows.push({
          type: "BLOOD_PRESSURE_SYS",
          source: "MANUAL",
          value: 130 + (i % 7),
          at: day(i, 7),
        });
        rows.push({
          type: "BLOOD_PRESSURE_SYS",
          source: "MANUAL",
          value: 140 - (i % 4),
          at: day(i, 20),
        });
      }
      if (i % 5 === 0) {
        rows.push({
          type: "BLOOD_PRESSURE_SYS",
          source: "WITHINGS",
          value: 118 + i,
          at: day(i, 9),
        });
      }
    }
    await seed(user.id, rows);

    const rollupWeeks = await readRollupBuckets(
      user.id,
      "BLOOD_PRESSURE_SYS",
      "WEEK",
      new Date("2025-10-27T00:00:00.000Z"),
      TO,
    );
    const liveWeeks = await readLiveBuckets({
      userId: user.id,
      type: "BLOOD_PRESSURE_SYS",
      from: new Date("2025-10-27T00:00:00.000Z"),
      to: new Date(TO.getTime() - 1),
      cap: 100,
      priorityJson: null,
      grain: "weekly",
      timeZone: "UTC",
    });

    expect(liveWeeks.map((w) => w.measuredAt)).toEqual(
      rollupWeeks.map((w) => w.bucketStart.toISOString()),
    );
    for (let i = 0; i < rollupWeeks.length; i++) {
      expect(liveWeeks[i].count).toBe(rollupWeeks[i].count);
      expect(liveWeeks[i].value).toBeCloseTo(rollupWeeks[i].mean, 9);
      expect(liveWeeks[i].minValue).toBe(rollupWeeks[i].minValue);
      expect(liveWeeks[i].maxValue).toBe(rollupWeeks[i].maxValue);
    }
    // Every day counts once with its canonical source: 24 manual-only days
    // with two readings each, and six synced days (WITHINGS leads the ladder,
    // so it wins the three days that carry both).
    const total = rollupWeeks.reduce((n, w) => n + w.count, 0);
    expect(total).toBe(24 * 2 + 6);
  });

  it("breaks a tie between unranked sources alphabetically on both paths", async () => {
    const user = await seedUser();
    // GLUCOSE carries no ladder: APPLE_HEALTH sorts before MANUAL by name,
    // although MANUAL comes first in the enum's declaration order.
    await getPrismaClient().measurement.createMany({
      data: [
        {
          userId: user.id,
          type: "BLOOD_GLUCOSE",
          value: 90,
          unit: "mg/dL",
          source: "MANUAL",
          measuredAt: day(3, 7),
        },
        {
          userId: user.id,
          type: "BLOOD_GLUCOSE",
          value: 110,
          unit: "mg/dL",
          source: "APPLE_HEALTH",
          measuredAt: day(3, 9),
        },
      ],
    });
    await recomputeUserRollups(user.id, {
      from: new Date("2025-10-01T00:00:00.000Z"),
      to: new Date("2026-01-01T00:00:00.000Z"),
    });

    const [rollupDay] = await readRollupBuckets(
      user.id,
      "BLOOD_GLUCOSE",
      "DAY",
      FROM,
      TO,
    );
    const [liveMonth] = await live(user.id, "BLOOD_GLUCOSE", "monthly");
    expect(rollupDay.mean).toBe(110);
    expect(liveMonth.value).toBe(110);
  });

  it("all-time weight figures keep one source per day", async () => {
    const user = await seedUser();
    const prisma = getPrismaClient();
    await prisma.measurement.createMany({
      data: [
        // Day A: the scale (WITHINGS leads the ladder) and a typed reading.
        {
          userId: user.id,
          type: "WEIGHT",
          value: 80,
          unit: "kg",
          source: "WITHINGS",
          measuredAt: day(3, 7),
        },
        {
          userId: user.id,
          type: "WEIGHT",
          value: 90,
          unit: "kg",
          source: "MANUAL",
          measuredAt: day(3, 9),
        },
        // Day B: a typed reading only.
        {
          userId: user.id,
          type: "WEIGHT",
          value: 70,
          unit: "kg",
          source: "MANUAL",
          measuredAt: day(4, 9),
        },
      ],
    });

    const extremes = await readAllTimeExtremes(user.id, ["WEIGHT"]);
    expect(extremes.get("WEIGHT")).toEqual({ mean: 75, min: 70, max: 80 });
  });

  it("rows older than the rollup window count one source per day in the all-time figures", async () => {
    const user = await seedUser();
    const prisma = getPrismaClient();
    const now = Date.now();
    const recent = new Date(now - 2 * DAY_MS);
    const old = new Date(now - 6 * 365 * DAY_MS);
    await prisma.measurement.createMany({
      data: [
        {
          userId: user.id,
          type: "WEIGHT",
          value: 82,
          unit: "kg",
          source: "MANUAL",
          measuredAt: recent,
        },
        // Six years ago, one day seen by two sources.
        {
          userId: user.id,
          type: "WEIGHT",
          value: 90,
          unit: "kg",
          source: "WITHINGS",
          measuredAt: old,
        },
        {
          userId: user.id,
          type: "WEIGHT",
          value: 100,
          unit: "kg",
          source: "MANUAL",
          measuredAt: new Date(old.getTime() + 60_000),
        },
      ],
    });
    await recomputeUserRollups(user.id, { granularities: ["DAY"] });

    const slice = await computeSummariesSlice(user.id);
    expect(slice.summaries.WEIGHT.count).toBe(2);
    expect(slice.summaries.WEIGHT.max).toBe(90);
    expect(slice.summaries.WEIGHT.mean).toBe(86);
  });

  it("the long-range chart and the yearly router fold the same canonical days", async () => {
    const user = await seedUser();
    const rows: Row[] = [];
    // Two years of blood pressure: typed in every tenth day, a synced cuff
    // (higher on the ladder) on every thirtieth day, both on some days.
    const start = Date.UTC(2024, 0, 1, 8);
    for (let i = 0; i < 730; i += 10) {
      rows.push({
        type: "BLOOD_PRESSURE_SYS",
        source: "MANUAL",
        value: 150,
        at: new Date(start + i * DAY_MS),
      });
      if (i % 30 === 0) {
        rows.push({
          type: "BLOOD_PRESSURE_SYS",
          source: "WITHINGS",
          value: 120,
          at: new Date(start + i * DAY_MS + 3_600_000),
        });
      }
    }
    await getPrismaClient().measurement.createMany({
      data: rows.map((r) => ({
        userId: user.id,
        type: r.type,
        value: r.value,
        unit: "mmHg",
        source: r.source,
        measuredAt: r.at,
      })),
    });
    await recomputeUserRollups(user.id, {
      from: new Date("2023-12-01T00:00:00.000Z"),
      to: new Date("2026-02-01T00:00:00.000Z"),
      granularities: ["DAY"],
    });

    const tiered = await readTieredRollupSeries({
      userId: user.id,
      type: "BLOOD_PRESSURE_SYS",
      from: new Date("2016-01-01T00:00:00.000Z"),
      to: new Date("2026-01-31T00:00:00.000Z"),
      priorityJson: null,
    });
    expect(tiered?.granularity).toBe("WEEK");
    // Every seeded day counts once, with the cuff winning the shared days.
    const days = 73;
    const cuffDays = 25;
    expect(tiered?.rows.reduce((n, r) => n + r.count, 0)).toBe(days);
    const total = tiered?.rows.reduce((n, r) => n + r.value * r.count, 0) ?? 0;
    expect(total).toBeCloseTo((days - cuffDays) * 150 + cuffDays * 120, 6);
  });
});
