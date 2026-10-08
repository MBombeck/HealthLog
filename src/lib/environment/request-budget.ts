/**
 * The instance-wide Open-Meteo request budget (v1.42, #615).
 *
 * The hosted Open-Meteo APIs are free for non-commercial use within 600 calls
 * a minute, 5 000 an hour and 10 000 a day, counted per client address, so
 * per instance. A "call" is weighted: a request for more than 10 variables
 * or more than two weeks counts as several, `max(1, variables / 10) ×
 * max(1, days / 14)` (open-meteo.com/en/pricing). One account's full
 * backfill of weather and air quality is around 150 calls; a large instance
 * filling hundreds of accounts in one night would run into the daily limit
 * and every request after it would fail.
 *
 * So every request to the archive, the geocoder and the air-quality API asks
 * this budget first, with its weight, and is not sent when the budget says
 * no. The limits sit below the free ones (500 / 4 000 / 8 000) to leave room
 * for clock skew between our windows and theirs. A refused request is not an
 * error: the nightly job stops, reports `budget_blocked`, and the next night
 * continues where it stopped, because what is missing is exactly what the
 * gap fill looks for.
 *
 * The counter lives in Postgres (`rate_limits`, the table every rate limit
 * here uses), so the web process and the worker share it, and the three
 * windows are checked and charged together under one advisory lock: a
 * request is admitted only when all three have room, and then charged to
 * all three. Weights are stored in hundredths of a call, because the column
 * is an integer and a 90-day air-quality chunk weighs about 10.9 calls.
 *
 * An operator running their own Open-Meteo instance (`OPENMETEO_*_URL`) is
 * not bound by the hosted limits, but the budget still applies: it is cheap,
 * and it keeps a misconfigured instance from being hammered.
 */
import { prisma } from "@/lib/db";

/** One budget window. */
export interface BudgetWindow {
  /** Bucket key suffix, also the window's name. */
  name: "minute" | "hour" | "day" | "account-day";
  windowMs: number;
  /** Calls admitted per window (whole calls). */
  limit: number;
}

export const OPEN_METEO_BUDGET_WINDOWS: readonly BudgetWindow[] = [
  { name: "minute", windowMs: 60_000, limit: 500 },
  { name: "hour", windowMs: 3_600_000, limit: 4_000 },
  { name: "day", windowMs: 86_400_000, limit: 8_000 },
];

/**
 * The share of the daily budget one account may use. The instance-wide
 * windows alone let a single account drain the day for everyone (repeated
 * backfills of a two-year range), so a request made for an account is also
 * charged to that account's own daily bucket. One twentieth of the day is
 * 400 calls: more than two full backfills of weather and air quality, and
 * still leaves the rest of the day for nineteen other accounts.
 */
export const OPEN_METEO_ACCOUNT_DAY_SHARE = 0.05;

const DAY_LIMIT =
  OPEN_METEO_BUDGET_WINDOWS.find((w) => w.name === "day")?.limit ?? 0;

/** The per-account daily window, charged only when a request names an account. */
export const OPEN_METEO_ACCOUNT_DAY_WINDOW: BudgetWindow = {
  name: "account-day",
  windowMs: 86_400_000,
  limit: Math.floor(DAY_LIMIT * OPEN_METEO_ACCOUNT_DAY_SHARE),
};

const BUCKET_PREFIX = "open-meteo-budget";
const LOCK_KEY = "open-meteo-budget";

/** Hundredths of a call: the unit the buckets count in. */
const CENTI = 100;

/**
 * The weight of one request in calls, by the hosted pricing rule: more than
 * 10 variables or more than 14 days counts proportionally more.
 */
export function openMeteoCallWeight(variables: number, days: number): number {
  return Math.max(1, variables / 10) * Math.max(1, days / 14);
}

/** A bucket as stored: count in hundredths, and when its window resets. */
export interface BudgetBucket {
  count: number;
  resetAt: Date;
}

/**
 * Pure admission decision: given the stored buckets (keyed by window name,
 * absent when never written), whether `weightCenti` fits in every window, and
 * the buckets as they must be written when it does. An expired bucket starts
 * over at the request's weight. Exported for tests.
 */
export function admitWeight(
  buckets: ReadonlyMap<BudgetWindow["name"], BudgetBucket>,
  weightCenti: number,
  now: Date,
  windows: readonly BudgetWindow[] = OPEN_METEO_BUDGET_WINDOWS,
):
  | { admitted: true; next: Map<BudgetWindow["name"], BudgetBucket> }
  | { admitted: false; window: BudgetWindow["name"] } {
  const next = new Map<BudgetWindow["name"], BudgetBucket>();
  for (const w of windows) {
    const current = buckets.get(w.name);
    const live = current && current.resetAt.getTime() > now.getTime();
    const count = (live ? current.count : 0) + weightCenti;
    if (count > w.limit * CENTI) return { admitted: false, window: w.name };
    next.set(w.name, {
      count,
      resetAt: live ? current.resetAt : new Date(now.getTime() + w.windowMs),
    });
  }
  return { admitted: true, next };
}

/**
 * Ask the budget for one request of `weight` calls. Returns true and charges
 * every window when it fits, false (charging nothing) when any window is
 * full. With `accountId`, the account's own daily share is checked and
 * charged as well (`OPEN_METEO_ACCOUNT_DAY_SHARE`); requests made for no
 * particular account (the geocoder) are bound by the instance windows only.
 */
export async function reserveOpenMeteoCalls(
  weight: number,
  accountId?: string,
): Promise<boolean> {
  const weightCenti = Math.max(1, Math.ceil(weight * CENTI));
  const windows: readonly BudgetWindow[] = accountId
    ? [...OPEN_METEO_BUDGET_WINDOWS, OPEN_METEO_ACCOUNT_DAY_WINDOW]
    : OPEN_METEO_BUDGET_WINDOWS;
  const keyOf = (name: BudgetWindow["name"]) =>
    name === "account-day"
      ? `${BUCKET_PREFIX}:account:${accountId}:day`
      : `${BUCKET_PREFIX}:${name}`;
  const nameOfKey = new Map(windows.map((w) => [keyOf(w.name), w.name]));
  return prisma.$transaction(async (tx) => {
    // `pg_advisory_xact_lock` returns void, which the client cannot
    // deserialize as a column; selecting FROM it yields a plain row.
    await tx.$queryRaw`
      SELECT 1 AS locked
      FROM pg_advisory_xact_lock(hashtextextended(${LOCK_KEY}, 0))
    `;
    const rows = await tx.rateLimit.findMany({
      where: { key: { in: [...nameOfKey.keys()] } },
      select: { key: true, count: true, resetAt: true },
    });
    const buckets = new Map<BudgetWindow["name"], BudgetBucket>();
    for (const row of rows) {
      const name = nameOfKey.get(row.key);
      if (name) buckets.set(name, { count: row.count, resetAt: row.resetAt });
    }
    const decision = admitWeight(buckets, weightCenti, new Date(), windows);
    if (!decision.admitted) return false;
    for (const [name, bucket] of decision.next) {
      const key = keyOf(name);
      await tx.rateLimit.upsert({
        where: { key },
        create: { key, count: bucket.count, resetAt: bucket.resetAt },
        update: { count: bucket.count, resetAt: bucket.resetAt },
      });
    }
    return true;
  });
}

/** Thrown by a client whose request the budget refused. Not a failure. */
export class OpenMeteoBudgetExhaustedError extends Error {
  constructor() {
    super("open-meteo request budget exhausted");
    this.name = "OpenMeteoBudgetExhaustedError";
  }
}
