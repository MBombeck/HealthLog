/**
 * The low-percentile resting-pulse proxy, folded in Postgres.
 *
 * `deriveRestingProxyFromPulse` takes every raw `PULSE` sample of a window
 * and reduces each local day to its 20th percentile. On a watch that records
 * heart rate once a minute, a 90-day window is 130 000 samples: reading them
 * as objects, keying each one to its local day and sorting each day held the
 * event loop for over a second per request, and the route that did it runs on
 * every insights page view. The reduction needs only the day's percentile,
 * its sample count and its first instant, so it runs in SQL and one row per
 * day crosses the wire.
 *
 * Output matches `deriveRestingProxyFromPulse` exactly: `percentile_cont`
 * interpolates between the two neighbouring order statistics the same way
 * `percentile` in `strain-score.ts` does, the value is rounded the same way
 * in JavaScript, days under `RESTING_PROXY_MIN_DAILY_SAMPLES` are skipped,
 * and each day is anchored on its earliest sample. Days are cut in the zone
 * the caller passes, with the same expression `readDayAggregates` uses.
 *
 * The fold is cached as a closed block. A day's proxy depends only on that
 * day's readings, so the whole local days between the window's first
 * (partial) day and the start of today fold once and are kept in the
 * analytics cache under `closedBlockKeyPart(start of today)`: a sync that
 * writes only today's readings leaves the block in place (the write tail
 * hands `touchedFrom` to `invalidateUserMeasurements`), and a write that
 * reaches into the block, or one that does not say how far it reached,
 * drops it. On a miss the whole window folds in one statement, as it did
 * before the block, and the block is kept from it; on a hit only the partial
 * first day and today fold. On a watch writing 35 000 readings a day the
 * 30-day fold costs about a second;
 * the chart, the daily digest, the pulse status card and the targets card
 * all read it, so they share the block and pay for the two live days only.
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { closedBlockKeyPart } from "@/lib/cache/closed-block";
import { caches, type ServerCache } from "@/lib/cache/server-cache";
import { prisma } from "@/lib/db";
import { isValidTimezone, userDayKey } from "@/lib/tz/format";
import { localDayWindow } from "@/lib/tz/local-day";

import {
  RESTING_PROXY_DAILY_PERCENTILE,
  RESTING_PROXY_MIN_DAILY_SAMPLES,
  type PulseSample,
} from "./resting-pulse";

/**
 * How long a closed block of proxy days lives when no write reaches it. Every
 * measurement write runs the write tail, which invalidates it, and nothing
 * else rewrites raw pulse inside 30 days (the dense retention fold starts at
 * 90), so the lifetime only bounds memory; the key moves on at local
 * midnight in any case.
 */
const CLOSED_PROXY_TTL_MS = 6 * 60 * 60_000;

/**
 * The cache key of the closed proxy days `[blockFrom, blockTo)`. Exported so
 * a test can tell whether a write left the block in place.
 */
export function restingPulseProxyBlockKey(
  userId: string,
  timeZone: string,
  blockFrom: Date,
  blockTo: Date,
): string {
  return `${userId}|resting-pulse-proxy|${timeZone}|from:${blockFrom.getTime()}|${closedBlockKeyPart(blockTo)}`;
}

/** A `[from, to)` window of `measured_at`; open-ended without `to`. */
interface Window {
  from: Date;
  to?: Date;
}

/** The proxy days of the readings in `windows`, ascending by first instant. */
async function foldProxy(
  db: Pick<PrismaClient, "$queryRaw">,
  userId: string,
  timeZone: string,
  windows: readonly Window[],
): Promise<PulseSample[]> {
  const fraction = RESTING_PROXY_DAILY_PERCENTILE / 100;
  const inWindows = Prisma.join(
    windows.map((w) =>
      w.to
        ? Prisma.sql`(m."measured_at" >= ${w.from} AND m."measured_at" < ${w.to})`
        : Prisma.sql`m."measured_at" >= ${w.from}`,
    ),
    " OR ",
  );
  const rows = await db.$queryRaw<Array<{ first_at: Date; p: number }>>(
    Prisma.sql`
    WITH src AS (
      SELECT
        to_char((m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day,
        m."measured_at" AS measured_at,
        m."value" AS value
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."type" = 'PULSE'::measurement_type
        AND m."deleted_at" IS NULL
        AND (${inWindows})
    )
    SELECT
      MIN(measured_at) AS first_at,
      (percentile_cont(${fraction}::double precision) WITHIN GROUP (ORDER BY value))::double precision AS p
    FROM src
    GROUP BY day
    HAVING COUNT(*) >= ${RESTING_PROXY_MIN_DAILY_SAMPLES}
    ORDER BY first_at ASC
  `,
  );
  return rows.map((r) => ({
    measuredAt: r.first_at,
    value: Math.round(Number(r.p)),
  }));
}

export async function readRestingPulseProxy(opts: {
  userId: string;
  /** Inclusive lower bound on `measuredAt`. */
  since: Date;
  /** IANA zone the day boundary is cut in. */
  timeZone: string;
  /** The reader's clock; today's readings are always folded live. */
  now?: Date;
}): Promise<PulseSample[]> {
  const timeZone = isValidTimezone(opts.timeZone) ? opts.timeZone : "UTC";
  const { userId, since } = opts;
  const now = opts.now ?? new Date();
  // The whole local days between the partial first day and today.
  const blockFrom = localDayWindow(
    userDayKey(since, timeZone),
    timeZone,
  ).dayEnd;
  const blockTo = localDayWindow(userDayKey(now, timeZone), timeZone).dayStart;
  if (blockFrom >= blockTo) {
    return foldProxy(prisma, userId, timeZone, [{ from: since }]);
  }
  const cache = caches.analytics as ServerCache<PulseSample[]>;
  const key = restingPulseProxyBlockKey(userId, timeZone, blockFrom, blockTo);
  // On a miss the whole window folds in one statement, exactly as an
  // uncached read does, and the closed days are kept from it; on a hit only
  // the partial first day and today fold.
  let whole: PulseSample[] | null = null;
  const closed = await cache.wrap(
    key,
    async () => {
      whole = await foldProxy(prisma, userId, timeZone, [{ from: since }]);
      return whole.filter(
        (p) => p.measuredAt >= blockFrom && p.measuredAt < blockTo,
      );
    },
    CLOSED_PROXY_TTL_MS,
  );
  const days: PulseSample[] = whole ?? [
    ...closed.value,
    ...(await foldProxy(prisma, userId, timeZone, [
      { from: since, to: blockFrom },
      { from: blockTo },
    ])),
  ];
  // The partial first day, the block and today are whole local days apart
  // (the partial day ends where the block starts, the block ends where today
  // starts), so no day is in two of them. Copies, so no caller can change
  // the cached block.
  return days
    .map((p) => ({ measuredAt: p.measuredAt, value: p.value }))
    .sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
}
