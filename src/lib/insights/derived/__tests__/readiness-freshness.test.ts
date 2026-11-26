/**
 * Readiness says which day it rests on (1.50).
 *
 * The blend takes each vital's latest day mean in the window and the latest
 * scorable night. At seven in the morning, before the band has synced, that
 * is yesterday's resting pulse and the night before last, and a number built
 * from them reads as a claim about today. `fresh` is true only when every
 * input the account still delivers is from the reader's own today. Until
 * local noon an input from yesterday may still sync and keeps the blend
 * stale; after that, and for anything older, the input has gone quiet and
 * drops out like a missing one, so one sensor nobody wears any more cannot
 * hold readiness stale for the whole window. A stale readiness names the
 * value stored for its day, never the live blend of mixed days. Mood carries
 * no date and does not count for freshness.
 *
 * "Today" is the reader's calendar day, so the zone matters: the same
 * readings are fresh for a reader in UTC and a day old for one in Auckland.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/measurements/day-aggregates", async () => ({
  readDayAggregates: (
    await import("@/lib/measurements/__tests__/fake-day-aggregates")
  ).fakeReadDayAggregates,
}));
vi.mock("@/lib/measurements/dense-bucket-read", async () => {
  const { makeFakeDenseBucketRead } =
    await import("@/lib/measurements/__tests__/fake-dense-bucket-read");
  const { prisma } = await import("@/lib/db");
  return makeFakeDenseBucketRead((args) =>
    (prisma.measurement.findMany as (a: unknown) => never)(args),
  );
});
vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn(), findFirst: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock("@/lib/rollups/measurement-coverage", () => ({
  probeRollupCoverage: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/lib/rollups/measurement-read-wmy", () => ({
  readBestGranularityRollups: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn().mockResolvedValue("UTC"),
}));

import { prisma } from "@/lib/db";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { computeReadiness, type ReadinessValue } from "../readiness";
import { computeDerivedMetric } from "../dispatch";
import { readinessValue } from "@/lib/openapi/routes/insights/schemas";
import { openApiComponents } from "@/lib/openapi/routes";

const PROFILE = { ageYears: 40, sex: "MALE" as const };
const DAY_MS = 24 * 60 * 60 * 1000;
const findMany = prisma.measurement.findMany as ReturnType<typeof vi.fn>;
const findFirst = prisma.measurement.findFirst as ReturnType<typeof vi.fn>;
const moodFindMany = prisma.moodEntry.findMany as ReturnType<typeof vi.fn>;
const resolveTz = resolveUserTimezone as ReturnType<typeof vi.fn>;

/**
 * Ten daily resting-pulse and HRV readings at `hourUtc`, the newest on
 * `lastDay` (a UTC date), and one main night per day waking at 06:00 UTC up
 * to `lastNight`. Values sit on the baseline so the blend is ok.
 */
function seed(opts: {
  lastDay: string;
  lastNight: string;
  hourUtc?: number;
  hrv?: number;
}) {
  const hour = opts.hourUtc ?? 6;
  const at = (day: string, back: number, h: number) =>
    new Date(
      new Date(`${day}T00:00:00Z`).getTime() - back * DAY_MS + h * 3_600_000,
    );
  const vitals = (type: string, value: number) =>
    Array.from({ length: 10 }, (_, i) => ({
      value,
      measuredAt: at(opts.lastDay, i, hour),
      type,
    }));
  const nights = Array.from({ length: 5 }, (_, i) => ({
    value: 420,
    // A seven-hour session stamped at its end, 06:00 UTC on the wake day.
    measuredAt: at(opts.lastNight, i, 6),
    sleepStage: "ASLEEP",
    source: "APPLE_HEALTH",
    deviceType: null,
  }));
  findMany.mockImplementation(async (args: { where: { type: unknown } }) => {
    const type = args.where.type;
    if (type === "RESTING_HEART_RATE") return vitals(type, 58);
    if (type === "HEART_RATE_VARIABILITY") return vitals(type, opts.hrv ?? 65);
    if (type === "SLEEP_DURATION") return nights;
    return [];
  });
}

type StoredRow = { value: number; source: "COMPUTED"; measuredAt: Date };
let storedRows: StoredRow[] = [];

/**
 * A row the nightly job stored for the night that ended on `wakeDay`. The
 * fake `findFirst` honours the read's `measuredAt` bounds and its newest-first
 * order, so a bound that leaves a row out is visible here.
 */
function stored(value: number, wakeDay: string, hourUtc = 12) {
  storedRows.push({
    value,
    source: "COMPUTED",
    measuredAt: new Date(
      new Date(`${wakeDay}T00:00:00Z`).getTime() - DAY_MS + hourUtc * 3_600_000,
    ),
  });
  findFirst.mockImplementation(
    async (args: {
      where: { measuredAt?: { gte?: Date; lt?: Date; lte?: Date } };
    }) => {
      const b = args.where.measuredAt ?? {};
      return (
        storedRows
          .filter(
            (r) =>
              (!b.gte || r.measuredAt >= b.gte) &&
              (!b.lt || r.measuredAt < b.lt) &&
              (!b.lte || r.measuredAt <= b.lte),
          )
          .sort((a, c) => c.measuredAt.getTime() - a.measuredAt.getTime())[0] ??
        null
      );
    },
  );
}

async function readiness(
  now: Date,
  tz?: string,
  blendOnly?: boolean,
): Promise<ReadinessValue> {
  const result = await computeReadiness("u1", PROFILE, {
    now,
    ...(tz ? { tz } : {}),
    ...(blendOnly ? { blendOnly } : {}),
  });
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("not ok");
  return result.value;
}

beforeEach(() => {
  vi.clearAllMocks();
  storedRows = [];
  findMany.mockResolvedValue([]);
  findFirst.mockReset();
  findFirst.mockResolvedValue(null);
  moodFindMany.mockResolvedValue([]);
  resolveTz.mockResolvedValue("UTC");
});

describe("readiness freshness", () => {
  const NOW = new Date("2026-06-02T08:00:00Z");

  it("is fresh when every counted vital and the night are from today", async () => {
    seed({ lastDay: "2026-06-02", lastNight: "2026-06-02" });
    const value = await readiness(NOW, "UTC");
    const sleep = value.components.find((c) => c.key === "sleep");
    expect(sleep?.value).not.toBeNull();
    expect(value.fresh).toBe(true);
    expect(value.asOfDay).toBe("2026-06-02");
  });

  it("is not fresh when the vitals are from yesterday", async () => {
    seed({ lastDay: "2026-06-01", lastNight: "2026-06-02" });
    stored(74, "2026-06-01");
    const value = await readiness(NOW, "UTC");
    expect(value.fresh).toBe(false);
    expect(value.asOfDay).toBe("2026-06-01");
  });

  it("is not fresh when the sleep score describes another night", async () => {
    seed({ lastDay: "2026-06-02", lastNight: "2026-06-01" });
    stored(74, "2026-06-01");
    const value = await readiness(NOW, "UTC");
    expect(value.fresh).toBe(false);
    expect(value.asOfDay).toBe("2026-06-01");
  });

  it("names the value stored for that day, never today's mix", async () => {
    // Pulse and HRV from today, the night still yesterday's: the live blend
    // mixes two days. The line must carry what was computed for the day it
    // names, and moving vitals must not move it.
    seed({ lastDay: "2026-06-02", lastNight: "2026-06-01" });
    stored(74, "2026-06-01");
    const first = await readiness(NOW, "UTC");
    seed({ lastDay: "2026-06-02", lastNight: "2026-06-01", hrv: 30 });
    const second = await readiness(NOW, "UTC");
    for (const value of [first, second]) {
      expect(value.fresh).toBe(false);
      expect(value.score).toBe(74);
      expect(value.asOfDay).toBe("2026-06-01");
      expect(value.components.every((c) => c.value === null)).toBe(true);
    }
    const where = findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ type: "RECOVERY_SCORE", source: "COMPUTED" });
  });

  it("never names today: the early nightly row is passed over", async () => {
    // The nightly job runs before the morning's readings sync and stores a
    // blend of yesterday's values under today's wake day. "Last 81 on" with
    // today's date beside an empty ring is the line this must never show.
    seed({ lastDay: "2026-06-01", lastNight: "2026-06-01" });
    stored(77, "2026-06-01");
    stored(81, "2026-06-02", 4);
    const value = await readiness(NOW, "UTC");
    expect(value.fresh).toBe(false);
    expect(value.asOfDay).toBe("2026-06-01");
    expect(value.score).toBe(77);
  });

  it("keeps the stored line after noon when too few inputs remain", async () => {
    // At 13:00 yesterday's pulse, HRV and night have gone quiet and drop
    // out, leaving no input. The tile keeps "Last 77 on Jun 1" all day
    // instead of vanishing.
    seed({ lastDay: "2026-06-01", lastNight: "2026-06-01" });
    stored(77, "2026-06-01");
    stored(81, "2026-06-02", 4);
    const value = await readiness(new Date("2026-06-02T13:00:00Z"), "UTC");
    expect(value.fresh).toBe(false);
    expect(value.score).toBe(77);
    expect(value.asOfDay).toBe("2026-06-01");
    expect(value.components.every((c) => c.value === null)).toBe(true);
  });

  it("says nothing when no stored day exists to name", async () => {
    seed({ lastDay: "2026-06-02", lastNight: "2026-06-01" });
    const result = await computeReadiness("u1", PROFILE, {
      now: NOW,
      tz: "UTC",
    });
    expect(result.status).toBe("insufficient");
  });

  it("leaves a long-quiet night out instead of staying stale", async () => {
    // The sleep source went quiet ten days ago; pulse and HRV are today's.
    seed({ lastDay: "2026-06-02", lastNight: "2026-05-23" });
    stored(74, "2026-06-01");
    const value = await readiness(NOW, "UTC");
    expect(value.fresh).toBe(true);
    expect(value.asOfDay).toBe("2026-06-02");
    expect(value.components.find((c) => c.key === "sleep")?.value).toBeNull();
    expect(value.score).not.toBe(74);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("stops waiting for yesterday's night at local noon", async () => {
    seed({ lastDay: "2026-06-02", lastNight: "2026-06-01" });
    stored(74, "2026-06-01");
    expect(
      (await readiness(new Date("2026-06-02T11:59:00Z"), "UTC")).fresh,
    ).toBe(false);
    const afternoon = await readiness(new Date("2026-06-02T12:00:00Z"), "UTC");
    expect(afternoon.fresh).toBe(true);
    expect(
      afternoon.components.find((c) => c.key === "sleep")?.value,
    ).toBeNull();
  });

  it("gives the nightly job its own blend even when it is not fresh", async () => {
    seed({ lastDay: "2026-06-01", lastNight: "2026-06-01" });
    stored(20, "2026-06-01");
    const value = await readiness(NOW, "UTC", true);
    expect(value.fresh).toBe(false);
    expect(value.score).not.toBe(20);
    expect(value.components.some((c) => c.value !== null)).toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("measures today on the reader's clock, not the server's", async () => {
    // 13:00 UTC is already 01:00 the next morning in Auckland. Readings at
    // 10:00 UTC are today for a UTC reader and yesterday in Auckland.
    const now = new Date("2026-06-02T13:00:00Z");
    seed({ lastDay: "2026-06-02", lastNight: "2026-06-02", hourUtc: 10 });
    const utc = await readiness(now, "UTC");
    expect(utc.fresh).toBe(true);
    expect(utc.asOfDay).toBe("2026-06-02");

    stored(74, "2026-06-01"); // wakes on 06-02 in Auckland
    const auckland = await readiness(now, "Pacific/Auckland");
    expect(auckland.fresh).toBe(false);
    expect(auckland.asOfDay).toBe("2026-06-02");
  });

  it("reads the account's own zone when the caller names none", async () => {
    const now = new Date("2026-06-02T13:00:00Z");
    seed({ lastDay: "2026-06-02", lastNight: "2026-06-02", hourUtc: 10 });
    stored(74, "2026-06-01"); // wakes on 06-02 in Auckland
    resolveTz.mockResolvedValue("Pacific/Auckland");
    const value = await readiness(now);
    expect(value.fresh).toBe(false);
  });

  it("is carried on the wire the derived routes serve", async () => {
    const now = new Date("2026-06-02T13:00:00Z");
    seed({ lastDay: "2026-06-02", lastNight: "2026-06-02", hourUtc: 10 });
    stored(74, "2026-06-01"); // wakes on 06-02 in Auckland
    resolveTz.mockResolvedValue("Pacific/Auckland");
    const derived = await computeDerivedMetric({
      metric: "READINESS",
      userId: "u1",
      profile: PROFILE,
      now,
    });
    if (derived.status !== "ok") throw new Error("not ok");
    const value = derived.value as ReadinessValue;
    expect(value.fresh).toBe(false);
    expect(value.asOfDay).toBe("2026-06-02");
    // The published `ReadinessValue` is this object, field for field.
    expect(openApiComponents.schemas?.ReadinessValue).toBe(readinessValue);
    expect(readinessValue.safeParse(value).error?.issues ?? []).toEqual([]);
    expect(Object.keys(readinessValue.shape).sort()).toEqual(
      Object.keys(value).sort(),
    );

    resolveTz.mockResolvedValue("UTC");
    const utc = await computeDerivedMetric({
      metric: "READINESS",
      userId: "u1",
      profile: PROFILE,
      now,
    });
    if (utc.status !== "ok") throw new Error("not ok");
    expect((utc.value as ReadinessValue).fresh).toBe(true);
  });

  it("does not let mood alone make an old blend fresh", async () => {
    // Vitals and night from three days ago, mood logged today: the dated
    // inputs have gone quiet, and mood has no day the reader could check, so
    // it never vouches for today on its own. What is left is the stored
    // day, named as past.
    seed({ lastDay: "2026-05-30", lastNight: "2026-05-30" });
    stored(74, "2026-05-30");
    moodFindMany.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({
        score: 4,
        moodLoggedAt: new Date(NOW.getTime() - i * DAY_MS),
      })),
    );
    const value = await readiness(NOW, "UTC");
    expect(value.fresh).toBe(false);
    expect(value.score).toBe(74);
    expect(value.asOfDay).toBe("2026-05-30");
  });
});
