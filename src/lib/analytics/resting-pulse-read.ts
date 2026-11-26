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
 * and each day is anchored on its earliest sample. Days are cut in the
 * profile zone the caller passes, as `readDayAggregates` cuts a pulse day;
 * a reading's own zone is not read (`reading-zone-reader-ratchet.test.ts`).
 *
 * A day folds the readings of one source: the first source of the day on the
 * person's `pulse` ladder (rank, then source name, as `readDayAggregates`
 * picks a day). A watch and a phone app reporting the same day's pulse are
 * two streams of one heart; pooling them took the 20th percentile of a
 * mixture, which neither device measured. The day's sample floor applies to
 * the picked source's readings, so a better-ranked source with too few
 * readings leaves the day out rather than handing it to a lower-ranked one.
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
import {
  sourceLadderOfType,
  sourceRankOfTypeSql,
} from "@/lib/analytics/source-rank-sql";
import { closedBlockKeyPart } from "@/lib/cache/closed-block";
import { PROCESS_CACHE_MAX_TTL_MS } from "@/lib/cache/ttl-ceiling";
import { caches, type ServerCache } from "@/lib/cache/server-cache";
import { prisma } from "@/lib/db";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { isValidTimezone, userDayKey } from "@/lib/tz/format";
import { localDayWindow } from "@/lib/tz/local-day";

import {
  RESTING_PROXY_DAILY_PERCENTILE,
  RESTING_PROXY_MIN_DAILY_SAMPLES,
  type PulseSample,
} from "./resting-pulse";

/**
 * How long a closed block of proxy days lives when no write reaches it. A
 * measurement write runs the write tail, which drops the block in its own
 * process only: with a split web and worker (`docs/self-hosting/scaling.md`)
 * a cloud sync, a file import or a restore in the worker leaves the web's
 * block in place, so the lifetime is the longest the web can serve a proxy
 * from before such a write. Fifteen minutes, the cache's ceiling, as for the
 * other closed blocks (`canonical-window.ts`, `sleep-night-history.ts`); the
 * key moves on at local midnight in any case.
 */
const CLOSED_PROXY_TTL_MS = PROCESS_CACHE_MAX_TTL_MS;

/**
 * The cache key of the closed proxy days `[blockFrom, blockTo)` under the
 * pulse ladder of `sourcePriority`, so a reordered ladder never serves days
 * picked by the old one. Exported so a test can tell whether a write left
 * the block in place.
 */
export function restingPulseProxyBlockKey(
  userId: string,
  timeZone: string,
  blockFrom: Date,
  blockTo: Date,
  sourcePriority: unknown,
): string {
  const ladder = sourceLadderOfType("PULSE", sourcePriority).join(">");
  return `${userId}|resting-pulse-proxy|${timeZone}|ladder:${ladder}|from:${blockFrom.getTime()}|${closedBlockKeyPart(blockTo)}`;
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
  sourcePriority: unknown,
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
  // Each (day, source) folds on its own and the day keeps its first source
  // in ladder order: one row per source and day is ranked, never a window
  // over the raw stream.
  const rank = Prisma.raw(
    sourceRankOfTypeSql("PULSE", sourcePriority, "f.source") ?? "90",
  );
  const rows = await db.$queryRaw<Array<{ first_at: Date; p: number }>>(
    Prisma.sql`
    WITH src AS (
      SELECT
        to_char((m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day,
        m."source" AS source,
        m."measured_at" AS measured_at,
        m."value" AS value
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."type" = 'PULSE'::measurement_type
        AND m."deleted_at" IS NULL
        AND (${inWindows})
    ),
    folded AS (
      SELECT
        day,
        source,
        COUNT(*) AS n,
        MIN(measured_at) AS first_at,
        (percentile_cont(${fraction}::double precision) WITHIN GROUP (ORDER BY value))::double precision AS p
      FROM src
      GROUP BY day, source
    ),
    picked AS (
      SELECT DISTINCT ON (f.day) f.n, f.first_at, f.p
      FROM folded f
      ORDER BY f.day, (${rank}), f.source::text
    )
    SELECT first_at, p
    FROM picked
    WHERE n >= ${RESTING_PROXY_MIN_DAILY_SAMPLES}
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
  const sourcePriority = await loadUserSourcePriority(userId);
  // The whole local days between the partial first day and today.
  const blockFrom = localDayWindow(
    userDayKey(since, timeZone),
    timeZone,
  ).dayEnd;
  const blockTo = localDayWindow(userDayKey(now, timeZone), timeZone).dayStart;
  if (blockFrom >= blockTo) {
    return foldProxy(prisma, userId, timeZone, sourcePriority, [
      { from: since },
    ]);
  }
  const cache = caches.analytics as ServerCache<PulseSample[]>;
  const key = restingPulseProxyBlockKey(
    userId,
    timeZone,
    blockFrom,
    blockTo,
    sourcePriority,
  );
  // On a miss the whole window folds in one statement, exactly as an
  // uncached read does, and the closed days are kept from it; on a hit only
  // the partial first day and today fold.
  let whole: PulseSample[] | null = null;
  const closed = await cache.wrap(
    key,
    async () => {
      whole = await foldProxy(prisma, userId, timeZone, sourcePriority, [
        { from: since },
      ]);
      return whole.filter(
        (p) => p.measuredAt >= blockFrom && p.measuredAt < blockTo,
      );
    },
    CLOSED_PROXY_TTL_MS,
  );
  const days: PulseSample[] = whole ?? [
    ...closed.value,
    ...(await foldProxy(prisma, userId, timeZone, sourcePriority, [
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
