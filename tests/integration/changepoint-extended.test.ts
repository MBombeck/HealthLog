/**
 * v1.44 — the health-status changepoint scan over 180 days against a real
 * Postgres. Past the DAY tier's 90-day reach the read folds per day in SQL
 * (`readDayAggregates`); this proves that path finds a step, reports its
 * segment sizes, and leaves a switched-off module's metric unread.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { buildExtendedChangepointSignals } from "@/lib/insights/derived/changepoint";

const DAY_MS = 24 * 60 * 60 * 1000;

function at(daysAgo: number): Date {
  const d = new Date(Date.now() - daysAgo * DAY_MS);
  d.setUTCHours(12, 0, 0, 0);
  return d;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("extended changepoint scan — real per-day fold", () => {
  it("finds a step in a metric past the five, over 120 days", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "cp-extended",
        email: "cp-extended@example.test",
        role: "USER",
        timezone: "UTC",
      },
    });
    const rows = [];
    // 120 days ago to 61 days ago at 14, then 60 days at 17, two readings a day.
    for (let d = 120; d >= 1; d -= 1) {
      const value = d > 60 ? 14 : 17;
      rows.push(
        { value, measuredAt: at(d) },
        { value, measuredAt: new Date(at(d).getTime() + 3_600_000) },
      );
      rows.push({
        value: d > 60 ? 140 : 150,
        measuredAt: at(d),
        type: "BLOOD_GLUCOSE" as const,
        unit: "mg/dL",
      });
    }
    await prisma.measurement.createMany({
      data: rows.map((r) => ({
        userId: user.id,
        type: "RESPIRATORY_RATE" as const,
        unit: "count/min",
        source: "APPLE_HEALTH" as const,
        ...r,
      })),
    });

    const shifts = await buildExtendedChangepointSignals(user.id, new Date(), {
      glucose: false,
    });
    expect(shifts.map((s) => s.metric)).toEqual(["RESPIRATORY_RATE"]);
    expect(shifts[0]).toMatchObject({
      beforeMean: 14,
      afterMean: 17,
      direction: "up",
      beforeDays: 60,
      afterDays: 60,
    });
  });
});
