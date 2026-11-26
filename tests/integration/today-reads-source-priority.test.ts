/**
 * Today's value of a ranked vital follows the source-priority ladder (#1514).
 *
 * A ring worn through the night and a watch worn in the day both report a
 * resting heart rate for the same date, each anchored at local noon. The
 * metric page shows the ladder-winning source's figure; the readiness score,
 * the coincident-deviation flag and the briefing's signal of the day used to
 * read every source of the day together: readiness took the mean of the two
 * (and moved whenever the lower-ranked watch revised its estimate), and the
 * signal took whichever row sorted last.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import type { Prisma } from "@/generated/prisma/client";
import { readLatestDayMean } from "@/lib/insights/derived/coincident-deviation";
import { readDayMeanSeries } from "@/lib/insights/derived/baseline";
import { extractFeatures } from "@/lib/insights/features";
import { readDayAggregates } from "@/lib/measurements/day-aggregates";
import { invalidateUserTimezone } from "@/lib/tz/resolver";

const prisma = getPrismaClient();
const DAY = 86_400_000;

const U = "today-source-priority";
const TZ = "Australia/Melbourne";
/** 14:00 in Melbourne (UTC+11 in November). */
const NOW = new Date("2026-11-20T03:00:00.000Z");
/** Local noon in Melbourne, `daysAgo` days before NOW's local date. */
const noon = (daysAgo: number) =>
  new Date(Date.UTC(2026, 10, 20, 1, 0, 0) - daysAgo * DAY);

function rhr(
  id: string,
  source: "GOOGLE_HEALTH" | "GARMIN",
  value: number,
  at: Date,
): Prisma.MeasurementCreateManyInput {
  return {
    id,
    userId: U,
    type: "RESTING_HEART_RATE",
    unit: "bpm",
    source,
    value,
    measuredAt: at,
  };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  await prisma.appSettings.create({ data: { id: "singleton" } });
  await prisma.user.create({
    data: {
      id: U,
      username: U,
      timezone: TZ,
      createdAt: new Date(NOW.getTime() - 60 * DAY),
    },
  });
  invalidateUserTimezone(U);
  const rows: Prisma.MeasurementCreateManyInput[] = [];
  // Thirty nights from the ring, steady around 55.
  for (let d = 0; d < 30; d++) {
    rows.push(rhr(`g-${d}`, "GOOGLE_HEALTH", 54 + (d % 3), noon(d)));
  }
  // The watch, worn only in the day: one early estimate today, far off.
  rows.push(rhr("garmin-today", "GARMIN", 82, noon(0)));
  await prisma.measurement.createMany({ data: rows });
});

afterAll(() => {
  vi.useRealTimers();
});

describe("today's value of a ranked vital", () => {
  it("still folds every source when no priority is given", async () => {
    const days = await readDayAggregates({
      userId: U,
      type: "RESTING_HEART_RATE",
      since: new Date(NOW.getTime() - 2 * DAY),
      timeZone: TZ,
      latestDayOnly: true,
    });
    const today = days.at(-1)!;
    expect(today.n).toBe(2);
  });

  it("reads the ring's figure for readiness, not the mean with the watch", async () => {
    const latest = await readLatestDayMean(
      U,
      "RESTING_HEART_RATE",
      30,
      NOW,
      TZ,
      { plausibleOnly: false },
    );
    expect(latest?.day).toBe("2026-11-20");
    expect(latest?.value).toBe(54);
  });

  it("keeps the baseline's days to the same source", async () => {
    const { points } = await readDayMeanSeries(
      U,
      "RESTING_HEART_RATE",
      30,
      NOW,
      new Map(),
      TZ,
    );
    expect(points.at(-1)).toEqual({ day: "2026-11-20", mean: 54 });
    expect(points).toHaveLength(30);
  });

  it("follows the user's own ladder when they rank the watch first", async () => {
    const latest = await readLatestDayMean(
      U,
      "RESTING_HEART_RATE",
      30,
      NOW,
      TZ,
      {
        plausibleOnly: false,
        sourcePriority: {
          restingHeartRate: ["GARMIN", "GOOGLE_HEALTH"],
        },
      },
    );
    expect(latest?.value).toBe(82);
  });

  it("gives the briefing's signal of the day the ring's figure", async () => {
    const features = await extractFeatures(U, false);
    const signal = (
      features as {
        signalsOfDay?: Array<{ metric: string; latest: number }>;
      }
    ).signalsOfDay?.find((s) => s.metric === "resting_hr");
    expect(signal?.latest).toBe(54);
  });
});
