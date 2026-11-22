/**
 * v1.34.0 — the intraday shape of a cumulative day, kept before the fold
 * destroys it.
 *
 * A cumulative metric has no meaningful "latest reading": four thousand steps
 * is a good day at 09:00 and a poor one at 22:00, and `signals-of-day` excludes
 * steps for exactly that reason. The only honest comparison is against the same
 * person's own typical total AT THE SAME LOCAL HOUR — and that needs an hourly
 * substrate, which did not exist. `drainPerSampleCumulative` collapses the
 * per-sample Apple Health rows into one daily total after the 36-hour grace
 * window and hard-deletes the originals in the same transaction; Fitbit,
 * Withings and Polar write daily totals directly and never had an intraday
 * stream at all.
 *
 * This module owns that substrate, in three parts:
 *
 *   1. `foldHourlyCumulative` — the PURE fold. Per-sample rows for one local
 *      day become 24 running totals, element `h` carrying everything
 *      accumulated through the END of local hour `h`. No IO, so the drain and
 *      the live read share one definition of what a day's shape is.
 *   2. `mergeIntradayCumulativeProfile` — the write the drain calls INSIDE its
 *      own transaction, immediately before the delete. Keyed on
 *      `(userId, type, dateKey)` and additive, so a day drained twice keeps
 *      both halves.
 *   3. `readCumulativeDayProfiles` — the trailing-window read the same-time
 *      baseline issues. Persisted rows for the drained days, a live fold for
 *      the days still inside the grace window (which have no row yet), so the
 *      current day is always available.
 *
 * The table is a SIDECAR. The canonical `stats:<HKType>:<day>` measurement
 * stays the reading of record; nothing here is a measurement, and no read path
 * takes a value off this table that the measurement rows do not already carry.
 */
import type {
  MeasurementType,
  Prisma,
  PrismaClient,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";

import { hourOfDayForUserTz, type PerSampleRow } from "./consolidation-tz";
import { readLocalDayMinuteBuckets } from "./dense-bucket-read";

/** Hours in a stored profile. Always 24, DST days included — see below. */
export const PROFILE_HOURS = 24;

/**
 * How long a stored profile survives.
 *
 * The baseline only ever reads a trailing month, so this is not a data
 * requirement — it is the bound that keeps a sidecar from growing forever. A
 * year and a bit lets a same-time comparison one day reach across a full
 * seasonal cycle without the table ever becoming something an operator has to
 * think about: at ~200 bytes a row and four supported types, a decade of one
 * account is still under a megabyte.
 */
export const CUMULATIVE_PROFILE_RETENTION_DAYS = 400;

/**
 * How far back a MISSING profile is folded live from raw rows.
 *
 * Days inside the drain's 36-hour grace window still hold their per-sample
 * rows and have no persisted profile yet, so the reader folds them on demand —
 * otherwise today and yesterday would be permanently invisible to a feature
 * whose whole subject is today. Two days covers the 36-hour window plus the
 * gap until the next nightly tick.
 *
 * It is deliberately NOT larger. Folding an arbitrary historical day live
 * would mean an unbounded per-sample read on an account that has never been
 * drained, on a request path — and on a drained account it would find nothing
 * anyway, because the rows are gone. A day older than this with no profile is
 * simply absent, which is the truth.
 */
export const CUMULATIVE_PROFILE_LIVE_FOLD_DAYS = 2;

/** Prefix marking an already-collapsed daily-stats row. */
const DAILY_STATS_PREFIX = "stats:";

/** One local day's cumulative shape, as the pure fold produces it. */
export interface CumulativeDayFold {
  /** Local calendar day (`YYYY-MM-DD`) in `timezone`. */
  dateKey: string;
  /** IANA zone the day was cut on. */
  timezone: string;
  /**
   * 24 running totals — element `h` is everything accumulated from local
   * midnight through the END of local hour `h`. Non-decreasing by
   * construction; `[23]` equals `dayTotal`.
   */
  hourlyCumulative: number[];
  /** The day's total. */
  dayTotal: number;
  /** Raw per-sample rows that backed the fold. */
  sampleCount: number;
}

/** A day profile as a reader resolved it, tagged with where it came from. */
export interface CumulativeDayProfile extends CumulativeDayFold {
  /** Whether this came off the table or was folded live from raw rows. */
  origin: "stored" | "live";
  /**
   * v1.43 (ios #77) — what the running totals were built from: the fold of
   * single samples, or the hours the phone posted (`intraday-hour-buckets`).
   * `sampleCount` is the number of posted hours for the latter.
   */
  basis: "PER_SAMPLE" | "HOUR_BUCKETS";
  /** Posted hours behind the day; null for a fold of single samples. */
  bucketCount: number | null;
}

/**
 * Fold one local day's per-sample rows into 24 running totals.
 *
 * Pure. Rows already collapsed into a `stats:` daily total are skipped — a
 * day-sum row would dump the whole day into a single hour and invent a shape
 * that never happened, the same trap `loadIntradayPulse` documents at its own
 * step-bucket loop. Rows that fall outside `dateKey` are skipped too, so a
 * caller may hand over a padded window without corrupting the day.
 *
 * DST costs nothing here. A fall-back day's repeated local hour folds into its
 * one slot, and a spring-forward day's skipped hour simply repeats its
 * predecessor's running total. Every stored day therefore has exactly 24 slots
 * and is index-comparable with every other, which is the only property the
 * same-hour comparison actually needs.
 *
 * Returns `null` when the day carried no usable per-sample row — an honest
 * absence, never a zero-filled profile. A day with genuinely zero steps that
 * WAS sampled comes back as a real profile of zeros; a day nobody measured
 * comes back as nothing, and the two must not be confused.
 */
export function foldHourlyCumulative(
  rows: readonly PerSampleRow[],
  dateKey: string,
  timezone: string,
): CumulativeDayFold | null {
  const perHour = new Array<number>(PROFILE_HOURS).fill(0);
  let sampleCount = 0;

  for (const row of rows) {
    if (row.externalId?.startsWith(DAILY_STATS_PREFIX)) continue;
    if (userDayKey(row.measuredAt, timezone) !== dateKey) continue;
    const hour = hourOfDayForUserTz(row.measuredAt, timezone);
    if (hour < 0 || hour >= PROFILE_HOURS) continue;
    perHour[hour] += row.value;
    sampleCount += 1;
  }

  return cumulativeFoldFromHourSums(perHour, sampleCount, dateKey, timezone);
}

/**
 * The running totals of a day whose readings are already summed per local
 * hour (`perHour[h]` the sum of hour `h`), as the live fold reads them from
 * Postgres. `null` when no reading backed the day, as for the row fold.
 */
function cumulativeFoldFromHourSums(
  perHour: readonly number[],
  sampleCount: number,
  dateKey: string,
  timezone: string,
): CumulativeDayFold | null {
  if (sampleCount === 0) return null;

  const hourlyCumulative = new Array<number>(PROFILE_HOURS);
  let running = 0;
  for (let h = 0; h < PROFILE_HOURS; h += 1) {
    running += perHour[h];
    hourlyCumulative[h] = running;
  }

  return {
    dateKey,
    timezone,
    hourlyCumulative,
    dayTotal: running,
    sampleCount,
  };
}

/**
 * Add one fold onto the stored profile for its day, inside the caller's
 * transaction.
 *
 * The drain calls this immediately before deleting the rows the fold came
 * from, so the shape is committed by the same commit that destroys its source
 * — there is no window in which the samples are gone and the shape was never
 * written.
 *
 * The merge is ADDITIVE, and it has to be. The drain deletes what it folds, so
 * it only ever hands over rows nobody folded before: a day drained at the grace
 * cutoff and then drained again a week later after a late watch sync would lose
 * its first eleven hours under last-write-wins. Element-wise addition of two
 * running totals is exactly the running total of the union, because a cumulative
 * sum is linear — so the merged curve is the same one a single fold over all the
 * rows would have produced.
 *
 * The caller must serialise its own reads and writes for the day; the cumulative
 * drain does, under the per-bucket advisory lock it already takes. And the
 * caller must pass only rows still LIVE at merge time: a re-run or the
 * serialised loser of two overlapping ticks sees none, folds nothing, and never
 * reaches here.
 *
 * A stored profile cut on a different timezone is replaced rather than added
 * to. After a move the old curve's hours mean something else, and summing the
 * two would produce a shape that describes no day that ever happened.
 */
export async function mergeIntradayCumulativeProfile(
  tx: Prisma.TransactionClient,
  args: {
    userId: string;
    type: MeasurementType;
    increment: CumulativeDayFold;
  },
): Promise<void> {
  const { userId, type, increment } = args;
  const key = { userId, type, dateKey: increment.dateKey };

  const existing = await tx.intradayCumulativeProfile.findUnique({
    where: { userId_type_dateKey: key },
    select: {
      hourlyCumulative: true,
      sampleCount: true,
      timezone: true,
      basis: true,
    },
  });

  // v1.43 (ios #77) — a day built from the hours the phone posted keeps that
  // shape: the posted hours already account for every sample, so adding a
  // fold of the same samples would count the day twice. The fold is dropped,
  // exactly as the samples it came from are about to be.
  if (
    existing !== null &&
    existing.basis === "HOUR_BUCKETS" &&
    existing.timezone === increment.timezone
  ) {
    return;
  }

  const reusable =
    existing !== null &&
    existing.timezone === increment.timezone &&
    existing.hourlyCumulative.length === PROFILE_HOURS;

  const hourlyCumulative = reusable
    ? increment.hourlyCumulative.map((v, h) => v + existing.hourlyCumulative[h])
    : increment.hourlyCumulative;
  const sampleCount = reusable
    ? existing.sampleCount + increment.sampleCount
    : increment.sampleCount;

  const data = {
    hourlyCumulative,
    dayTotal: hourlyCumulative[PROFILE_HOURS - 1],
    sampleCount,
    timezone: increment.timezone,
    // A profile cut on another clock is replaced whole, its posted hours
    // included (`basis` stays the default for a day under the threshold).
    ...(existing !== null && existing.timezone !== increment.timezone
      ? { hourlyIncrements: [], bucketCount: null, basis: "PER_SAMPLE" }
      : {}),
  };

  await tx.intradayCumulativeProfile.upsert({
    where: { userId_type_dateKey: key },
    create: { ...key, ...data },
    update: data,
  });
}

/**
 * Drop profiles older than the retention bound, across every account.
 *
 * `dateKey` is a zero-padded `YYYY-MM-DD` string, so the lexicographic
 * comparison IS the chronological one and the delete is an index range scan.
 * The cutoff is computed in UTC: it is 400 days back, and no timezone on earth
 * moves that boundary by more than a day.
 */
export async function pruneIntradayCumulativeProfiles(
  prismaClient: PrismaClient,
  now: Date = new Date(),
  retentionDays: number = CUMULATIVE_PROFILE_RETENTION_DAYS,
): Promise<number> {
  const cutoffKey = shiftDateKey(
    // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: 400-day retention cutoff; no zone moves it by more than a day (see the doc comment)
    now.toISOString().slice(0, 10),
    -retentionDays,
  );
  const { count } = await prismaClient.intradayCumulativeProfile.deleteMany({
    where: { dateKey: { lt: cutoffKey } },
  });
  return count;
}

/**
 * Read a trailing window of day profiles, newest day first.
 *
 * Stored rows answer the drained days. The days still inside the grace window
 * hold no stored row yet, so each is folded live from its raw per-sample rows —
 * bounded to `CUMULATIVE_PROFILE_LIVE_FOLD_DAYS`, each day summed per hour in
 * Postgres. A day that yields neither is absent from the result; the caller
 * counts what it got rather than assuming a length.
 *
 * Profiles cut on a different timezone than the account's current one are
 * dropped. After a move, "by 21:00" means a different moment than it did
 * before, and averaging the two would quietly compare unlike hours.
 */
export async function readCumulativeDayProfiles(args: {
  userId: string;
  type: MeasurementType;
  timezone: string;
  /** Inclusive newest local day to consider (usually the caller's today). */
  endDateKey: string;
  /** How many days back from `endDateKey`, inclusive of it. */
  windowDays: number;
  prismaClient?: PrismaClient;
}): Promise<CumulativeDayProfile[]> {
  const { userId, type, timezone, endDateKey, windowDays } = args;
  const db = args.prismaClient ?? prisma;
  const startDateKey = shiftDateKey(endDateKey, -(windowDays - 1));

  const stored = await db.intradayCumulativeProfile.findMany({
    where: {
      userId,
      type,
      dateKey: { gte: startDateKey, lte: endDateKey },
    },
    orderBy: { dateKey: "desc" },
    select: {
      dateKey: true,
      timezone: true,
      hourlyCumulative: true,
      dayTotal: true,
      sampleCount: true,
      basis: true,
      bucketCount: true,
    },
  });

  const byDay = new Map<string, CumulativeDayProfile>();
  for (const row of stored) {
    // A day cut on another clock is not comparable — drop it rather than
    // silently mix two meanings of "by 21:00".
    if (row.timezone !== timezone) continue;
    if (row.hourlyCumulative.length !== PROFILE_HOURS) continue;
    byDay.set(row.dateKey, {
      dateKey: row.dateKey,
      timezone: row.timezone,
      hourlyCumulative: row.hourlyCumulative,
      dayTotal: row.dayTotal,
      sampleCount: row.sampleCount,
      origin: "stored",
      basis: row.basis === "HOUR_BUCKETS" ? "HOUR_BUCKETS" : "PER_SAMPLE",
      bucketCount: row.bucketCount,
    });
  }

  // The recent days the drain has not reached yet. Folded live, newest first,
  // and only for days actually inside the requested window.
  for (let back = 0; back < CUMULATIVE_PROFILE_LIVE_FOLD_DAYS; back += 1) {
    const dateKey = shiftDateKey(endDateKey, -back);
    if (dateKey < startDateKey) break;
    if (byDay.has(dateKey)) continue;
    const folded = await foldLiveDay(db, userId, type, dateKey, timezone);
    if (folded) {
      byDay.set(dateKey, {
        ...folded,
        origin: "live",
        basis: "PER_SAMPLE",
        bucketCount: null,
      });
    }
  }

  return [...byDay.values()].sort((a, b) => (a.dateKey < b.dateKey ? 1 : -1));
}

/**
 * Fold one local day straight from its live per-sample rows, summed per local
 * hour in Postgres (`readLocalDayMinuteBuckets`), so the database returns at
 * most 24 rows however dense the stream. It used to read the rows under a
 * 5 000-row cap and fold them here; a watch writing active energy every few
 * seconds ran past the cap by mid-afternoon and the rest of the day was
 * missing from the curve with nothing to say so. Scoped to the exact
 * local-day window (DST-aware, 23/24/25 h); `stats:` rows are skipped as the
 * row fold skips them.
 */
async function foldLiveDay(
  db: PrismaClient,
  userId: string,
  type: MeasurementType,
  dateKey: string,
  timezone: string,
): Promise<CumulativeDayFold | null> {
  const buckets = await readLocalDayMinuteBuckets({
    userId,
    type,
    dateKey,
    timeZone: timezone,
    bucketMinutes: 60,
    db,
  });
  const perHour = new Array<number>(PROFILE_HOURS).fill(0);
  let sampleCount = 0;
  for (const b of buckets) {
    const hour = b.startMinute / 60;
    if (hour < 0 || hour >= PROFILE_HOURS) continue;
    perHour[hour] += b.sum;
    sampleCount += b.n;
  }
  return cumulativeFoldFromHourSums(perHour, sampleCount, dateKey, timezone);
}
