/**
 * The day view's comparison history is read once per record, zone, ladder
 * and readable type set, and each day takes its own slice of it.
 *
 * Paging from one day to the next used to read the same two years again.
 * The slice has to give exactly what a live read of the window would: the
 * extremes depend on where the series starts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readLocalDailyStats = vi.fn();
vi.mock("@/lib/day/daily-stats", () => ({
  readLocalDailyStats: (...a: unknown[]) => readLocalDailyStats(...a),
}));
vi.mock("@/lib/db", () => ({
  prisma: { $queryRaw: vi.fn(async () => []) },
}));

import type { MeasurementType } from "@/generated/prisma/enums";
import { __resetAllCachesForTests, caches } from "@/lib/cache/server-cache";
import { daysBetweenDateKeys, shiftDateKey, userDayKey } from "@/lib/tz/format";

import {
  NOTABLE_LOOKBACK_DAYS,
  extremesInSeries,
  loadNotableRange,
} from "../notable";

const TZ = "Europe/Berlin";
const TODAY = userDayKey(new Date(), TZ);
const SPIKE = shiftDateKey(TODAY, -20);
const FIRST = shiftDateKey(TODAY, -900);

/** Systolic 120 every day from FIRST to TODAY, 150 on SPIKE. */
function value(day: string): number {
  return day === SPIKE ? 150 : 120;
}

beforeEach(() => {
  __resetAllCachesForTests();
  readLocalDailyStats.mockReset();
  readLocalDailyStats.mockImplementation(
    async (args: { types: MeasurementType[]; from: Date; to: Date }) => {
      const days = new Map<string, number>();
      const end = userDayKey(args.to, TZ);
      for (
        let day = userDayKey(args.from, TZ);
        day < end;
        day = shiftDateKey(day, 1)
      ) {
        if (day >= FIRST && day <= TODAY) days.set(day, value(day));
      }
      return new Map(
        args.types
          .filter((t) => t === "BLOOD_PRESSURE_SYS")
          .map((t) => [t, days]),
      );
    },
  );
});

function load(day: string, extra: { floor?: Date } = {}) {
  return loadNotableRange({
    userId: "user-1",
    from: day,
    to: day,
    tz: TZ,
    priorityJson: null,
    typeVisible: (t) => t !== "BLOOD_GLUCOSE",
    gaps: false,
    extremeTypes: ["BLOOD_PRESSURE_SYS"],
    firstValueTypes: [],
    ...extra,
  });
}

/** The block a day falls in, as the cache counts them. */
function blockOf(day: string): number {
  return Math.floor(daysBetweenDateKeys("1970-01-01", day) / 90);
}

/** What a live read of the window gives. */
function expected(day: string) {
  const series: Array<[string, number]> = [];
  for (
    let d = shiftDateKey(day, -NOTABLE_LOOKBACK_DAYS);
    d <= day;
    d = shiftDateKey(d, 1)
  ) {
    if (d >= FIRST) series.push([d, value(d)]);
  }
  return extremesInSeries("BLOOD_PRESSURE_SYS", series, day);
}

describe("notable history cache", () => {
  it("reads the history once while paging through neighbouring days", async () => {
    const spike = await load(SPIKE);
    const before = await load(shiftDateKey(SPIKE, -1));
    const after = await load(shiftDateKey(SPIKE, 1));

    // One read for the spike's window. The day before reaches one day further
    // back and reads again only when that day opens an earlier block; the day
    // after reaches one day further forward and reads again only when that day
    // opens a later block. Where the boundaries fall depends on the date the
    // suite runs, so the count is worked out from the blocks, not assumed.
    const reachesBack =
      blockOf(shiftDateKey(SPIKE, -1 - NOTABLE_LOOKBACK_DAYS)) !==
      blockOf(shiftDateKey(SPIKE, -NOTABLE_LOOKBACK_DAYS));
    const reachesForward = blockOf(shiftDateKey(SPIKE, 1)) !== blockOf(SPIKE);
    expect(readLocalDailyStats).toHaveBeenCalledTimes(
      1 + Number(reachesBack) + Number(reachesForward),
    );
    expect(spike).toEqual(expected(SPIKE));
    expect(spike.map((n) => n.kind)).toEqual(["extremeHigh"]);
    expect(before).toEqual(expected(shiftDateKey(SPIKE, -1)));
    expect(after).toEqual(expected(shiftDateKey(SPIKE, 1)));
  });

  it("never reads a type the modules switch off", async () => {
    await load(SPIKE);
    const [args] = readLocalDailyStats.mock.calls[0] as [
      { types: MeasurementType[] },
    ];
    expect(args.types).not.toContain("BLOOD_GLUCOSE");
    expect(args.types).toContain("BLOOD_PRESSURE_SYS");
  });

  it("reads live from a lookback floor inside the window", async () => {
    const floor = new Date(Date.now() - 60 * 86_400_000);
    await load(SPIKE, { floor });
    await load(SPIKE, { floor });

    expect(readLocalDailyStats).toHaveBeenCalledTimes(2);
    const [args] = readLocalDailyStats.mock.calls[0] as [{ from: Date }];
    expect(args.from).toEqual(floor);
  });
});

describe("a write while the history is being read", () => {
  it("is not hidden by the read that started before it", async () => {
    // The first read is held until a write lands and invalidates the
    // account's analytics entries, as `invalidateUserMeasurements` does.
    const real = readLocalDailyStats.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    readLocalDailyStats.mockImplementationOnce(async (args) => {
      const before = await real(args);
      await held;
      return before;
    });
    const stale = load(SPIKE);
    await new Promise((r) => setTimeout(r, 0));
    // The write lowers the spike, then evicts.
    const original = real;
    readLocalDailyStats.mockImplementation(async (args) => {
      const stats = (await original(args)) as Map<string, Map<string, number>>;
      stats.get("BLOOD_PRESSURE_SYS")?.set(SPIKE, 120);
      return stats;
    });
    caches.analytics.deleteByPrefix("user-1|");
    release();
    // The read already under way answers with what it saw.
    expect((await stale).map((n) => n.kind)).toEqual(["extremeHigh"]);
    // The next one reads again and sees the write.
    expect(await load(SPIKE)).toEqual([]);
  });

  it("joins a read of the same block already under way", async () => {
    await Promise.all([load(SPIKE), load(SPIKE)]);
    // One read of the missing span, shared by both.
    expect(readLocalDailyStats).toHaveBeenCalledTimes(1);
  });
});

describe("notable history cache size", () => {
  const cached: number[] = [];
  beforeEach(() => {
    cached.length = 0;
    const set = caches.analytics.set.bind(caches.analytics);
    vi.spyOn(caches.analytics, "set").mockImplementation((key, value, ttl) => {
      if (key.includes("|notable-history|")) {
        let days = 0;
        for (const series of (
          value as Map<string, Map<string, number>>
        ).values()) {
          days = Math.max(days, series.size);
        }
        cached.push(days);
      }
      set(key, value, ttl);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("holds a block of days per cell, and paging back a year adds a block per quarter", async () => {
    for (let back = 0; back < 365; back += 1) {
      const day = shiftDateKey(TODAY, -back);
      expect(await load(day)).toEqual(expected(day));
    }
    // Two years of history plus the year paged through, in 90-day blocks,
    // each cached once: about thirteen cells, never one per day.
    const blocks =
      blockOf(TODAY) -
      blockOf(shiftDateKey(TODAY, -364 - NOTABLE_LOOKBACK_DAYS)) +
      1;
    expect(cached.length).toBe(blocks);
    expect(Math.max(...cached)).toBeLessThanOrEqual(90);
    expect(readLocalDailyStats.mock.calls.length).toBeLessThanOrEqual(blocks);
  });

  it("reads a cold day long ago up to that day's block, not up to today", async () => {
    const day = shiftDateKey(TODAY, -700);
    expect(await load(day)).toEqual(expected(day));
    const [args] = readLocalDailyStats.mock.calls[0] as [{ to: Date }];
    expect(userDayKey(args.to, TZ) <= shiftDateKey(day, 91)).toBe(true);
  });
});
