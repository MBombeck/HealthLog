/**
 * The Google Health sleep sweep on a full backfill, against Postgres.
 *
 * A first sync reads the whole sleep history, one session per night. Each
 * night's window used to carry every fresh segment id of the fetch, so five
 * years sent 1825 queries with 54750 bound values each: over Postgres's limit
 * of 32767, every one failed with a warning and the process was busy building
 * them for minutes. With each window protecting only the fresh rows inside it
 * (`protectFreshRowsInWindows`), the same fetch sweeps without a warning, a
 * stale row a re-score left behind is tombstoned, and a row another session
 * reported over the same night survives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { protectFreshRowsInWindows } from "@/lib/google-health/sync-sleep";
import { replaceStaleGoogleHealthSleep } from "@/lib/google-health/sync-core";
import * as logContext from "@/lib/logging/context";

import { getPrismaClient, truncateAllTables } from "./setup";

const USER_ID = "user-google-sleep-sweep";
const NIGHTS = 5 * 365;
const SEGMENTS = 30;
const DAY = 86_400_000;
const FIRST_NIGHT = Date.UTC(2021, 0, 1, 22);

const segmentId = (night: number, s: number) => `night${night}:sleep:${s}`;
const segmentEnd = (night: number, s: number) =>
  new Date(FIRST_NIGHT + night * DAY + (s + 1) * 16 * 60_000);

function backfill() {
  const windows = [];
  const readings = [];
  for (let n = 0; n < NIGHTS; n++) {
    const ids: string[] = [];
    for (let s = 0; s < SEGMENTS; s++) {
      ids.push(segmentId(n, s));
      readings.push({
        externalId: segmentId(n, s),
        measuredAt: segmentEnd(n, s),
      });
    }
    windows.push({
      windowStart: new Date(FIRST_NIGHT + n * DAY),
      windowEnd: new Date(FIRST_NIGHT + n * DAY + 8 * 3_600_000),
      keepIds: ids,
    });
  }
  return { windows, readings };
}

async function seedSleepRow(externalId: string, measuredAt: Date) {
  await getPrismaClient().measurement.create({
    data: {
      userId: USER_ID,
      type: "SLEEP_DURATION",
      source: "GOOGLE_HEALTH",
      value: 16,
      unit: "min",
      measuredAt,
      externalId,
      sleepStage: "CORE",
    },
  });
}

let warnings: string[];

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: { id: USER_ID, username: "google-sleep-sweep" },
  });
  warnings = [];
  vi.spyOn(logContext, "getEvent").mockReturnValue({
    addWarning: (w: string) => warnings.push(w),
  } as unknown as ReturnType<typeof logContext.getEvent>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the Google Health sleep sweep on a five-year backfill", () => {
  it("sweeps every night without a warning, and keeps what another session reported", async () => {
    const night = 1000;
    // A segment from an earlier scoring that the fresh fetch no longer has.
    await seedSleepRow("old-scoring:sleep:x", segmentEnd(night, 3));
    // A row another session reported over the same night, fresh in this fetch.
    await seedSleepRow("nap:sleep:y", segmentEnd(night, 5));
    // A fresh segment already stored from an earlier sync.
    await seedSleepRow(segmentId(night, 7), segmentEnd(night, 7));

    const { windows, readings } = backfill();
    readings.push({
      externalId: "nap:sleep:y",
      measuredAt: segmentEnd(night, 5),
    });

    const removed = await replaceStaleGoogleHealthSleep(
      USER_ID,
      protectFreshRowsInWindows(windows, readings),
    );

    expect(warnings).toEqual([]);
    expect(removed).toBe(1);
    const rows = await getPrismaClient().measurement.findMany({
      where: { userId: USER_ID },
      select: { externalId: true, deletedAt: true },
      orderBy: { externalId: "asc" },
    });
    expect(rows.map((r) => [r.externalId, r.deletedAt !== null])).toEqual([
      ["nap:sleep:y", false],
      [segmentId(night, 7), false],
      ["old-scoring:sleep:x", true],
    ]);
  }, 120_000);
});
