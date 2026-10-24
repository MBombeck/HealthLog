/**
 * Shared cases for the request-clock suites: the summary windows count from
 * the clock of the request, never from the database's.
 *
 * The summaries slice and the comprehensive aggregator cut some windows in JS
 * and the rest in SQL. The SQL side read `NOW()`, so with the process clock
 * pinned (as every parity walk does) the 7-, 30- and 60-day means and the
 * 90-day canonical pick were cut hours or days away from the JS windows, and
 * the walks passed or failed with the hour they ran at.
 *
 * Each case pins the process clock to a day long before the database's own
 * clock, at four times of day, and lays readings ten minutes either side of
 * every window edge. Counted from the pinned clock the figures are exact;
 * counted from the database clock every window would be empty. Both read
 * paths run: the live aggregate before any rollup exists, the rollup path
 * after the DAY tier is built. The streak's local days ride along: their
 * bounds are instants too, and a session outside UTC moved them.
 *
 * Not a test file. Only for tests under `tests/integration/`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  computeSummariesSlice,
  readSevenDayMeans,
} from "@/lib/analytics/summaries-slice";
import { readActivityDayKeys } from "@/lib/dashboard/summary-reads";
import { buildComprehensiveAggregate } from "@/lib/insights/comprehensive-aggregator";
import { settleBackgroundTasks } from "@/lib/logging/background-tasks";
import {
  isFullyCovered,
  probeRollupCoverage,
} from "@/lib/rollups/measurement-coverage";
import { userDayKey } from "@/lib/tz/format";

import { makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const DAY = 86_400_000;
const MINUTE = 60_000;

/** A day far from any database clock the suite will meet. */
const PINNED_DAY = Date.UTC(2025, 2, 12);
const TIMES_OF_DAY: Array<[string, number]> = [
  ["00:30", 30 * MINUTE],
  ["09:00", 9 * 60 * MINUTE],
  ["12:00", 12 * 60 * MINUTE],
  ["23:30", (23 * 60 + 30) * MINUTE],
];

/**
 * Weight readings (one source, so the canonical pick keeps them all) placed
 * ten minutes inside or outside an edge, as offsets from `now`.
 */
const READINGS: Array<[offsetMs: number, value: number]> = [
  [-60 * MINUTE, 80],
  [-7 * DAY + 10 * MINUTE, 80], // inside the 7-day window
  [-7 * DAY - 10 * MINUTE, 100], // outside it, inside the 30-day one
  [-30 * DAY - 10 * MINUTE, 90], // the month before
  [-60 * DAY + 10 * MINUTE, 90], // the month before, at its start
  [-60 * DAY - 10 * MINUTE, 200], // older than the month before
  [-90 * DAY + 10 * MINUTE, 70], // inside the 90-day window
  [-90 * DAY - 10 * MINUTE, 300], // outside it
];

/** The figures the readings give when every window counts from `now`. */
const EXPECTED = {
  avg7: 80,
  avg30: Math.round(((80 + 80 + 100) / 3) * 100) / 100,
  avg30LastMonth: 90,
  /** Median of 70, 80, 80, 90, 90, 100, 200. */
  median: 90,
  /** Readings inside the 90-day window. */
  inNinetyDays: 7,
};

export function defineRequestClockCases(expectedZone: string): void {
  const prisma = getPrismaClient();

  afterAll(() => {
    vi.useRealTimers();
  });

  it(`runs in the ${expectedZone} session zone`, async () => {
    const [{ zone }] = await prisma.$queryRaw<Array<{ zone: string }>>`
      SELECT current_setting('TimeZone') AS zone
    `;
    expect(zone).toBe(expectedZone);
  });

  describe.each(TIMES_OF_DAY)("with the clock at %s UTC", (_label, time) => {
    const now = new Date(PINNED_DAY + time);
    let userId = "";

    beforeAll(async () => {
      vi.useFakeTimers({ toFake: ["Date"], now });
      await truncateAllTables(prisma);
      const user = await makeUser({ timezone: "UTC" });
      userId = user.id;
      await prisma.measurement.createMany({
        data: READINGS.map(([offset, value]) => {
          const measuredAt = new Date(now.getTime() + offset);
          return {
            userId,
            type: "WEIGHT" as const,
            value,
            unit: "kg",
            measuredAt,
            createdAt: measuredAt,
          };
        }),
      });
    });

    afterAll(async () => {
      await settleBackgroundTasks();
      vi.useRealTimers();
    });

    async function expectWindows(path: "live" | "rollup"): Promise<void> {
      expect(isFullyCovered(await probeRollupCoverage(userId))).toBe(
        path === "rollup",
      );

      const slice = await computeSummariesSlice(userId);
      await settleBackgroundTasks();
      const weight = slice.summaries.WEIGHT;
      expect(weight.avg7).toBe(EXPECTED.avg7);
      expect(weight.avg30).toBe(EXPECTED.avg30);
      expect(weight.avg30LastMonth).toBe(EXPECTED.avg30LastMonth);
      expect(weight.median).toBe(EXPECTED.median);
      // The staleness of the latest reading counts from the same clock.
      expect(slice.lastSeenByType.WEIGHT?.daysAgo).toBe(0);

      const aggregate = await buildComprehensiveAggregate(userId);
      await settleBackgroundTasks();
      const summary = aggregate.summaries.WEIGHT;
      expect(summary?.avg7).toBe(EXPECTED.avg7);
      expect(summary?.avg30).toBe(EXPECTED.avg30);
      expect(summary?.avg30LastMonth).toBe(EXPECTED.avg30LastMonth);
      expect(aggregate.weightRawRows).toHaveLength(EXPECTED.inNinetyDays);

      expect((await readSevenDayMeans(userId)).WEIGHT).toBe(EXPECTED.avg7);
    }

    it("keys the streak's local days on the request's clock", async () => {
      const keys = await readActivityDayKeys(
        prisma,
        userId,
        "UTC",
        new Date(now.getTime() - 3 * DAY),
        now,
      );
      expect(keys).toEqual([
        userDayKey(new Date(now.getTime() - 60 * MINUTE), "UTC"),
      ]);
    });

    it("cuts every window of the live aggregate on the request's clock", async () => {
      await expectWindows("live");
    });

    it("cuts every window of the rollup path on the request's clock", async () => {
      const rollups = await vi.importActual<
        typeof import("@/lib/rollups/measurement-rollups")
      >("@/lib/rollups/measurement-rollups");
      await rollups.ensureUserRollupsFresh(userId);
      await settleBackgroundTasks();
      await expectWindows("rollup");
    });
  });
}
