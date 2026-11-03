/**
 * Local day keys from naive UTC timestamps, against a real Postgres.
 *
 * `measured_at` and `scheduled_for` hold UTC wall-clock time in `timestamp`
 * columns. The dashboard streak and the medication-compliance backfill keyed
 * them with a single `AT TIME ZONE tz`, which reads the value as local time
 * and shifts it the wrong way. Both now agree with `userDayKey`: a reading at
 * 23:30 UTC is the next day in Berlin and still the same day in Los Angeles,
 * a reading at 03:00 UTC is the previous day in Los Angeles.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { readActivityDayKeys } from "@/lib/dashboard/summary-reads";
import { userDayKey } from "@/lib/tz/format";

const prisma = getPrismaClient();
const USER = "local-day-keys";
const now = new Date();
/** UTC midnight ten days back. */
const D = Date.UTC(
  now.getUTCFullYear(),
  now.getUTCMonth(),
  now.getUTCDate() - 10,
);
const LATE = new Date(D + 23.5 * 3_600_000); // 23:30 UTC on D
const EARLY = new Date(D + 3 * 3_600_000); // 03:00 UTC on D
const key = (ms: number) => new Date(ms).toISOString().slice(0, 10);

beforeEach(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: USER,
      username: USER,
      email: `${USER}@example.test`,
      timezone: "Europe/Berlin",
    },
  });
});

describe("readActivityDayKeys", () => {
  beforeEach(async () => {
    await prisma.measurement.createMany({
      data: [
        { at: LATE, deleted: false },
        { at: EARLY, deleted: false },
        { at: new Date(D - 3 * 86_400_000), deleted: true },
      ].map(({ at, deleted }, i) => ({
        id: `${USER}-m${i}`,
        userId: USER,
        type: "WEIGHT" as const,
        source: "MANUAL" as const,
        value: 80,
        unit: "kg",
        measuredAt: at,
        deletedAt: deleted ? new Date() : null,
      })),
    });
  });

  const since = new Date(D - 5 * 86_400_000);

  it("keys a late reading onto the next day east of UTC", async () => {
    const keys = await readActivityDayKeys(
      prisma,
      USER,
      "Europe/Berlin",
      since,
      now,
    );
    expect(keys).toEqual([key(D), key(D + 86_400_000)]);
    expect(keys).toEqual(
      [EARLY, LATE].map((at) => userDayKey(at, "Europe/Berlin")),
    );
  });

  it("keys an early reading onto the previous day west of UTC", async () => {
    const keys = await readActivityDayKeys(
      prisma,
      USER,
      "America/Los_Angeles",
      since,
      now,
    );
    expect(keys).toEqual([key(D - 86_400_000), key(D)]);
    expect(keys).toEqual(
      [EARLY, LATE].map((at) => userDayKey(at, "America/Los_Angeles")),
    );
  });
});
