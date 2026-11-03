/**
 * The keyed DAY refold does not depend on the session time zone.
 *
 * `measured_at` and `bucket_start` are naive UTC timestamps. The refold's day
 * filter and its delete compared them with a `timestamptz[]` parameter, which
 * Postgres converts through the session time zone: outside UTC neither matched
 * a single day, so the refold silently left every touched bucket stale. The
 * app pins its sessions to UTC, so this runs the pool in another zone on
 * purpose.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db-session")>();
  return { ...actual, TIME_ZONE_OPTION: "-c TimeZone=Pacific/Auckland" };
});

import { getPrismaClient, truncateAllTables } from "./setup";
import { prisma } from "@/lib/db";
import {
  recomputeBucketsForKeys,
  recomputeBucketsForMeasurement,
} from "@/lib/rollups/measurement-rollups";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("keyed DAY refold in a non-UTC session", () => {
  it("folds a new reading into its day", async () => {
    const [{ zone }] = await prisma.$queryRaw<Array<{ zone: string }>>`
      SELECT current_setting('TimeZone') AS zone
    `;
    expect(zone).toBe("Pacific/Auckland");

    const user = await getPrismaClient().user.create({
      data: { username: "tz-refold", email: "tz-refold@example.test" },
    });
    const day = new Date("2026-05-10T00:00:00.000Z");
    await getPrismaClient().measurement.createMany({
      data: [7, 19].map((hour, i) => ({
        userId: user.id,
        type: "WEIGHT" as const,
        value: 80 + i,
        unit: "kg",
        measuredAt: new Date(day.getTime() + hour * 3_600_000),
      })),
    });
    await recomputeBucketsForMeasurement(user.id, "WEIGHT", day);
    // A third reading lands; the refold has to fold it in.
    await getPrismaClient().measurement.create({
      data: {
        userId: user.id,
        type: "WEIGHT",
        value: 82,
        unit: "kg",
        measuredAt: new Date(day.getTime() + 21 * 3_600_000),
      },
    });

    await recomputeBucketsForKeys(user.id, [
      { type: "WEIGHT", measuredAt: new Date(day.getTime() + 7 * 3_600_000) },
    ]);

    const rows = await getPrismaClient().measurementRollup.findMany({
      where: { userId: user.id, granularity: "DAY" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bucketStart.toISOString()).toBe(day.toISOString());
    expect(rows[0]!.count).toBe(3);
  });
});
