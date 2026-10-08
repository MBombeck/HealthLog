/**
 * The record `day-doors.spec.ts` opens days from.
 *
 * Every chart the journey clicks needs points to click: ten days of the
 * autonomic charge (the recovery page), of sleep and of mood (the sleep
 * chart, the mood line and the mood calendar), weight over the last ten days
 * and the same ten days a month earlier (the comparison chart draws a prior
 * period only where one exists), and two readings of one lab marker.
 *
 * Written through the app's own routes, once, from `globalSetup`. An account
 * that already holds the lab marker is taken as seeded, so a local re-run
 * against a reused database does not double every row.
 */
import { request as playwrightRequest } from "@playwright/test";

export const DAY_DOORS_ANALYTE = "Ferritin";

export async function seedDayDoorsRecord(
  baseURL: string,
  storageStatePath: string,
): Promise<void> {
  const ctx = await playwrightRequest.newContext({
    baseURL,
    storageState: storageStatePath,
  });
  try {
    const labs = await ctx.get("/api/labs");
    const body = (await labs.json()) as { data: unknown };
    if (JSON.stringify(body.data ?? null).includes(DAY_DOORS_ANALYTE)) return;

    const post = async (path: string, data: unknown): Promise<void> => {
      const res = await ctx.post(path, { data });
      if (res.status() === 409 || res.ok()) return;
      throw new Error(
        `[day-doors-fixture] ${path} answered ${res.status()}: ${(await res.text()).slice(0, 200)}`,
      );
    };
    const daysAgo = (days: number, hour = 8) => {
      const at = new Date(Date.now() - days * 86_400_000);
      at.setUTCHours(hour, 0, 0, 0);
      return at.toISOString();
    };

    for (let day = 1; day <= 10; day += 1) {
      await post("/api/measurements", {
        type: "ANS_CHARGE",
        value: 5 + day,
        measuredAt: daysAgo(day, 5),
      });
      await post("/api/measurements", {
        type: "SLEEP_DURATION",
        value: 400 + day * 4,
        measuredAt: daysAgo(day, 6),
      });
      await post("/api/measurements", {
        type: "WEIGHT",
        value: 72 + day / 10,
        measuredAt: daysAgo(day, 7),
      });
      // The same ten days, a month before: the prior period the comparison
      // draws beside them.
      await post("/api/measurements", {
        type: "WEIGHT",
        value: 73 + day / 10,
        measuredAt: daysAgo(day + 30, 7),
      });
      await post("/api/mood-entries", {
        mood: day % 2 ? "GUT" : "OKAY",
        moodLoggedAt: daysAgo(day, 19),
      });
    }

    for (const [days, value] of [
      [60, 41],
      [4, 58],
    ] as const) {
      await post("/api/labs", {
        analyte: DAY_DOORS_ANALYTE,
        panel: "Eisenstoffwechsel",
        value,
        unit: "ng/mL",
        referenceLow: 30,
        referenceHigh: 300,
        takenAt: daysAgo(days),
      });
    }
  } finally {
    await ctx.dispose();
  }
}
