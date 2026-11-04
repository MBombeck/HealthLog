/**
 * v1.39.4 — the chart's "All" range means one thing at every history length.
 *
 * A long history is served from the WEEK or MONTH rollup tier, a short one
 * from DAY rows, and a coverage miss from the live table. The chart folds
 * whatever arrives into the average day of each week (a range up to two
 * years) or month (longer). Seeded with real rows and folded through the real
 * rollup writer, a fully covered week or month must read the same average day
 * on every path: for steps the average daily total, for a level the average
 * of its days. Before, a MONTH-tier month of steps read
 * as the month's total, about thirty times the same month served by days.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { readDailySeries } from "@/lib/measurements/daily-series-read";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";
import { bucketTimeSeries } from "@/lib/charts/bucket-time-series";
import type { MeasurementType } from "@/generated/prisma/client";

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

const TZ = "America/Los_Angeles";
const DAY_MS = 86_400_000;
const NOW = new Date("2026-09-20T17:00:00.000Z");
/** The week and the month every history below covers fully. */
const WEEK = { from: "2026-06-08", to: "2026-06-14" };
const MONTH = { from: "2026-06-01", to: "2026-06-30" };

let seq = 0;
async function seedUser() {
  seq += 1;
  return getPrismaClient().user.create({
    data: {
      username: `chart-all-${seq}`,
      email: `chart-all-${seq}@example.test`,
      role: "USER",
      timezone: TZ,
    },
  });
}

/**
 * `days` days ending yesterday, at 18:00 UTC (11:00 in Los Angeles, the same
 * calendar day in both). Steps come as two rows a day; the level as one or
 * two readings, so a reading-weighted mean would differ from a day-weighted
 * one.
 */
function history(days: number) {
  const rows: Array<{ type: MeasurementType; value: number; at: Date }> = [];
  const end = Date.parse("2026-09-19T18:00:00.000Z");
  for (let i = 0; i < days; i += 1) {
    const at = new Date(end - i * DAY_MS);
    const steps = 6_000 + ((i * 37) % 5_000);
    rows.push({ type: "ACTIVITY_STEPS", value: steps - 1_000, at });
    rows.push({
      type: "ACTIVITY_STEPS",
      value: 1_000,
      at: new Date(at.getTime() + 60_000),
    });
    rows.push({ type: "PULSE", value: 60 + (i % 9), at });
    if (i % 3 === 0) {
      rows.push({
        type: "PULSE",
        value: 90,
        at: new Date(at.getTime() + 120_000),
      });
    }
  }
  return rows;
}

/** The average day of a period straight from the seeded rows. */
function expectedAverageDay(
  rows: ReturnType<typeof history>,
  type: MeasurementType,
  period: { from: string; to: string },
): number {
  const byDay = new Map<string, number[]>();
  for (const r of rows) {
    if (r.type !== type) continue;
    const day = r.at.toISOString().slice(0, 10);
    if (day < period.from || day > period.to) continue;
    byDay.set(day, [...(byDay.get(day) ?? []), r.value]);
  }
  const perDay = [...byDay.values()].map((values) =>
    type === "ACTIVITY_STEPS"
      ? values.reduce((s, v) => s + v, 0)
      : values.reduce((s, v) => s + v, 0) / values.length,
  );
  return perDay.reduce((s, v) => s + v, 0) / perDay.length;
}

/** The chart's point for `period`, folded at the bucket the range shows. */
async function chartPoint(
  userId: string,
  type: MeasurementType,
  bucket: "week" | "month",
  period: { from: string },
) {
  const rows = await readDailySeries({
    userId,
    type,
    from: new Date(NOW.getTime() - 3_650 * DAY_MS),
    to: NOW,
    priorityJson: null,
    timeZone: TZ,
  });
  const points = bucketTimeSeries(
    rows.map((row) => ({
      timestamp: new Date(row.measuredAt),
      values: { v: row.value },
    })),
    { bucket, timeZone: TZ },
  ).points;
  const point = points.find(
    (p) => new Date(p.timestamp).toISOString().slice(0, 10) === period.from,
  );
  return point?.values.v;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chart All range — one quantity at every history length", () => {
  it.each([
    ["days (a short history)", 200],
    ["weeks (one to two years)", 500],
    ["months (a long history)", 900],
  ])(
    "reads the same average day for a period served by %s, and by the live table",
    async (_label, days) => {
      const user = await seedUser();
      const rows = history(days);
      await getPrismaClient().measurement.createMany({
        data: rows.map((r) => ({
          userId: user.id,
          type: r.type,
          value: r.value,
          unit: r.type === "PULSE" ? "bpm" : "count",
          source: "APPLE_HEALTH" as const,
          measuredAt: r.at,
        })),
      });
      await recomputeUserRollups(user.id, {
        from: new Date(NOW.getTime() - (days + 40) * DAY_MS),
        to: NOW,
      });

      // The chart folds a span over two years into months, else weeks.
      const bucket = days > 730 ? "month" : "week";
      const period = bucket === "month" ? MONTH : WEEK;
      for (const type of ["ACTIVITY_STEPS", "PULSE"] as const) {
        const expected = expectedAverageDay(rows, type, period);
        const tier = await chartPoint(user.id, type, bucket, period);
        expect(tier, `${type} from the tier`).toBeCloseTo(expected, 6);
      }

      // A coverage miss serves the live table's days instead. Its daily
      // path keeps the oldest 365 days, so only the short history still
      // reaches June through it.
      if (days <= 365) {
        await getPrismaClient().measurementRollup.deleteMany({
          where: { userId: user.id },
        });
        for (const type of ["ACTIVITY_STEPS", "PULSE"] as const) {
          const live = await chartPoint(user.id, type, bucket, period);
          expect(live, `${type} from the live table`).toBeCloseTo(
            expectedAverageDay(rows, type, period),
            6,
          );
        }
      }
    },
  );
});
