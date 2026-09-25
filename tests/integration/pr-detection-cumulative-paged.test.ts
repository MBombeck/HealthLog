/**
 * #1031 — the best cumulative day, found a day at a time.
 *
 * `findBestCumulativeDay` read every row of a cumulative type into memory,
 * every half hour, for every account. On an account holding 784 000 active
 * energy rows it ran a 524 MB heap out of memory. It now reads a local day at
 * a time in time order, which gives the same answer because the canonical-
 * source pick it applies is per day.
 *
 * Pinned here at a size that spans several read pages: two sources report
 * the same days, the source ladder must decide each day on its own, the
 * best day sits in the middle of the history, and no read of the history is
 * unbounded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const { detectPersonalRecordsForUser } =
  await import("@/lib/personal-records/pr-detection-worker");

const USER = "user-pr-cumulative-paged";
const DAYS = 40;
const PER_DAY = 300; // 12 000 Apple rows plus a Withings total per day

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: USER,
      username: USER,
      email: `${USER}@example.test`,
      timezone: "UTC",
    },
  });
});

describe("best cumulative day across many pages", () => {
  it("sums each day's canonical source and finds the best day without an unbounded read", async () => {
    const prisma = getPrismaClient();
    const start = Date.UTC(2025, 0, 1, 6);
    const rows = [];
    for (let day = 0; day < DAYS; day++) {
      // Day 23 is the best Apple day; the Withings total on day 5 is larger
      // still but loses to Apple on that day by the default ladder, so it
      // must not win: if the days were pooled across sources it would.
      const perSample = day === 23 ? 40 : 20;
      for (let i = 0; i < PER_DAY; i++) {
        rows.push({
          userId: USER,
          type: "ACTIVITY_STEPS" as const,
          value: perSample,
          unit: "steps",
          source: "APPLE_HEALTH" as const,
          measuredAt: new Date(start + day * 86_400_000 + i * 60_000),
          externalId: `hk-${day}-${i}`,
        });
      }
      rows.push({
        userId: USER,
        type: "ACTIVITY_STEPS" as const,
        value: day === 5 ? 50_000 : 1_000,
        unit: "steps",
        source: "WITHINGS" as const,
        measuredAt: new Date(start + day * 86_400_000 + 12 * 3_600_000),
        externalId: `w-${day}`,
      });
    }
    await prisma.measurement.createMany({ data: rows });

    // Every read of the steps history, through a client that records it.
    const reads: Array<number | undefined> = [];
    const recording = prisma.$extends({
      query: {
        measurement: {
          findMany({ args, query }) {
            if (JSON.stringify(args.where ?? {}).includes("ACTIVITY_STEPS")) {
              reads.push(args.take);
            }
            return query(args);
          },
        },
      },
    });

    await detectPersonalRecordsForUser(USER, {
      silent: true,
      prisma: recording as unknown as typeof prisma,
    });

    const record = await prisma.personalRecord.findFirstOrThrow({
      where: { userId: USER, metricType: "ACTIVITY_STEPS" },
    });
    expect(record.value).toBe(40 * PER_DAY);
    expect(record.achievedAt.toISOString()).toBe(
      new Date(start + 23 * 86_400_000 + (PER_DAY - 1) * 60_000).toISOString(),
    );

    // Several bounded pages, never one read of the whole history.
    expect(reads.length).toBeGreaterThan(1);
    for (const take of reads) {
      expect(take).toBeDefined();
      expect(take!).toBeLessThanOrEqual(5_000);
    }
  });
});
