/**
 * The same-time baseline against provider daily totals, on real Postgres.
 *
 * The stored day profiles come from the Apple Health samples only: the
 * cumulative drain folds `source = APPLE_HEALTH` rows, and the phone's hour
 * buckets are Apple's too. The live fold that stands in for the days the drain
 * has not reached must read the same rows. A provider's daily total (Garmin
 * `daily:…`, Withings `withings:activity:…`, Gadgetbridge `gb:steps:…`) is not
 * a sample: folded, it puts the whole day into the hour it is stamped at, so a
 * Garmin-only account sat on "learning your usual day, 0 of 14" for ever, and
 * an account with both pushed today's curve up by the provider's whole total.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const USER_ID = "user-same-time-daily-totals";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: "same-time-daily-totals",
      email: "same-time-daily-totals@example.test",
      timezone: "UTC",
    },
  });
});

function dayKeyBack(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

async function writeDailyTotal(
  source: "GARMIN" | "WITHINGS" | "IMPORT",
  externalId: string,
  dateKey: string,
  value: number,
) {
  await getPrismaClient().measurement.create({
    data: {
      userId: USER_ID,
      type: "ACTIVITY_STEPS",
      value,
      unit: "count",
      source,
      externalId,
      measuredAt: new Date(`${dateKey}T12:00:00.000Z`),
    },
  });
}

describe("same-time baseline with provider daily totals", () => {
  it("treats a daily-total-only account as having no intraday stream", async () => {
    const now = new Date();
    now.setUTCHours(20, 30, 0, 0);
    for (let back = 0; back <= 20; back += 1) {
      const day = dayKeyBack(now, back);
      await writeDailyTotal("GARMIN", `daily:${day}:steps`, day, 9_000);
      await writeDailyTotal(
        "WITHINGS",
        `withings:activity:${day}:steps`,
        day,
        8_500,
      );
      await writeDailyTotal("IMPORT", `gb:steps:${day}`, day, 8_800);
    }
    const { computeSameTimeBaseline } =
      await import("@/lib/insights/derived/same-time-baseline");
    const derived = await computeSameTimeBaseline(USER_ID, null, {
      type: "ACTIVITY_STEPS",
      now,
    });
    expect(derived.status).toBe("insufficient");
    expect(derived.status === "insufficient" && derived.reason).toBe(
      "no_intraday_today",
    );
  });

  it("keeps a provider daily total out of today's Apple Health curve", async () => {
    const now = new Date();
    now.setUTCHours(20, 30, 0, 0);
    const today = dayKeyBack(now, 0);
    for (const hour of [8, 9]) {
      await getPrismaClient().measurement.create({
        data: {
          userId: USER_ID,
          type: "ACTIVITY_STEPS",
          value: 100,
          unit: "count",
          source: "APPLE_HEALTH",
          externalId: `sample-${hour}`,
          measuredAt: new Date(
            `${today}T${String(hour).padStart(2, "0")}:10:00.000Z`,
          ),
        },
      });
    }
    await writeDailyTotal("GARMIN", `daily:${today}:steps`, today, 9_000);

    const { readCumulativeDayProfiles } =
      await import("@/lib/measurements/intraday-cumulative-profile");
    const profiles = await readCumulativeDayProfiles({
      userId: USER_ID,
      type: "ACTIVITY_STEPS",
      timezone: "UTC",
      endDateKey: today,
      windowDays: 14,
    });
    const todayProfile = profiles.find((p) => p.dateKey === today);
    expect(todayProfile?.dayTotal).toBe(200);
    expect(todayProfile?.sampleCount).toBe(2);
    expect(todayProfile?.hourlyCumulative[12]).toBe(200);
  });
});
