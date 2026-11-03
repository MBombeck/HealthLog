/**
 * A Withings measure sync at the volume a full re-read of a real account
 * carries: two years of daily weigh-ins (seven body-composition values each)
 * and a daily blood-pressure reading, about 7 300 measures over 7 300
 * (type, day) buckets.
 *
 * The manual full sync re-reads the whole history, and nearly all of it is
 * already stored. The run must therefore cost what CHANGED, not what was
 * READ: one set-based read and write for the measures, and a rollup refold
 * only for the days that gained or changed a reading. The timings are logged
 * for the record; the assertions are on behaviour, so a slow CI host cannot
 * fail them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/withings/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/withings/client")>();
  return { ...actual, fetchMeasurements: vi.fn() };
});

import { fetchMeasurements } from "@/lib/withings/client";
import { syncUserMeasurements } from "@/lib/withings/sync";

const USER = "user-withings-volume";
const DAY_MS = 86_400_000;
const DAYS = 730;

const prisma = getPrismaClient();

const WEIGH_IN: Array<[string, number]> = [
  ["WEIGHT", 81.4],
  ["BODY_FAT", 21.5],
  ["FAT_MASS", 17.5],
  ["FAT_FREE_MASS", 63.9],
  ["MUSCLE_MASS", 60.7],
  ["BONE_MASS", 3.2],
  ["TOTAL_BODY_WATER", 46.1],
];
const BP: Array<[string, number]> = [
  ["BLOOD_PRESSURE_SYS", 124],
  ["BLOOD_PRESSURE_DIA", 79],
  ["PULSE", 64],
];

/** Two years of history ending yesterday, at fixed UTC minutes. */
function history(anchor: number) {
  const out: Array<{ type: string; value: number; measuredAt: Date }> = [];
  for (let d = DAYS; d >= 1; d -= 1) {
    const day = anchor - d * DAY_MS;
    for (const [type, base] of WEIGH_IN) {
      out.push({
        type,
        value: base + (d % 7) * 0.1,
        measuredAt: new Date(day + 6 * 3_600_000 + 12 * 60_000),
      });
    }
    for (const [type, base] of BP) {
      out.push({
        type,
        value: base + (d % 5),
        measuredAt: new Date(day + 20 * 3_600_000 + 41 * 60_000),
      });
    }
  }
  return out;
}

beforeEach(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: USER,
      username: "withings-volume",
      email: "withings-volume@example.test",
    },
  });
  await prisma.withingsConnection.create({
    data: {
      userId: USER,
      withingsUserId: "wu-volume",
      accessToken: encrypt("access-token"),
      refreshToken: encrypt("refresh-token"),
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scope: "user.metrics,user.activity",
    },
  });
});

afterEach(() => {
  vi.mocked(fetchMeasurements).mockReset();
});

describe("Withings full sync at account volume", () => {
  it("writes the history once, then re-reads it at the cost of what changed", async () => {
    const anchor = Date.UTC(2026, 9, 20);
    const all = history(anchor);
    vi.mocked(fetchMeasurements).mockResolvedValue(all);

    let started = performance.now();
    const first = await syncUserMeasurements(USER, { fullSync: true });
    const firstMs = performance.now() - started;
    expect(first).toEqual({ imported: all.length, failed: false });
    expect(
      await prisma.measurement.count({
        where: { userId: USER, source: "WITHINGS" },
      }),
    ).toBe(all.length);
    expect(
      await prisma.measurementRollup.count({
        where: { userId: USER, granularity: "DAY" },
      }),
    ).toBe(DAYS * (WEIGH_IN.length + BP.length));

    // The re-read: the same history, one corrected weigh-in, one reading
    // that was deleted here and comes back, and a new reading today.
    const corrected = all.find((m) => m.type === "WEIGHT")!;
    const resurrected = all.find((m) => m.type === "PULSE")!;
    await prisma.measurement.updateMany({
      where: {
        userId: USER,
        type: "PULSE",
        measuredAt: resurrected.measuredAt,
      },
      data: { deletedAt: new Date() },
    });
    const today = {
      type: "WEIGHT",
      value: 80.9,
      measuredAt: new Date(anchor + 7 * 3_600_000),
    };
    const reread = [
      ...all.map((m) => (m === corrected ? { ...m, value: 79.0 } : m)),
      today,
    ];
    vi.mocked(fetchMeasurements).mockResolvedValue(reread);

    const before = new Date();
    started = performance.now();
    const second = await syncUserMeasurements(USER, { fullSync: true });
    const secondMs = performance.now() - started;
    console.log(
      `withings full sync: ${all.length} measures first run ${firstMs.toFixed(0)} ms, re-read ${secondMs.toFixed(0)} ms`,
    );

    expect(second).toEqual({ imported: reread.length, failed: false });
    const stored = await prisma.measurement.findMany({
      where: {
        userId: USER,
        source: "WITHINGS",
        OR: [
          { type: "WEIGHT", measuredAt: corrected.measuredAt },
          { type: "PULSE", measuredAt: resurrected.measuredAt },
          { type: "WEIGHT", measuredAt: today.measuredAt },
        ],
      },
      select: { type: true, value: true, measuredAt: true, deletedAt: true },
    });
    expect(stored).toHaveLength(3);
    expect(stored.every((m) => m.deletedAt === null)).toBe(true);
    expect(
      stored.find(
        (m) => m.measuredAt.getTime() === corrected.measuredAt.getTime(),
      )?.value,
    ).toBe(79.0);

    // Only the three days that changed were refolded; the other buckets keep
    // the aggregate the first run wrote.
    const refolded = await prisma.measurementRollup.findMany({
      where: {
        userId: USER,
        granularity: "DAY",
        computedAt: { gte: before },
      },
      select: { type: true, bucketStart: true, mean: true },
    });
    const dayOf = (d: Date) =>
      new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS);
    expect(
      refolded.map((r) => [r.type, r.bucketStart.toISOString()]).sort(),
    ).toEqual([
      ["PULSE", dayOf(resurrected.measuredAt).toISOString()],
      ["WEIGHT", dayOf(corrected.measuredAt).toISOString()],
      ["WEIGHT", dayOf(today.measuredAt).toISOString()],
    ]);
    expect(
      refolded.find(
        (r) =>
          r.type === "WEIGHT" &&
          r.bucketStart.getTime() === dayOf(corrected.measuredAt).getTime(),
      )?.mean,
    ).toBe(79.0);
  });
});
