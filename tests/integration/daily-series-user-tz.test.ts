/**
 * Issue #1026 — a daily total must land on the same calendar day whichever
 * chart range reads it.
 *
 * The 7-day chart pulls raw rows and buckets them by the user's own calendar
 * day. The 30-day chart reads the daily series from the rollup tier, whose
 * DAY buckets are cut at UTC midnight, and the chart then labels each bucket's
 * UTC-midnight start in the user's zone. East of UTC a sample shortly after
 * local midnight was counted on the previous day; west of UTC every bucket
 * was labelled one day early. Steps, active energy, flights and distance are
 * summed per day, so the drift showed up as whole totals moving between
 * neighbouring days when the range changed.
 *
 * This file seeds cumulative samples right next to local midnight for a
 * positive, a half-hour and a negative offset, warms the rollup tier the way
 * the live instance has it, and asserts that the daily series (both the
 * rollup-backed read and the live aggregate) buckets by the user's day.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import {
  readDailySeries,
  readLiveBuckets,
} from "@/lib/measurements/daily-series-read";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";
import { invalidateUserTimezone } from "@/lib/tz/resolver";
import { userDayKey } from "@/lib/tz/format";
import { localHmAsUtc } from "@/lib/tz/local-day";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

const DAY = new Date("2026-09-10T12:00:00Z");
const NEXT_DAY = new Date("2026-09-11T12:00:00Z");

async function seed(tz: string): Promise<string> {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: `tz-${tz.replace(/\W/g, "-").toLowerCase()}`,
      email: `tz-${tz.replace(/\W/g, "-").toLowerCase()}@example.test`,
      role: "USER",
      timezone: tz,
    },
  });
  invalidateUserTimezone(user.id);
  const rows = [
    // Just after local midnight: belongs to DAY.
    { at: localHmAsUtc(DAY, tz, 0, 20), value: 100 },
    // Just before the next local midnight: still DAY.
    { at: localHmAsUtc(DAY, tz, 23, 40), value: 1000 },
    // A daily total stamped at the start of the next local day.
    { at: localHmAsUtc(NEXT_DAY, tz, 0, 0), value: 7 },
    { at: localHmAsUtc(NEXT_DAY, tz, 12, 0), value: 3 },
  ];
  await prisma.measurement.createMany({
    data: rows.map((r) => ({
      userId: user.id,
      type: "ACTIVITY_STEPS" as const,
      value: r.value,
      unit: "count",
      measuredAt: r.at,
      source: "APPLE_HEALTH" as const,
    })),
  });
  return user.id;
}

function byLocalDay(
  rows: Array<{ measuredAt: string; value: number }>,
  tz: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const key = userDayKey(new Date(r.measuredAt), tz);
    out[key] = (out[key] ?? 0) + r.value;
  }
  return out;
}

const EXPECTED = { "2026-09-10": 1100, "2026-09-11": 10 };

/** The ladder puts Withings first for pulse, so its two readings are the day. */
const CANON_EXPECTED = [
  { day: "2026-09-10", value: 95, count: 2, min: 90, max: 100 },
  { day: "2026-09-11", value: 64, count: 1, min: 64, max: 64 },
];

describe("daily series buckets by the user's calendar day (#1026)", () => {
  for (const tz of ["Europe/Berlin", "Asia/Kolkata", "America/New_York"]) {
    it(`chart daily read agrees with the local day (${tz})`, async () => {
      const userId = await seed(tz);
      const from = new Date("2026-09-05T00:00:00Z");
      const to = new Date("2026-09-15T00:00:00Z");
      // Warm the rollup tier exactly as the write hook / backfill does.
      await recomputeUserRollups(userId, {
        types: ["ACTIVITY_STEPS"],
        granularities: ["DAY"],
        from,
        to,
      });
      const rows = await readDailySeries({
        userId,
        type: "ACTIVITY_STEPS",
        from,
        to,
        priorityJson: null,
      });
      expect(byLocalDay(rows, tz)).toEqual(EXPECTED);
    });

    it(`live daily aggregate agrees with the local day (${tz})`, async () => {
      const userId = await seed(tz);
      const rows = await readLiveBuckets({
        userId,
        type: "ACTIVITY_STEPS",
        from: new Date("2026-09-05T00:00:00Z"),
        to: new Date("2026-09-15T00:00:00Z"),
        cap: 366,
        priorityJson: null,
        grain: "daily",
        timeZone: tz,
      });
      expect(byLocalDay(rows, tz)).toEqual(EXPECTED);
    });
  }

  it("collapses a day to its canonical source before folding it", async () => {
    // Two sources on one day: only the ladder's pick is folded, and the
    // mean, count and spread all come from that one source.
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "tz-canon",
        email: "tz-canon@example.test",
        role: "USER",
        timezone: "Europe/Berlin",
      },
    });
    const at = (h: number) => localHmAsUtc(DAY, "Europe/Berlin", h, 0);
    await prisma.measurement.createMany({
      data: [
        { value: 60, source: "APPLE_HEALTH" as const, measuredAt: at(8) },
        { value: 70, source: "APPLE_HEALTH" as const, measuredAt: at(9) },
        { value: 90, source: "WITHINGS" as const, measuredAt: at(10) },
        { value: 100, source: "WITHINGS" as const, measuredAt: at(12) },
        { value: 50, source: "MANUAL" as const, measuredAt: at(11) },
        // The next day has one source only.
        {
          value: 64,
          source: "WITHINGS" as const,
          measuredAt: localHmAsUtc(NEXT_DAY, "Europe/Berlin", 7, 0),
        },
      ].map((r) => ({
        ...r,
        userId: user.id,
        type: "PULSE" as const,
        unit: "bpm",
      })),
    });
    const rows = await readLiveBuckets({
      userId: user.id,
      type: "PULSE",
      from: new Date("2026-09-05T00:00:00Z"),
      to: new Date("2026-09-15T00:00:00Z"),
      cap: 366,
      priorityJson: null,
      grain: "daily",
      timeZone: "Europe/Berlin",
    });
    expect(
      rows.map((r) => ({
        day: userDayKey(new Date(r.measuredAt), "Europe/Berlin"),
        value: r.value,
        count: r.count,
        min: r.minValue,
        max: r.maxValue,
      })),
    ).toEqual(CANON_EXPECTED);
  });
});
