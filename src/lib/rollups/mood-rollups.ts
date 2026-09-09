/**
 * v1.4.39 W-MOOD — persistent mood-rollup populator.
 *
 * Sits behind the 60-s `caches.moodAnalytics` LRU as the second cache
 * tier on `/api/mood/analytics`. One row per
 * `(userId, granularity, bucketStart)` in `mood_entry_rollups`,
 * carrying `count` / `mean` / `min_score` / `max_score` / `sd`
 * (population) folded via Postgres `AVG` / `MIN` / `MAX` / `STDDEV_POP`.
 *
 * The audit at `.planning/round-v1438-perf-analysis.md` §2.3 traced
 * the 12.7 s cold mount on `/api/mood/analytics` to the unbounded
 * `prisma.moodEntry.findMany({ where: { userId } })` that walked
 * every mood row the user has ever written into Node only to
 * bucket-average them in JS. This module mirrors the well-trodden
 * `src/lib/measurements/rollups.ts` pattern so the read path can swap
 * to a bounded `prisma.moodEntryRollup.findMany` with the daily mean
 * already materialised.
 *
 * Keying (v1.32.12): every bucket is keyed on the canonical per-row
 * `MoodEntry.date` label (minted at write time by `moodDateKey` under
 * the row's own `tz`), NOT the UTC truncation of `mood_logged_at`. The
 * rollup is therefore byte-identical to every live `entry.date`
 * fallback, and a late-evening / after-midnight local mood lands on the
 * calendar day the user logged it in their timezone. `bucket_start`
 * stores that label as its UTC-midnight instant.
 *
 * Write hooks:
 *   - Every mood-entry create/update/delete fires
 *     `recomputeMoodBucketsForEntry(userId, dateLabel)`. The DAY pass
 *     runs inline (cheap — single `(user, day-label)` aggregate) so the
 *     next read sees the fresh row without waiting on pg-boss.
 *   - WEEK / MONTH / YEAR are enqueued onto `mood-rollup-recompute`
 *     for the worker to fold. No current reader consumes them; the
 *     buckets exist so future cross-granularity readers ship without
 *     a backfill step.
 *   - Bulk endpoints (`/api/mood-entries/bulk`, restore) call
 *     `recomputeUserMoodRollups(userId)` once at the end of the
 *     batch instead of firing N per-row hooks.
 *
 * Reads:
 *   - `readMoodDayRollups(userId, since)` returns the persisted DAY
 *     rows. The reader-side fallback in `/api/mood/analytics` checks
 *     the rollup count and falls through to the legacy live findMany
 *     once when the user has mood entries but zero rollup rows;
 *     `enqueueBootTimeMoodRollupBackfill` mints the rollups on the
 *     next worker boot so subsequent reads converge on the fast path.
 */
import { prisma } from "@/lib/db";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";
import { trackBackgroundTask } from "@/lib/logging/background-tasks";
import { startOfUtcDay } from "@/lib/tz/start-of-utc-day";
import type {
  Prisma,
  PrismaClient,
  RollupGranularity,
} from "@/generated/prisma/client";

/** Granularities that recompute asynchronously via pg-boss. */
const ASYNC_GRANULARITIES: RollupGranularity[] = ["WEEK", "MONTH", "YEAR"];

/** All granularities the rollup table tracks. */
const ALL_MOOD_GRANULARITIES: RollupGranularity[] = [
  "DAY",
  "WEEK",
  "MONTH",
  "YEAR",
];

/** pg-boss queue name for per-bucket recompute jobs. */
export const MOOD_ROLLUP_RECOMPUTE_QUEUE = "mood-rollup-recompute";

/** Worker concurrency cap — recomputes are read-heavy on Postgres. */
export const MOOD_ROLLUP_RECOMPUTE_CONCURRENCY = 2;

/** pg-boss queue name for the boot-time backfill discovery. */
export const MOOD_ROLLUP_FULL_BACKFILL_QUEUE = "mood-rollup-full-backfill";

/** Boot-fold worker concurrency. Serial so we don't crowd the pool. */
export const MOOD_ROLLUP_FULL_BACKFILL_CONCURRENCY = 1;

/**
 * Format a `Date` as a `YYYY-MM-DD` label from its UTC calendar parts.
 * Used to convert a bucket-window bound (always a UTC-midnight instant,
 * or `now` for the full fold) into the lexicographic day label the
 * `mood_entries."date"` column carries.
 */
function utcDateLabel(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Exclusive upper day-label for a window `to` bound. A `to` that lands
 * exactly on UTC midnight already IS the exclusive boundary (e.g. a
 * `bucketSpan` week's next-Monday). A `to` mid-day (the full-fold's
 * `new Date()`) rounds up to the following midnight so the day
 * containing `to` is still folded — a plain UTC-slice of `now` would
 * drop today's label under the half-open `< toLabel` filter.
 */
function exclusiveUpperLabel(to: Date): string {
  const midnight = startOfUtcDay(to);
  const boundary =
    to.getTime() === midnight.getTime()
      ? midnight
      : new Date(midnight.getTime() + 24 * 60 * 60 * 1000);
  return utcDateLabel(boundary);
}

/** Payload the worker queue carries. */
export interface MoodRollupRecomputePayload {
  userId: string;
  granularity: RollupGranularity;
  /** ISO-8601 — the worker parses through `new Date(value)`. */
  from: string;
  /** ISO-8601 — the worker parses through `new Date(value)`. */
  to: string;
  /** Wall-clock kick-off for debugging only. */
  enqueuedAt: string;
}

/** Payload the boot-time backfill helper enqueues. */
export interface MoodRollupFullBackfillPayload {
  userId: string;
  /** Wall-clock kick-off for debugging only. */
  enqueuedAt: string;
}

/** Postgres `date_trunc` unit per granularity. */
const DATE_TRUNC_UNIT: Record<RollupGranularity, string> = {
  DAY: "day",
  WEEK: "week",
  MONTH: "month",
  YEAR: "year",
};

/** Raw row shape returned by the aggregate `$queryRawUnsafe`. */
interface MoodRollupRow {
  bucket_start: Date;
  count: bigint;
  mean: number | null;
  min_score: number | null;
  max_score: number | null;
  sd: number | null;
}

/**
 * Tx-or-client surface the writer accepts. Mirrors the
 * `measurement-rollups` write-path contract: when called from inside a
 * `prisma.$transaction(async tx => …)` block, callers pass the `tx`
 * client so the rollup write commits atomically with the parent
 * mutation.
 */
type PrismaTxOrClient = Pick<
  PrismaClient,
  "$queryRawUnsafe" | "$executeRaw" | "moodEntryRollup"
>;

/**
 * Recompute the rollup buckets for one user. Bounded by the optional
 * `granularities` / `from` / `to` filters; defaults cover every
 * granularity and the trailing 5 years.
 *
 * Idempotent: rows are upserted under the
 * `(userId, granularity, bucketStart)` composite primary key, so
 * re-running the call is a no-op for unchanged buckets and a refresh
 * for changed ones.
 */
export async function recomputeUserMoodRollups(
  userId: string,
  opts: {
    granularities?: RollupGranularity[];
    from?: Date;
    to?: Date;
    /**
     * Delete the user's existing rollup rows for the folded
     * granularities before refolding. Used by the boot-time
     * full-backfill worker (§ rebuild): it makes the fold
     * self-cleaning against any row minted under an older keying
     * (e.g. a rolling-deploy old-container write) rather than merely
     * upserting over it. Left off for the per-bucket async fold, which
     * targets a narrow window and must not wipe neighbouring buckets.
     */
    replace?: boolean;
  } = {},
): Promise<{ rowsUpserted: number; durationMs: number }> {
  const startedAt = Date.now();
  const granularities = opts.granularities ?? ALL_MOOD_GRANULARITIES;
  const fiveYearsAgo = new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000);
  const from = opts.from ?? fiveYearsAgo;
  const to = opts.to ?? new Date();

  if (opts.replace) {
    // Empty the folded granularities first so the refold below is the
    // only source of truth. With zero rows in place every read for this
    // user falls back to the live `date`-keyed walk (correct data) for
    // the brief window until the fold lands.
    await prisma.moodEntryRollup.deleteMany({
      where: { userId, granularity: { in: granularities } },
    });
  }

  let rowsUpserted = 0;

  for (const granularity of granularities) {
    const rows = await runMoodRollupAggregate(prisma, {
      userId,
      granularity,
      from,
      to,
    });
    if (rows.length === 0) continue;

    rowsUpserted += await persistMoodRollupRows(
      prisma,
      userId,
      granularity,
      rows,
    );
  }

  return { rowsUpserted, durationMs: Date.now() - startedAt };
}

/**
 * Synchronous DAY-bucket recompute for the write-path hooks plus an
 * async enqueue of the WEEK / MONTH / YEAR recomputes.
 *
 * Scoped to the affected `(userId, day)` tuple — cheap, and avoids
 * invalidating buckets that haven't changed.
 */
export async function recomputeMoodBucketsForEntry(
  userId: string,
  dateLabel: string,
): Promise<void> {
  const client = prisma;
  // DAY pass — synchronous. v1.4.39 hotfix (QA F-H-02): one atomic SQL
  // statement re-aggregates inside the upsert subquery, closing the
  // race window where two concurrent writes for the same (user, day)
  // could interleave A-SELECT → B-SELECT → B-UPSERT (correct) →
  // A-UPSERT (stale N-1). The trailing DELETE handles the "all entries
  // for the day were removed" case in the same shot.
  //
  // v1.32.12: the bucket is keyed on the canonical per-row `date` label
  // (`MoodEntry.date`, minted at write time via `moodDateKey` under the
  // row's own `tz`), NOT the UTC truncation of `mood_logged_at`. This
  // makes the rollup byte-identical to every live fallback (which keys
  // on `entry.date`) and puts a late-evening / after-midnight local
  // mood on the calendar day the user logged it in their own timezone.
  // `bucket_start` encodes the label as its UTC midnight instant.
  const bucketStart = new Date(`${dateLabel}T00:00:00.000Z`);
  await client.$executeRaw`
    WITH aggregate AS (
      SELECT
        COUNT(*)::int                                AS count,
        AVG(m."score")::double precision             AS mean,
        MIN(m."score")::integer                      AS min_score,
        MAX(m."score")::integer                      AS max_score,
        STDDEV_POP(m."score")::double precision      AS sd
      FROM "mood_entries" m
      WHERE m."user_id"    = ${userId}
        AND m."deleted_at" IS NULL
        AND m."date"       = ${dateLabel}
    )
    INSERT INTO "mood_entry_rollups"
      ("user_id", "granularity", "bucket_start", "count", "mean", "min_score", "max_score", "sd", "computed_at")
    SELECT
      ${userId},
      'DAY',
      ${bucketStart},
      aggregate.count,
      aggregate.mean,
      aggregate.min_score,
      aggregate.max_score,
      aggregate.sd,
      NOW()
    FROM aggregate
    WHERE aggregate.count > 0
    ON CONFLICT ("user_id", "granularity", "bucket_start") DO UPDATE
      SET "count"       = EXCLUDED."count",
          "mean"        = EXCLUDED."mean",
          "min_score"   = EXCLUDED."min_score",
          "max_score"   = EXCLUDED."max_score",
          "sd"          = EXCLUDED."sd",
          "computed_at" = EXCLUDED."computed_at"
  `;
  await client.$executeRaw`
    DELETE FROM "mood_entry_rollups"
    WHERE "user_id"      = ${userId}
      AND "granularity"  = 'DAY'
      AND "bucket_start" = ${bucketStart}
      AND NOT EXISTS (
        SELECT 1
        FROM "mood_entries" m
        WHERE m."user_id"    = ${userId}
          AND m."deleted_at" IS NULL
          AND m."date"       = ${dateLabel}
      )
  `;

  // WEEK / MONTH / YEAR — fire-and-forget enqueue. QA F-H-03 (v1.4.39):
  // the outer await on this Promise.all used to serialise the write-path
  // response on pg-boss latency. The DAY pass the read path depends on
  // has already committed synchronously above; the queue is a hint, not
  // a write-path invariant, so dropping the await keeps the response
  // off the pg-boss critical path. Errors stay caught inside
  // `enqueueMoodRollupRecompute` so the unhandled-rejection logger
  // captures any pg-boss failure.
  // Registered so the test suite can await it: the error below is a console
  // write on a detached handle, and one that lands while a vitest worker is
  // closing its RPC channel fails the whole run. No-op outside test.
  trackBackgroundTask(
    Promise.all(
      ASYNC_GRANULARITIES.map((granularity) => {
        const { from, to } = bucketSpan(dateLabel, granularity);
        return enqueueMoodRollupRecompute({
          userId,
          granularity,
          from,
          to,
        }).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          annotate({
            meta: {
              mood_rollup_enqueue_failed: true,
              mood_rollup_enqueue_error: message,
            },
          });
          console.error("[mood-rollups] async enqueue failed:", message);
        });
      }),
    ),
  );
}

/**
 * Best-effort pg-boss enqueue. Silent no-op when no boss is attached
 * (route running in a context without the worker — typically the test
 * suite). The reader-side fall-through still produces fresh data on a
 * cache miss, so missing the enqueue is at-most a one-read cost
 * rather than a correctness bug.
 */
export async function enqueueMoodRollupRecompute(input: {
  userId: string;
  granularity: RollupGranularity;
  from: Date;
  to: Date;
}): Promise<void> {
  const boss = getGlobalBoss();
  if (!boss) return;
  const payload: MoodRollupRecomputePayload = {
    userId: input.userId,
    granularity: input.granularity,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    enqueuedAt: new Date().toISOString(),
  };
  await boss.send(MOOD_ROLLUP_RECOMPUTE_QUEUE, payload, {
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    // Coalesce duplicate enqueues for the same bucket key — two writes
    // inside the same week share one queued job.
    singletonKey: `${input.userId}|${input.granularity}|${input.from.toISOString()}`,
  });
}

/**
 * Read DAY-granularity rollup rows for one user, sorted ascending by
 * `bucketStart`. The read-path swap in `/api/mood/analytics` consumes
 * these directly without any extra Node-side aggregation.
 *
 * `since` is an inclusive lower bound. Pass a 5-year-old `Date` from
 * the route to mirror the legacy "unbounded" semantics; future
 * consumers can narrow the window cheaply because the rollup table
 * carries one row per day rather than one per entry.
 */
export async function readMoodDayRollups(
  userId: string,
  since: Date,
): Promise<
  Array<{
    bucketStart: Date;
    count: number;
    mean: number;
    minScore: number;
    maxScore: number;
    sd: number | null;
    computedAt: Date;
  }>
> {
  const rows = await prisma.moodEntryRollup.findMany({
    where: {
      userId,
      granularity: "DAY",
      bucketStart: { gte: since },
    },
    orderBy: { bucketStart: "asc" },
  });
  return rows.map((r) => ({
    bucketStart: r.bucketStart,
    count: r.count,
    mean: r.mean,
    minScore: r.minScore,
    maxScore: r.maxScore,
    sd: r.sd,
    computedAt: r.computedAt,
  }));
}

/**
 * v1.4.39 — fire-and-forget warm-up for the DAY tier.
 *
 * Contract:
 *   - If at least one DAY rollup row exists for the user and it is
 *     fresh (newest rollup `computed_at` ≥ newest mood entry
 *     `updated_at`), this is a no-op.
 *   - Otherwise the helper kicks off a full
 *     `recomputeUserMoodRollups` over the trailing 5-year window so
 *     the next read of `/api/mood/analytics` lands on the rollup
 *     tier. Mood entries are typically 1/day so the recompute is
 *     bounded to a few thousand rows even for power users — cheaper
 *     than the 12.7 s legacy live walk by orders of magnitude.
 *   - Best-effort: thrown errors are swallowed so the read path
 *     never fails because of a populator hiccup.
 *   - Concurrent callers for the same `userId` share one in-flight
 *     promise so a cold fan-out can never queue N parallel
 *     recompute runs.
 */
const ensureUserMoodRollupsFreshInFlight = new Map<
  string,
  Promise<{ recomputed: boolean }>
>();

export async function ensureUserMoodRollupsFresh(
  userId: string,
): Promise<{ recomputed: boolean }> {
  const existing = ensureUserMoodRollupsFreshInFlight.get(userId);
  if (existing) return existing;
  const inflight = ensureUserMoodRollupsFreshImpl(userId).finally(() => {
    ensureUserMoodRollupsFreshInFlight.delete(userId);
  });
  ensureUserMoodRollupsFreshInFlight.set(userId, inflight);
  return inflight;
}

/**
 * Test-only handle on the in-flight map. Mirrors the
 * `_resetEnsureUserRollupsFreshInFlightForTests` pattern in
 * `measurements/rollups.ts` — production code never calls this.
 */
export function _resetEnsureUserMoodRollupsFreshInFlightForTests(): void {
  ensureUserMoodRollupsFreshInFlight.clear();
}

async function ensureUserMoodRollupsFreshImpl(
  userId: string,
): Promise<{ recomputed: boolean }> {
  try {
    const [newestRollup, newestEntry] = await Promise.all([
      prisma.moodEntryRollup.findFirst({
        where: { userId, granularity: "DAY" },
        orderBy: { computedAt: "desc" },
        select: { computedAt: true },
      }),
      prisma.moodEntry.findFirst({
        where: { userId },
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true, moodLoggedAt: true },
      }),
    ]);

    if (!newestEntry) {
      // No mood entries — rollups are trivially fresh.
      return { recomputed: false };
    }
    const watermark =
      newestEntry.updatedAt > newestEntry.moodLoggedAt
        ? newestEntry.updatedAt
        : newestEntry.moodLoggedAt;
    if (newestRollup && watermark <= newestRollup.computedAt) {
      return { recomputed: false };
    }

    // Stale — full 5-year DAY fold. Bounded because mood entries are
    // typically 1/day, so even a multi-year power user materialises a
    // few thousand rows tops.
    await recomputeUserMoodRollups(userId, { granularities: ["DAY"] });
    return { recomputed: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    annotate({
      meta: {
        mood_rollup_refresh_failed: true,
        mood_rollup_refresh_error: message,
      },
    });
    console.error("[mood-rollups] ensureUserMoodRollupsFresh failed:", message);
    return { recomputed: false };
  }
}

/**
 * v1.4.39 — boot-time enqueue helper. Finds users with mood entries
 * but zero `mood_entry_rollups` rows and enqueues one full-fold per
 * account onto `MOOD_ROLLUP_FULL_BACKFILL_QUEUE`. Designed to be
 * called once at worker boot so every self-hosted instance auto-
 * converges on the persistent rollup tier without operator action.
 *
 * Idempotent across reboots:
 *   - the discovery query matches accounts with mood entries but
 *     zero rollup rows; once the fold completes the user drops off
 *     the list
 *   - pg-boss `singletonKey` coalesces duplicate sends within the
 *     queue, so a fast restart while a backfill is queued doesn't
 *     double up
 *
 * Best-effort: errors are swallowed and reported through the return
 * value so the worker boot never fails because of a backfill miss.
 */
export async function enqueueBootTimeMoodRollupBackfill(
  // Optional boot-storm stagger. When > 0 the per-user sends carry a
  // `startAfter` delay (seconds) so this full-history fold does not drain in
  // parallel with the other boot backfills onto one heavy tenant. Default 0
  // keeps immediate semantics for any non-boot caller.
  startAfterSeconds: number = 0,
): Promise<{
  enqueued: number;
  skipped: number;
  error: string | null;
}> {
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    // Users with mood entries but no rollup coverage. Anchored on the
    // per-user `DISTINCT user_id` set so the planner uses the
    // `(user_id, date)` index path; the LEFT JOIN onto
    // `mood_entry_rollups` uses the
    // `(user_id, granularity, bucket_start)` composite primary key.
    // `r."bucket_start" IS NULL` (any column from the right side of
    // the LEFT JOIN) marks the unmatched users.
    const users = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT mt."user_id" AS id
      FROM (
        SELECT DISTINCT m."user_id"
        FROM mood_entries m
        WHERE m."deleted_at" IS NULL
      ) mt
      LEFT JOIN mood_entry_rollups r
        ON  r."user_id"     = mt."user_id"
        AND r."granularity" = 'DAY'
      WHERE r."bucket_start" IS NULL
    `;

    if (users.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const { id } of users) {
      const payload: MoodRollupFullBackfillPayload = {
        userId: id,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(MOOD_ROLLUP_FULL_BACKFILL_QUEUE, payload, {
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
        // Coalesce: if a backfill for this user is already queued and
        // we restart, pg-boss returns null instead of duplicating.
        singletonKey: `mood-boot-backfill|${id}`,
        ...(startAfterSeconds > 0 ? { startAfter: startAfterSeconds } : {}),
      });
      if (jobId) {
        enqueued += 1;
      } else {
        skipped += 1;
      }
    }
    return { enqueued, skipped, error: null };
  } catch (err) {
    return {
      enqueued: 0,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── internals ────────────────────────────────────────────

/**
 * Pull the raw aggregates from Postgres. Groups by the local calendar
 * bucket of the canonical `MoodEntry.date` label —
 * `date_trunc(<granularity>, m."date"::date)` — so a day belongs to the
 * week / month / year of its *local* label, not the UTC instant of its
 * `mood_logged_at`. `bucket_start` is the label's UTC-midnight encoding
 * (`::timestamptz` under the UTC session), byte-identical to the DAY
 * hook and to every live `entry.date` fallback (v1.32.12).
 *
 * The `date_trunc` unit literal must be inlined because Postgres rejects
 * a parameterised expression in a GROUP BY; the value comes from a
 * closed enum (DATE_TRUNC_UNIT) so there's no injection surface — we
 * still assert against the whitelist before splicing. The window bounds
 * are the `date` column's lexicographic day labels (YYYY-MM-DD sorts as
 * the calendar day), so a boundary-straddling entry can never fall out
 * of its own recompute window.
 */
async function runMoodRollupAggregate(
  client: PrismaTxOrClient,
  input: {
    userId: string;
    granularity: RollupGranularity;
    from: Date;
    to: Date;
  },
): Promise<MoodRollupRow[]> {
  const truncUnit = DATE_TRUNC_UNIT[input.granularity];
  if (!["day", "week", "month", "year"].includes(truncUnit)) {
    throw new Error(`unexpected granularity: ${input.granularity}`);
  }
  const bucketExpr = `date_trunc('${truncUnit}', m."date"::date)::timestamptz`;

  const sql = `
    SELECT
      ${bucketExpr}                                             AS bucket_start,
      COUNT(*)                                                  AS count,
      AVG(m."score")::double precision                          AS mean,
      MIN(m."score")::integer                                   AS min_score,
      MAX(m."score")::integer                                   AS max_score,
      STDDEV_POP(m."score")::double precision                   AS sd
    FROM mood_entries m
    WHERE m."user_id"    = $1
      AND m."deleted_at" IS NULL
      AND m."date"       >= $2
      AND m."date"       <  $3
    GROUP BY ${bucketExpr}
  `;
  return client.$queryRawUnsafe<MoodRollupRow[]>(
    sql,
    input.userId,
    utcDateLabel(input.from),
    exclusiveUpperLabel(input.to),
  );
}

/**
 * UPSERT the aggregate rows into `mood_entry_rollups`. Returns the
 * number of rows touched. Chunked so a multi-year fold doesn't blow
 * the parameter cap on a single round-trip.
 */
async function persistMoodRollupRows(
  client: PrismaTxOrClient,
  userId: string,
  granularity: RollupGranularity,
  rows: MoodRollupRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const CHUNK = 500;
  let touched = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    // Run each upsert sequentially through the supplied client (which
    // may be a transactional handle). Wrapping in `$transaction` here
    // would crash when the caller already holds an interactive
    // transaction, so we rely on the parent caller (or atomicity of
    // the single upsert) for crash safety. The hot path is a single
    // row per DAY recompute, so the round-trip cost is negligible.
    for (const row of slice) {
      const payload = {
        count: Number(row.count),
        mean: row.mean ?? 0,
        minScore: row.min_score ?? 0,
        maxScore: row.max_score ?? 0,
        sd: row.sd,
        computedAt: new Date(),
      } satisfies Prisma.MoodEntryRollupUpdateInput;
      await client.moodEntryRollup.upsert({
        where: {
          userId_granularity_bucketStart: {
            userId,
            granularity,
            bucketStart: row.bucket_start,
          },
        },
        create: {
          userId,
          granularity,
          bucketStart: row.bucket_start,
          ...payload,
        },
        update: payload,
      });
    }
    touched += slice.length;
  }
  return touched;
}

/**
 * Span of the bucket containing the calendar day `dateLabel`
 * (`YYYY-MM-DD`, a `MoodEntry.date` value) at the given granularity.
 * The window bounds are UTC-midnight instants of the local label
 * boundaries; `runMoodRollupAggregate` converts them back to day labels
 * for its `m."date"` range filter, so the fold selects exactly the rows
 * whose label falls in this bucket — the local calendar week / month /
 * year, not the UTC span of a `mood_logged_at` instant (v1.32.12).
 */
function bucketSpan(
  dateLabel: string,
  granularity: RollupGranularity,
): { from: Date; to: Date } {
  // Anchor at the label's UTC midnight; its UTC calendar parts ARE the
  // label's parts, so the existing UTC date math below is exact.
  const anchor = new Date(`${dateLabel}T00:00:00.000Z`);
  switch (granularity) {
    case "DAY": {
      return {
        from: anchor,
        to: new Date(anchor.getTime() + 24 * 60 * 60 * 1000),
      };
    }
    case "WEEK": {
      // Postgres ISO week: Monday is day 1. JS getUTCDay(): Sunday=0.
      const dayOfWeek = anchor.getUTCDay();
      const mondayOffset = (dayOfWeek + 6) % 7;
      const from = new Date(
        anchor.getTime() - mondayOffset * 24 * 60 * 60 * 1000,
      );
      return { from, to: new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000) };
    }
    case "MONTH": {
      const from = new Date(
        Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1),
      );
      const to = new Date(
        Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1),
      );
      return { from, to };
    }
    case "YEAR": {
      const from = new Date(Date.UTC(anchor.getUTCFullYear(), 0, 1));
      const to = new Date(Date.UTC(anchor.getUTCFullYear() + 1, 0, 1));
      return { from, to };
    }
  }
}
