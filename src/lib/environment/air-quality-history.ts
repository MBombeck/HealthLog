/**
 * v1.42 — the air-quality history backfill: air quality, pollen and UV for
 * every past local day an account has entries on, not only from the day the
 * module was switched on.
 *
 * ## Which days
 *
 * Every local day (in the zone the module keys its rows on: the home's, else
 * the account's) with at least one measurement, mood entry, taken dose,
 * symptom or workout, from the first day the feed serves up to eight days
 * ago. The last week belongs to the nightly fetch, whose lookback already
 * covers it (`ENVIRONMENT_LOOKBACK_DAYS`). A day is placed:
 *
 *   - on its stored row's location when the day already has a weather row
 *     (only the air-quality part is fetched then, as the nightly gap fill
 *     does);
 *   - otherwise in the dated location period that covers it, else at the
 *     home, but the home only from `homeSince` on, by the same rule the
 *     nightly fetch places a day with (`resolveLocationForDay`). A home
 *     without a `homeSince` places no day at all, there as here. A day
 *     before the home was set is never placed there: the weather and air of
 *     a place the person was not at would be wrong data in the
 *     correlations, the Coach and the day view, and an empty day is honest
 *     where a wrong one is not. Such a day is filled only when a period
 *     covers it. A day without a row gets its weather row with the air
 *     quality, because the air quality is stored on it.
 *
 * A day inside a period whose sealed location does not open is skipped (fail
 * closed, as in the service), and so is a day with no place at all; neither
 * counts towards the progress, which counts only days that can be filled. A day the
 * source does not reach at its location (before 2013 in Europe, before August
 * 2022 elsewhere, `earliestAirQualityDay`) is neither fetched nor counted: it
 * stays without a value, which says nothing about the air, rather than
 * carrying a zero.
 *
 * ## Requests
 *
 * The pending days are grouped by coarse location (the stored or resolved
 * one, never finer: the same rounded coordinates the module always sends)
 * and cut into ranges of at most 90 days, joining two days into one range
 * when they lie at most 14 days apart. The feed weighs a request by days
 * over 14 (`openMeteoCallWeight`), so a lone day costs as much as two weeks:
 * joining short gaps is free, splitting long ones saves the gap. The newest
 * ranges go first, so the window the correlations read fills first. The
 * weather of a range is asked only over the span of its days without a row,
 * and before its air quality: a weather request the feed or the budget
 * refuses then costs no air-quality call, and when the air quality fails
 * after the weather came back, the weather rows are stored without it, so
 * the next run asks for the air quality alone and nothing paid is asked for
 * twice. A day the archive answer leaves out gets no row: it stays pending
 * rather than carrying an empty weather row that nothing would fill again.
 *
 * The first request the feed refuses (a 429, a 5xx, a network error) ends
 * the run with status `error` and no follow-up; the next nightly discovery
 * tries again. Before every range the run re-reads the module, the
 * account's air-quality switch and `ENVIRONMENT_AIR_QUALITY_DISABLED`, so
 * switching any of them off stops a run between two ranges.
 *
 * ## Budget
 *
 * Every request still passes the instance budget and the account's daily
 * share (`request-budget.ts`). On top of that the history holds itself to
 * {@link AIR_QUALITY_HISTORY_ACCOUNT_DAY_CALLS} of the account's 400 daily
 * calls and to half of each instance window, so the nightly fetch, the gap
 * fill and a backfill someone asked for keep their room. The ceiling is
 * checked in the budget's own locked transaction, together with the charge
 * ({@link AIR_QUALITY_HISTORY_CEILING}), so two worker processes, or the
 * history beside the nightly fetch, cannot both read room only one of them
 * gets. A run that reaches a
 * ceiling stops; the nightly discovery picks the account up again, so a long
 * history spreads over several days by construction.
 *
 * ## Idempotence and progress
 *
 * A day is done once its row carries `aqFetchedAt`; done days are never asked
 * for again, and the writes only touch rows still without it (or create the
 * row). The days with entries are read once per chain and handed from run
 * to run in the follow-up's payload ({@link EntryDaysSnapshot}), so a chain
 * of fifty runs scans the entry tables once, not fifty times. Each run
 * stores `{ total, done, checkedAt, complete }` on
 * `User.environmentAqHistoryJson`, which the settings card shows as
 * "Backfilling air quality: x of y days".
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma, toJson } from "@/lib/db";
import {
  earliestAirQualityDay,
  fetchDailyAirQuality,
  isAirQualityActive,
  uncoverableDay,
  AIR_QUALITY_CHUNK_DAYS,
  AIR_QUALITY_EARLIEST_DAY,
  type DailyAirQualityObservation,
} from "@/lib/environment/open-meteo-air-quality";
import {
  fetchDailyEnvironment,
  type DailyEnvironmentObservation,
} from "@/lib/environment/open-meteo";
import {
  OPEN_METEO_ACCOUNT_DAY_WINDOW,
  OpenMeteoBudgetExhaustedError,
  type BudgetCeiling,
} from "@/lib/environment/request-budget";
import { readLocation, sealLocation } from "@/lib/environment/location-cipher";
import {
  ENVIRONMENT_LOOKBACK_DAYS,
  HOME_SELECT,
  airQualityColumns,
  buildUpsert,
  inAnyPeriod,
  readTravelOverrides,
  resolveHome,
  resolveLocationForDay,
  utcDayKey,
  type ResolvedLocation,
} from "@/lib/environment/service";
import { isModuleEnabled } from "@/lib/modules/gate";
import { shiftDateKey } from "@/lib/tz/format";
import { startOfLocalDayKey } from "@/lib/tz/local-day";

/** Days before today the history stops at; the nightly lookback has the rest. */
export const AIR_QUALITY_HISTORY_SETTLE_DAYS = ENVIRONMENT_LOOKBACK_DAYS + 1;
/** Longest range one request covers (one feed chunk). */
export const AIR_QUALITY_HISTORY_RANGE_DAYS = AIR_QUALITY_CHUNK_DAYS;
/** Two days at most this far apart share a range (14 days weigh one call). */
export const AIR_QUALITY_HISTORY_JOIN_GAP_DAYS = 14;
/** Ranges one run works through before it hands over to its follow-up. */
export const AIR_QUALITY_HISTORY_RANGES_PER_RUN = 8;
/** The history's ceiling inside the account's 400 daily calls. */
export const AIR_QUALITY_HISTORY_ACCOUNT_DAY_CALLS = Math.floor(
  OPEN_METEO_ACCOUNT_DAY_WINDOW.limit * 0.75,
);
/** The history's share of each instance-wide window. */
export const AIR_QUALITY_HISTORY_INSTANCE_SHARE = 0.5;
/** Both ceilings, as every history request hands them to the budget. */
export const AIR_QUALITY_HISTORY_CEILING: BudgetCeiling = {
  instanceShare: AIR_QUALITY_HISTORY_INSTANCE_SHARE,
  accountDayCalls: AIR_QUALITY_HISTORY_ACCOUNT_DAY_CALLS,
};

/** One pending day and where it is fetched. */
export interface HistoryDay {
  date: string;
  location: ResolvedLocation;
  /** True when a weather row exists and only its air quality is missing. */
  hasRow: boolean;
}

/** A contiguous request range over a sorted set of pending days. */
export interface HistoryRange {
  startDate: string;
  endDate: string;
  days: string[];
}

/**
 * Cut sorted day keys into request ranges: a new range when the next day lies
 * more than `joinGapDays` after the previous one, or when the range would
 * grow past `maxRangeDays`. Pure; exported for tests.
 */
export function planHistoryRanges(
  days: readonly string[],
  opts: { joinGapDays?: number; maxRangeDays?: number } = {},
): HistoryRange[] {
  const joinGap = opts.joinGapDays ?? AIR_QUALITY_HISTORY_JOIN_GAP_DAYS;
  const maxRange = opts.maxRangeDays ?? AIR_QUALITY_HISTORY_RANGE_DAYS;
  const ranges: HistoryRange[] = [];
  for (const day of [...new Set(days)].sort()) {
    const current = ranges[ranges.length - 1];
    if (
      current &&
      shiftDateKey(current.endDate, joinGap) >= day &&
      shiftDateKey(current.startDate, maxRange - 1) >= day
    ) {
      current.endDate = day;
      current.days.push(day);
    } else {
      ranges.push({ startDate: day, endDate: day, days: [day] });
    }
  }
  return ranges;
}

/** The stored progress, as the settings card reads it. */
export interface AirQualityHistoryState {
  version: 1;
  /** Past days with entries the source can cover at their place. */
  total: number;
  /** Of those, the days whose air quality is stored. */
  done: number;
  /** ISO instant of the run that counted them. */
  checkedAt: string;
  /** True when nothing is left that the source can serve. */
  complete: boolean;
}

/** Tolerant read of the stored progress; null for anything malformed. */
export function readAirQualityHistoryState(
  raw: unknown,
): AirQualityHistoryState | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const count = (v: unknown) =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
  const total = count(r.total);
  const done = count(r.done);
  if (
    total === null ||
    done === null ||
    typeof r.checkedAt !== "string" ||
    typeof r.complete !== "boolean"
  ) {
    return null;
  }
  return {
    version: 1,
    total,
    done: Math.min(done, total),
    checkedAt: r.checkedAt,
    complete: r.complete,
  };
}

/**
 * The local days in `[fromKey, toKey]` with at least one entry: a reading, a
 * mood entry, a taken dose, a symptom or a workout. Distinct in SQL, so a
 * dense record costs a scan, not a transfer. `tz` is a zone the account
 * stored (home or profile), bound as a parameter.
 *
 * Measured on Postgres 16 with 4 000 days of readings: 4 000 rows answer in
 * about 5 ms, 400 000 rows (100 a day) in about 75 ms, almost all of it the
 * measurement scan and its hash aggregate (`EXPLAIN ANALYZE`: a parallel
 * sequential scan feeding a HashAggregate, 6.4 MB per worker). The cost
 * grows with the readings, not with the days, so it is read once per chain
 * and handed on ({@link EntryDaysSnapshot}), not once per run.
 */
export async function readEntryDays(
  userId: string,
  tz: string,
  fromKey: string,
  toKey: string,
): Promise<string[]> {
  // The instants of the first local day's start and the day after the last.
  const from = startOfLocalDayKey(fromKey, tz);
  const to = startOfLocalDayKey(shiftDateKey(toKey, 1), tz);
  const rows = await prisma.$queryRaw<Array<{ day: string }>>`
    SELECT day FROM (
      SELECT DISTINCT to_char(("measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day
      FROM "measurements"
      WHERE "user_id" = ${userId} AND "deleted_at" IS NULL
        AND "measured_at" >= ${from} AND "measured_at" < ${to}
      UNION
      SELECT "date" AS day FROM "mood_entries"
      WHERE "user_id" = ${userId} AND "deleted_at" IS NULL
        AND "date" >= ${fromKey} AND "date" <= ${toKey}
      UNION
      SELECT to_char(("taken_at" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day
      FROM "medication_intake_events"
      WHERE "user_id" = ${userId} AND "deleted_at" IS NULL
        AND "taken_at" >= ${from} AND "taken_at" < ${to}
      UNION
      SELECT to_char(("occurred_at" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day
      FROM "symptom_events"
      WHERE "user_id" = ${userId}
        AND "occurred_at" >= ${from} AND "occurred_at" < ${to}
      UNION
      SELECT to_char(("started_at" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day
      FROM "workouts"
      WHERE "user_id" = ${userId}
        AND "started_at" >= ${from} AND "started_at" < ${to}
    ) entry_days
  `;
  return rows
    .map((r) => r.day)
    .filter((d) => d >= fromKey && d <= toKey)
    .sort();
}

/**
 * The days with entries as one run read them, handed to the next run of the
 * same chain so the entry tables are scanned once per chain. Valid only for
 * the zone and the cutoff it was read under; a run under another one (the
 * home moved, or the chain crossed midnight) reads afresh.
 */
export interface EntryDaysSnapshot {
  timezone: string;
  cutoff: string;
  days: string[];
}

/** Tolerant read of a snapshot from a job payload; null for anything else. */
export function readEntryDaysSnapshot(raw: unknown): EntryDaysSnapshot | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.timezone !== "string" ||
    typeof r.cutoff !== "string" ||
    !Array.isArray(r.days) ||
    !r.days.every((d) => typeof d === "string")
  ) {
    return null;
  }
  return { timezone: r.timezone, cutoff: r.cutoff, days: r.days as string[] };
}

/** What the history still has to do for an account, and how far it is. */
export interface HistoryWork {
  pending: HistoryDay[];
  total: number;
  done: number;
  timezone: string;
  /** The entry days this collection used, for the chain's next run. */
  entryDays: EntryDaysSnapshot;
}

/**
 * Collect the pending days and the counts. Null when the account is gone or
 * its air quality is off (for the account or the instance). With `entryDays`
 * from the chain's previous run under the same zone and cutoff, the entry
 * tables are not read again.
 */
export async function collectAirQualityHistory(
  userId: string,
  now: Date = new Date(),
  entryDays: EntryDaysSnapshot | null = null,
): Promise<HistoryWork | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: HOME_SELECT,
  });
  if (!user || !isAirQualityActive(user.environmentAirQualityEnabled)) {
    return null;
  }
  const home = resolveHome(user);
  const travel = await readTravelOverrides(userId);
  const timezone = home?.timezone ?? user.timezone;
  const cutoff = shiftDateKey(utcDayKey(now), -AIR_QUALITY_HISTORY_SETTLE_DAYS);
  if (cutoff < AIR_QUALITY_EARLIEST_DAY) {
    return {
      pending: [],
      total: 0,
      done: 0,
      timezone,
      entryDays: { timezone, cutoff, days: [] },
    };
  }

  const reuse =
    entryDays !== null &&
    entryDays.timezone === timezone &&
    entryDays.cutoff === cutoff;
  const [days, rows] = await Promise.all([
    reuse
      ? entryDays.days
      : readEntryDays(userId, timezone, AIR_QUALITY_EARLIEST_DAY, cutoff),
    prisma.environmentContext.findMany({
      where: { userId, date: { gte: AIR_QUALITY_EARLIEST_DAY, lte: cutoff } },
      select: {
        date: true,
        aqFetchedAt: true,
        lat: true,
        lon: true,
        locationLabel: true,
        locationEncrypted: true,
        source: true,
      },
    }),
  ]);
  const rowByDate = new Map(rows.map((r) => [r.date, r]));

  const pending: HistoryDay[] = [];
  let total = 0;
  let done = 0;
  for (const date of days) {
    const row = rowByDate.get(date);
    let location: ResolvedLocation | null;
    if (row) {
      const stored = readLocation({
        sealed: row.locationEncrypted,
        lat: row.lat,
        lon: row.lon,
        label: row.locationLabel,
      });
      location = stored ? { ...stored, source: row.source } : null;
    } else if (inAnyPeriod(date, travel.unreadable)) {
      location = null;
    } else {
      location = resolveLocationForDay(date, home, travel.overrides);
    }
    if (!location) continue;
    // Outside what the source serves at this place: left empty, not counted.
    if (date < earliestAirQualityDay(location.lat, location.lon)) continue;
    total += 1;
    if (row?.aqFetchedAt) {
      done += 1;
    } else {
      pending.push({ date, location, hasRow: row != null });
    }
  }
  return {
    pending,
    total,
    done,
    timezone,
    entryDays: { timezone, cutoff, days },
  };
}

/**
 * Whether the history may still send for the account: the account exists,
 * its environment module is on, and its air quality is on for the account
 * and the instance. Read before every range, so switching any of them off
 * stops a run between two ranges, not only at the next run.
 */
async function historyStillActive(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { environmentAirQualityEnabled: true },
  });
  if (!user || !isAirQualityActive(user.environmentAirQualityEnabled)) {
    return false;
  }
  return isModuleEnabled(userId, "environment");
}

export interface AirQualityHistoryRunResult {
  /**
   * `inactive`: the account is gone, or its module or air quality is off
   * (at the start or between two ranges). `error`: the feed refused a
   * request, which ends the run and its chain.
   */
  status: "inactive" | "complete" | "progress" | "budget" | "error";
  /** Days whose air quality this run stored. */
  filled: number;
  /** Requests sent. */
  fetches: number;
  total: number;
  done: number;
  /** Days still pending after this run. */
  remaining: number;
  /** The entry days this run used, for its follow-up; null when inactive. */
  entryDays: EntryDaysSnapshot | null;
}

/**
 * One run of the history for an account: up to `maxRanges` ranges, newest
 * first, inside the history's budget ceilings. Stores the progress and says
 * why it stopped. `entryDays` is the previous run's snapshot in a chain.
 */
export async function runAirQualityHistory(
  userId: string,
  opts: {
    now?: Date;
    maxRanges?: number;
    entryDays?: EntryDaysSnapshot | null;
  } = {},
): Promise<AirQualityHistoryRunResult> {
  const now = opts.now ?? new Date();
  const maxRanges = opts.maxRanges ?? AIR_QUALITY_HISTORY_RANGES_PER_RUN;
  const work = await collectAirQualityHistory(
    userId,
    now,
    opts.entryDays ?? null,
  );
  if (!work) {
    return {
      status: "inactive",
      filled: 0,
      fetches: 0,
      total: 0,
      done: 0,
      remaining: 0,
      entryDays: null,
    };
  }

  // Group by the coarse coordinates the request carries, then plan ranges.
  const groups = new Map<
    string,
    { lat: number; lon: number; byDate: Map<string, HistoryDay> }
  >();
  for (const day of work.pending) {
    const key = `${day.location.lat},${day.location.lon}`;
    const group = groups.get(key) ?? {
      lat: day.location.lat,
      lon: day.location.lon,
      byDate: new Map(),
    };
    group.byDate.set(day.date, day);
    groups.set(key, group);
  }
  const planned = [...groups.values()]
    .flatMap((group) =>
      planHistoryRanges([...group.byDate.keys()]).map((range) => ({
        group,
        range,
      })),
    )
    .sort((a, b) => b.range.endDate.localeCompare(a.range.endDate));

  const budget = { accountId: userId, ceiling: AIR_QUALITY_HISTORY_CEILING };
  let filled = 0;
  let fetches = 0;
  let stop: "budget" | "error" | "inactive" | null = null;
  let attempted = 0;
  for (const { group, range } of planned) {
    if (attempted >= maxRanges) break;
    if (!(await historyStillActive(userId))) {
      stop = "inactive";
      break;
    }
    attempted += 1;
    const days = range.days.map((d) => group.byDate.get(d)!);
    const missing = days.filter((d) => !d.hasRow).map((d) => d.date);

    // The weather first, so a refused or failed archive request costs no
    // air-quality call.
    let weather: Map<string, DailyEnvironmentObservation> | null = null;
    if (missing.length > 0) {
      try {
        const observations = await fetchDailyEnvironment(
          {
            lat: group.lat,
            lon: group.lon,
            timezone: work.timezone,
            startDate: missing[0],
            endDate: missing[missing.length - 1],
          },
          budget,
        );
        fetches += 1;
        weather = new Map(observations.map((o) => [o.date, o]));
      } catch (err) {
        stop =
          err instanceof OpenMeteoBudgetExhaustedError ? "budget" : "error";
        if (stop === "error") fetches += 1;
        break;
      }
    }

    const air = await fetchDailyAirQuality(
      {
        lat: group.lat,
        lon: group.lon,
        timezone: work.timezone,
        startDate: range.startDate,
        endDate: range.endDate,
      },
      budget,
    );
    if (air.stopped !== "budget") fetches += 1;
    const airByDay = new Map<string, DailyAirQualityObservation>(
      air.days.map((d) => [d.date, d]),
    );
    // A day the feed did not answer after a full fetch is one it cannot
    // cover; after a stopped fetch it is simply not fetched yet.
    const airFor = (date: string): DailyAirQualityObservation | null =>
      airByDay.get(date) ??
      (air.stopped === null ? uncoverableDay(date) : null);

    const fetchedAt = new Date();
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    const fillsAir: boolean[] = [];
    for (const day of days) {
      const dayAir = airFor(day.date);
      if (day.hasRow) {
        if (!dayAir) continue;
        ops.push(
          prisma.environmentContext.updateMany({
            // Still unfetched, so a weather rewrite that landed meanwhile
            // (with its own air quality) is not overwritten.
            where: { userId, date: day.date, aqFetchedAt: null },
            data: airQualityColumns(dayAir, fetchedAt),
          }),
        );
        fillsAir.push(true);
        continue;
      }
      // A day the archive answer left out gets no row: it stays pending
      // instead of carrying empty weather nothing would fetch again.
      const observation = weather?.get(day.date);
      if (!observation) continue;
      // Without its air quality (the air request stopped), the weather row
      // is still stored: it was paid for, and the next run then asks for
      // the air quality alone.
      ops.push(
        buildUpsert(
          userId,
          day.location,
          sealLocation(day.location),
          observation,
          { active: true, day: dayAir, now: fetchedAt },
        ),
      );
      fillsAir.push(dayAir !== null);
    }
    if (ops.length > 0) {
      const results = await prisma.$transaction(ops);
      results.forEach((r, i) => {
        if (!fillsAir[i]) return;
        filled +=
          r && typeof r === "object" && "count" in r
            ? Number((r as { count: number }).count)
            : 1;
      });
    }
    if (air.stopped) {
      stop = air.stopped;
      break;
    }
  }

  const done = Math.min(work.total, work.done + filled);
  const remaining = work.total - done;
  const state: AirQualityHistoryState = {
    version: 1,
    total: work.total,
    done,
    checkedAt: now.toISOString(),
    complete: remaining === 0,
  };
  await prisma.user.update({
    where: { id: userId },
    data: { environmentAqHistoryJson: toJson(state) },
  });

  const status: AirQualityHistoryRunResult["status"] =
    remaining === 0 ? "complete" : (stop ?? "progress");
  return {
    status,
    filled,
    fetches,
    total: work.total,
    done,
    remaining,
    entryDays: work.entryDays,
  };
}
