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
 *
 * Since 1.50 such an account gets the day-total form: today's running total
 * against the usual full day, the days picked one source each by the
 * person's source order, as the "per day" chart picks them.
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
  it("answers a day-total account against its usual full day", async () => {
    const now = new Date();
    now.setUTCHours(20, 30, 0, 0);
    for (let back = 1; back <= 20; back += 1) {
      const day = dayKeyBack(now, back);
      // 14 complete days in the window: 4 000 … 10 500 by 500, oldest first.
      await writeDailyTotal(
        "GARMIN",
        `daily:${day}:steps`,
        day,
        back <= 14 ? 4_000 + (14 - back) * 500 : 50_000,
      );
    }
    const today = dayKeyBack(now, 0);
    await writeDailyTotal("GARMIN", `daily:${today}:steps`, today, 2_926);

    const { computeSameTimeBaseline } =
      await import("@/lib/insights/derived/same-time-baseline");
    const derived = await computeSameTimeBaseline(USER_ID, null, {
      type: "ACTIVITY_STEPS",
      now,
    });
    expect(derived.status).toBe("ok");
    if (derived.status !== "ok" || derived.value.mode !== "daily_total") {
      throw new Error(
        `expected the day-total form, got ${JSON.stringify(derived)}`,
      );
    }
    expect(derived.value.todayValue).toBe(2_926);
    // Days older than the 14-day window (the 50 000s) stay out.
    expect(derived.value.baselineDays).toBe(14);
    expect(derived.value.typicalValue).toBe(7_250);
    expect(derived.value.typicalLow).toBe(5_625);
    expect(derived.value.typicalHigh).toBe(8_875);
    expect(derived.value.dayRangeReached).toBe("not_yet");
    expect(derived.value.source).toBe("GARMIN");
    expect(Date.parse(derived.value.updatedAt)).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });

  it("takes one source per day, by source order, never a sum", async () => {
    const now = new Date();
    now.setUTCHours(20, 30, 0, 0);
    for (let back = 0; back <= 14; back += 1) {
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
    const { readCanonicalCumulativeDayTotals } =
      await import("@/lib/measurements/cumulative-day-totals");
    const read = (priorityJson: unknown) =>
      readCanonicalCumulativeDayTotals({
        userId: USER_ID,
        type: "ACTIVITY_STEPS",
        timeZone: "UTC",
        fromDateKey: dayKeyBack(now, 14),
        toDateKey: dayKeyBack(now, 0),
        priorityJson,
      });

    // The default ladder ranks Withings above Garmin; an import is on no
    // ladder and comes last.
    const byDefault = await read(null);
    expect(byDefault).toHaveLength(15);
    expect(new Set(byDefault.map((d) => d.source))).toEqual(
      new Set(["WITHINGS"]),
    );
    expect(byDefault.every((d) => d.total === 8_500)).toBe(true);

    const garminFirst = await read({ steps: ["GARMIN", "WITHINGS"] });
    expect(garminFirst.every((d) => d.source === "GARMIN")).toBe(true);
    expect(garminFirst.every((d) => d.total === 9_000)).toBe(true);
  });

  it("compares the watch's day, not the phone's hours, when the watch owns it", async () => {
    const now = new Date();
    now.setUTCHours(20, 30, 0, 0);
    await getPrismaClient().user.update({
      where: { id: USER_ID },
      data: { sourcePriorityJson: { steps: ["GARMIN", "APPLE_HEALTH"] } },
    });
    const today = dayKeyBack(now, 0);
    for (let back = 0; back <= 14; back += 1) {
      const day = dayKeyBack(now, back);
      await writeDailyTotal("GARMIN", `daily:${day}:steps`, day, 9_000);
    }
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
    const { computeSameTimeBaseline } =
      await import("@/lib/insights/derived/same-time-baseline");
    const derived = await computeSameTimeBaseline(USER_ID, null, {
      type: "ACTIVITY_STEPS",
      now,
    });
    expect(derived.status).toBe("ok");
    if (derived.status !== "ok") throw new Error("unreachable");
    expect(derived.value.mode).toBe("daily_total");
    expect(derived.value.todayValue).toBe(9_000);
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
