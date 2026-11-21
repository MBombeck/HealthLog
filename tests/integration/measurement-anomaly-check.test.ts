/**
 * The `MEASUREMENT_ANOMALY` push against real Postgres: the opt-in read
 * through the notification matrix, the changepoint scan over real day means,
 * and the once-per-shift and once-a-week claims in `notification_events`.
 * The dispatcher is stubbed; what it would deliver is covered by its own
 * suites.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { startOfLocalDayInTz } from "@/lib/tz/local-day";

import { getPrismaClient, truncateAllTables } from "./setup";

const dispatch = vi.hoisted(() =>
  vi.fn(async (_payload: Record<string, unknown>) => ({ dispatched: true })),
);
vi.mock("@/lib/notifications/dispatcher", () => ({
  dispatchNotification: dispatch,
}));

const DAY_MS = 86_400_000;
const TZ = "Europe/Berlin";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  dispatch.mockClear();
});

async function seedPerson(optIn: boolean) {
  const db = getPrismaClient();
  const user = await db.user.create({
    data: {
      username: "anomaly-owner",
      email: "anomaly-owner@example.test",
      timezone: TZ,
      locale: "en",
    },
  });
  const channel = await db.notificationChannel.create({
    data: { userId: user.id, type: "NTFY", config: "unused", enabled: true },
  });
  if (optIn) {
    await db.notificationPreference.create({
      data: {
        channelId: channel.id,
        eventType: "MEASUREMENT_ANOMALY",
        enabled: true,
      },
    });
  }
  // Sixty days of resting heart rate around 55, stepping to 63 twelve days
  // ago and holding there.
  const todayStart = startOfLocalDayInTz(new Date(), TZ).getTime();
  const rows = [];
  for (let d = 60; d >= 1; d -= 1) {
    const wobble = (d % 3) - 1;
    rows.push({
      userId: user.id,
      type: "RESTING_HEART_RATE" as const,
      value: (d > 12 ? 55 : 63) + wobble,
      unit: "bpm",
      source: "APPLE_HEALTH" as const,
      measuredAt: new Date(todayStart - d * DAY_MS + 12 * 3_600_000),
    });
  }
  await db.measurement.createMany({ data: rows });
  return user.id;
}

/** An instant in today's 10 o'clock hour, Berlin. */
function atTen(): Date {
  return new Date(
    startOfLocalDayInTz(new Date(), TZ).getTime() + 10 * 3_600_000 + 60_000,
  );
}

describe("the measurement anomaly push", () => {
  it("tells an opted-in person once, then holds the week and the shift", async () => {
    const userId = await seedPerson(true);
    const { runMeasurementAnomalyTick } =
      await import("@/lib/jobs/measurement-anomaly-check");

    expect(await runMeasurementAnomalyTick(atTen())).toEqual({
      scanned: 1,
      sent: 1,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      eventType: "MEASUREMENT_ANOMALY",
      userId,
      metadata: { metric: "RESTING_HEART_RATE" },
    });
    const claims = await getPrismaClient().notificationEvent.findMany({
      where: { recordUserId: userId },
      select: { dedupKey: true },
    });
    expect(claims.map((c) => c.dedupKey).sort()).toEqual([
      "shift:RESTING_HEART_RATE:up",
      "week",
    ]);

    // The next tick finds the shift told.
    expect((await runMeasurementAnomalyTick(atTen())).sent).toBe(0);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("scans nobody who did not switch it on", async () => {
    await seedPerson(false);
    const { runMeasurementAnomalyTick } =
      await import("@/lib/jobs/measurement-anomaly-check");
    expect(await runMeasurementAnomalyTick(atTen())).toEqual({
      scanned: 0,
      sent: 0,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
