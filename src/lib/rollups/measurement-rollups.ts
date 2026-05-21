/**
 * v1.5.0 — persistent measurement-rollup populator.
 *
 * Sits behind the 60-s in-process LRU as the second cache tier
 * (per `.planning/research/v1434-r-cache-aggregation.md` §9). One row
 * per `(userId, type, granularity, bucketStart)` in
 * `measurement_rollups`, carrying the count / min / max / mean / sd /
 * slope / r2 stats Postgres folds via `STDDEV_POP` / `REGR_SLOPE` /
 * `REGR_R2`. The stats semantics mirror the v1.4.34.1 comprehensive
 * aggregator so cached + live aggregates agree byte-for-byte.
 *
 * Write hooks:
 *   - The measurement create / update / delete endpoints call
 *     `recomputeBucketsForMeasurement` after their successful commit.
 *     The DAY bucket recompute runs inline (cheap, scoped to a single
 *     `(user, type, day)` tuple) so the next read is correct.
 *     WEEK / MONTH / YEAR recomputes enqueue onto pg-boss for the
 *     worker to fold.
 *   - The Apple Health import worker calls `recomputeUserRollups`
 *     ONCE at the end of the import, scoped to the import's date
 *     range, to avoid per-row write-hook overhead on 100k-row
 *     backfills.
 *
 * Reads:
 *   - `readRollupBuckets` returns the persisted rows. The reader
 *     side (`analytics`, `comprehensive`, `summaries-slice`) calls
 *     `isRollupFresh` first to decide whether to fall through to the
 *     live aggregator + persist-on-miss. Cheap heuristic — one
 *     indexed query for the newest measurement's `measuredAt`.
 */
import { prisma } from "@/lib/db";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";
import { startOfUtcDay } from "@/lib/tz/start-of-utc-day";
import type {
  MeasurementType,
  RollupGranularity,
} from "@/generated/prisma/client";

/** All granularities the rollup table tracks. */
export const ALL_GRANULARITIES: RollupGranularity[] = [
  "DAY",
  "WEEK",
  "MONTH",
  "YEAR",
];

/** Granularities that recompute asynchronously via pg-boss. */
const ASYNC_GRANULARITIES: RollupGranularity[] = ["WEEK", "MONTH", "YEAR"];

/** pg-boss queue name. */
export const ROLLUP_RECOMPUTE_QUEUE = "rollup-recompute";

/** Worker concurrency cap — recomputes are read-heavy on Postgres. */
export const ROLLUP_RECOMPUTE_CONCURRENCY = 2;

/**
 * Payload `boss.send` carries onto the `rollup-recompute` queue. The
 * worker hands the values straight to `recomputeUserRollups`.
 */
export interface RollupRecomputePayload {
  userId: string;
  type: MeasurementType;
  granularity: RollupGranularity;
  /** ISO-8601 string — the worker parses through `new Date(value)`. */
  from: string;
  /** ISO-8601 string — the worker parses through `new Date(value)`. */
  to: string;
  /** Wall-clock kick-off for debugging only. */
  enqueuedAt: string;
}

/**
 * v1.4.35.1 — boot-time full-fold queue. The write-path hooks keep
 * the DAY bucket current per measurement, and `ensureUserRollupsFresh`
 * warm-on-read covers the trailing 90-day DAY window on cold mount,
 * but neither path folds the deep WEEK / MONTH / YEAR history for an
 * account that has measurements pre-dating the v1.4.35 deploy. This
 * queue exists so the worker boot can enqueue one full
 * `recomputeUserRollups(userId)` per uncovered user — no operator
 * action needed on self-hosted instances.
 */
export const ROLLUP_FULL_BACKFILL_QUEUE = "rollup-full-backfill";

/** Boot-fold worker concurrency. Serial so we don't crowd the pool. */
export const ROLLUP_FULL_BACKFILL_CONCURRENCY = 1;

/** Payload the boot-time backfill helper enqueues. */
export interface RollupFullBackfillPayload {
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

/** Raw row shape returned by the aggregate `$queryRaw`. */
interface RollupRow {
  type: string;
  bucket_start: Date;
  count: bigint;
  mean: number | null;
  min_value: number | null;
  max_value: number | null;
  sum_value: number | null;
  sd: number | null;
  slope: number | null;
  r2: number | null;
}

/**
 * Recompute the rollup buckets for one user. Bounded by the optional
 * `types` / `granularities` / `from` / `to` filters; defaults cover
 * every type, every granularity, and the trailing 5 years.
 *
 * Idempotent: rows are upserted under the
 * `(userId, type, granularity, bucketStart)` composite primary key,
 * so re-running the call is a no-op for unchanged buckets and a
 * refresh for changed ones.
 */
export async function recomputeUserRollups(
  userId: string,
  opts: {
    types?: MeasurementType[];
    granularities?: RollupGranularity[];
    from?: Date;
    to?: Date;
  } = {},
): Promise<{ rowsUpserted: number; durationMs: number }> {
  const startedAt = Date.now();
  const granularities = opts.granularities ?? ALL_GRANULARITIES;
  const fiveYearsAgo = new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000);
  const from = opts.from ?? fiveYearsAgo;
  const to = opts.to ?? new Date();

  let rowsUpserted = 0;

  for (const granularity of granularities) {
    const rows = await runRollupAggregate({
      userId,
      types: opts.types,
      granularity,
      from,
      to,
    });
    if (rows.length === 0) continue;

    rowsUpserted += await persistRollupRows(userId, granularity, rows);
  }

  return { rowsUpserted, durationMs: Date.now() - startedAt };
}

/**
 * Synchronous DAY bucket recompute for the write-path hooks plus an
 * async enqueue of the WEEK / MONTH / YEAR recomputes. The DAY pass
 * runs inline so the next read of `comprehensive` / `analytics`
 * reflects the new row without waiting on pg-boss.
 *
 * Scoped to the affected `(userId, type, day)` tuple — cheap, and
 * avoids invalidating buckets that haven't changed.
 */
export async function recomputeBucketsForMeasurement(
  userId: string,
  type: MeasurementType,
  measuredAt: Date,
): Promise<void> {
  // DAY pass — synchronous. Pull the rollup for the affected day
  // and upsert it. The aggregate is scoped to the single day so the
  // SQL is bounded even for users with multi-year history.
  const dayStart = startOfUtcDay(measuredAt);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const rows = await runRollupAggregate({
    userId,
    types: [type],
    granularity: "DAY",
    from: dayStart,
    to: dayEnd,
  });
  if (rows.length === 0) {
    // No rows in this day after the mutation (e.g. the DELETE path
    // removed the last reading) — drop the rollup row if it exists.
    await prisma.measurementRollup.deleteMany({
      where: {
        userId,
        type,
        granularity: "DAY",
        bucketStart: dayStart,
      },
    });
  } else {
    await persistRollupRows(userId, "DAY", rows);
  }

  // WEEK / MONTH / YEAR — enqueue. Each granularity covers a range
  // around the affected day so the worker only re-aggregates the
  // bucket(s) the write could have changed.
  //
  // v1.4.38 — the three `enqueueRollupRecompute` calls are independent
  // (different singletonKey per granularity inside `enqueueRollupRecompute`)
  // so fan them out via `Promise.all` instead of sequencing them with
  // `await`. Halves the post-write critical path on every measurement
  // create / update / delete; matters on iOS batch imports that fire
  // hundreds of hooks back-to-back.
  await Promise.all(
    ASYNC_GRANULARITIES.map((granularity) => {
      const { from, to } = bucketSpan(measuredAt, granularity);
      return enqueueRollupRecompute({
        userId,
        type,
        granularity,
        from,
        to,
      });
    }),
  );
}

/**
 * Best-effort pg-boss enqueue. Silent no-op when no boss is attached
 * (route is running in a context without the worker — typically the
 * test suite). The reader-side fall-through still produces fresh
 * data on a cache miss, so missing the enqueue is at-most a one-read
 * cost rather than a correctness bug.
 */
export async function enqueueRollupRecompute(input: {
  userId: string;
  type: MeasurementType;
  granularity: RollupGranularity;
  from: Date;
  to: Date;
}): Promise<void> {
  const boss = getGlobalBoss();
  if (!boss) return;
  const payload: RollupRecomputePayload = {
    userId: input.userId,
    type: input.type,
    granularity: input.granularity,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    enqueuedAt: new Date().toISOString(),
  };
  await boss.send(ROLLUP_RECOMPUTE_QUEUE, payload, {
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    // Coalesce duplicate enqueues for the same bucket key — multiple
    // measurements landing on the same day shouldn't each spawn a
    // separate worker run. The singleton key uses bucket-start so
    // two writes inside the same week share one queued job.
    singletonKey: `${input.userId}|${input.type}|${input.granularity}|${input.from.toISOString()}`,
  });
}

/**
 * Read rollup rows for `(userId, type, granularity)` in `[from, to)`.
 * Returns rows sorted ascending by `bucketStart`.
 */
export async function readRollupBuckets(
  userId: string,
  type: MeasurementType,
  granularity: RollupGranularity,
  from: Date,
  to: Date,
): Promise<
  Array<{
    bucketStart: Date;
    count: number;
    mean: number;
    minValue: number;
    maxValue: number;
    sd: number | null;
    slope: number | null;
    r2: number | null;
    computedAt: Date;
  }>
> {
  const rows = await prisma.measurementRollup.findMany({
    where: {
      userId,
      type,
      granularity,
      bucketStart: { gte: from, lt: to },
    },
    orderBy: { bucketStart: "asc" },
  });
  return rows.map((r) => ({
    bucketStart: r.bucketStart,
    count: r.count,
    mean: r.mean,
    minValue: r.minValue,
    maxValue: r.maxValue,
    sd: r.sd,
    slope: r.slope,
    r2: r.r2,
    computedAt: r.computedAt,
  }));
}

/**
 * Cheap freshness heuristic — one indexed query against
 * `measurements` for the newest row per (user, type). Returns true
 * when the persisted rollup covers every measurement currently in
 * the DB, false when there's a newer measurement than the freshest
 * rollup row (the rollup needs a recompute).
 *
 * `null` newest measurement means the user has no rows of this type,
 * in which case the rollups are trivially fresh (empty == empty).
 */
export async function isRollupFresh(
  userId: string,
  type: MeasurementType,
  granularity: RollupGranularity,
  newestComputedAt: Date | null,
): Promise<boolean> {
  const newest = await prisma.measurement.findFirst({
    where: { userId, type, deletedAt: null },
    orderBy: { measuredAt: "desc" },
    select: { measuredAt: true, updatedAt: true },
  });
  if (!newest) {
    // No measurements at all — empty rollup set is fresh by definition.
    return true;
  }
  if (!newestComputedAt) {
    // We have measurements but no rollup rows — definitely stale.
    return false;
  }
  // Stale when the latest row was written / updated after the most
  // recent rollup `computed_at` for this `(user, type, granularity)`.
  const watermark =
    newest.updatedAt > newest.measuredAt ? newest.updatedAt : newest.measuredAt;
  return watermark <= newestComputedAt;
}

// ─── internals ────────────────────────────────────────────

/**
 * Pull the raw aggregates from Postgres. Groups by
 * `date_trunc(<granularity>, measured_at)` and folds the stats with
 * `STDDEV_POP` / `REGR_SLOPE` / `REGR_R2`. The slope X-axis is days
 * (epoch / 86400) so the slope is in "units per day", matching the
 * comprehensive-aggregator + summaries-slice convention.
 */
async function runRollupAggregate(input: {
  userId: string;
  types: MeasurementType[] | undefined;
  granularity: RollupGranularity;
  from: Date;
  to: Date;
}): Promise<RollupRow[]> {
  if (input.types && input.types.length === 0) return [];

  // Postgres rejects `date_trunc($1::text, m."measured_at")` in a
  // GROUP BY because the planner sees the parameterised expression
  // and can't match the SELECT-list to the GROUP-BY expression. The
  // unit literal must be inlined. The value comes from a closed enum
  // (DATE_TRUNC_UNIT) so there's no injection surface — we still
  // assert against the whitelist before splicing.
  const truncUnit = DATE_TRUNC_UNIT[input.granularity];
  if (!["day", "week", "month", "year"].includes(truncUnit)) {
    throw new Error(`unexpected granularity: ${input.granularity}`);
  }
  const dateTrunc = `date_trunc('${truncUnit}', m."measured_at")`;

  if (input.types && input.types.length > 0) {
    // Build the type-list literal carefully. The enum values come
    // from `MeasurementType` (Prisma-generated TS enum); we whitelist
    // them with a strict regex before splicing into SQL.
    for (const t of input.types) {
      if (!/^[A-Z_]+$/.test(t)) {
        throw new Error(`invalid measurement type: ${t}`);
      }
    }
    const typeList = input.types
      .map((t) => `'${t}'::"measurement_type"`)
      .join(",");
    const sql = `
      SELECT
        m."type"::text                                            AS type,
        ${dateTrunc}                                              AS bucket_start,
        COUNT(*)                                                  AS count,
        AVG(m."value")::double precision                          AS mean,
        MIN(m."value")::double precision                          AS min_value,
        MAX(m."value")::double precision                          AS max_value,
        SUM(m."value")::double precision                          AS sum_value,
        STDDEV_POP(m."value")::double precision                   AS sd,
        REGR_SLOPE(
          m."value",
          EXTRACT(EPOCH FROM m."measured_at") / 86400.0
        )::double precision                                       AS slope,
        REGR_R2(
          m."value",
          EXTRACT(EPOCH FROM m."measured_at") / 86400.0
        )::double precision                                       AS r2
      FROM measurements m
      WHERE m."user_id" = $1
        AND m."type" IN (${typeList})
        AND m."measured_at" >= $2
        AND m."measured_at" <  $3
        AND m."deleted_at" IS NULL
      GROUP BY m."type", ${dateTrunc}
    `;
    return prisma.$queryRawUnsafe<RollupRow[]>(
      sql,
      input.userId,
      input.from,
      input.to,
    );
  }

  const sql = `
    SELECT
      m."type"::text                                            AS type,
      ${dateTrunc}                                              AS bucket_start,
      COUNT(*)                                                  AS count,
      AVG(m."value")::double precision                          AS mean,
      MIN(m."value")::double precision                          AS min_value,
      MAX(m."value")::double precision                          AS max_value,
      SUM(m."value")::double precision                          AS sum_value,
      STDDEV_POP(m."value")::double precision                   AS sd,
      REGR_SLOPE(
        m."value",
        EXTRACT(EPOCH FROM m."measured_at") / 86400.0
      )::double precision                                       AS slope,
      REGR_R2(
        m."value",
        EXTRACT(EPOCH FROM m."measured_at") / 86400.0
      )::double precision                                       AS r2
    FROM measurements m
    WHERE m."user_id" = $1
      AND m."measured_at" >= $2
      AND m."measured_at" <  $3
      AND m."deleted_at" IS NULL
    GROUP BY m."type", ${dateTrunc}
  `;
  return prisma.$queryRawUnsafe<RollupRow[]>(
    sql,
    input.userId,
    input.from,
    input.to,
  );
}

/**
 * UPSERT the aggregate rows into `measurement_rollups`. Returns the
 * number of rows touched. Uses a single chunked `$executeRaw` insert
 * with `ON CONFLICT DO UPDATE` so the round-trip count is bounded
 * regardless of fan-out width.
 */
async function persistRollupRows(
  userId: string,
  granularity: RollupGranularity,
  rows: RollupRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  // Chunk to keep the parameter count below Postgres' 65k cap and
  // the transaction round-trip count bounded for large backfills.
  // For the typical hot path (a single DAY recompute = 1 row, a
  // multi-week WEEK recompute = a few rows) the round-trip count is
  // negligible.
  const CHUNK = 500;
  let touched = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await prisma.$transaction(
      slice.map((row) =>
        prisma.measurementRollup.upsert({
          where: {
            userId_type_granularity_bucketStart: {
              userId,
              type: row.type as MeasurementType,
              granularity,
              bucketStart: row.bucket_start,
            },
          },
          create: {
            userId,
            type: row.type as MeasurementType,
            granularity,
            bucketStart: row.bucket_start,
            count: Number(row.count),
            mean: row.mean ?? 0,
            minValue: row.min_value ?? 0,
            maxValue: row.max_value ?? 0,
            // v1.4.39 W-SUM — populate for every type. Cumulative read
            // paths (steps, flights, distance, daylight, active-energy)
            // consume this column directly; spot metrics carry it for
            // free because the underlying SUM aggregator runs in the
            // same query as AVG / MIN / MAX.
            sumValue: row.sum_value ?? null,
            sd: row.sd,
            slope: row.slope,
            r2: row.r2,
            computedAt: new Date(),
          },
          update: {
            count: Number(row.count),
            mean: row.mean ?? 0,
            minValue: row.min_value ?? 0,
            maxValue: row.max_value ?? 0,
            sumValue: row.sum_value ?? null,
            sd: row.sd,
            slope: row.slope,
            r2: row.r2,
            computedAt: new Date(),
          },
        }),
      ),
    );
    touched += slice.length;
  }
  return touched;
}

/**
 * Span of the bucket containing `measuredAt` at the given granularity.
 * Postgres `date_trunc` is the canonical truncator; we mirror its
 * Monday-anchored ISO week and calendar-month / calendar-year
 * semantics in JS so the worker re-aggregation queries select the
 * same set of rows the read-side `date_trunc` would group on.
 */
function bucketSpan(
  measuredAt: Date,
  granularity: RollupGranularity,
): { from: Date; to: Date } {
  switch (granularity) {
    case "DAY": {
      const from = startOfUtcDay(measuredAt);
      return { from, to: new Date(from.getTime() + 24 * 60 * 60 * 1000) };
    }
    case "WEEK": {
      const day = startOfUtcDay(measuredAt);
      // Postgres ISO week: Monday is day 1. JS getUTCDay(): Sunday=0..Saturday=6.
      const dayOfWeek = day.getUTCDay(); // 0=Sun
      const mondayOffset = (dayOfWeek + 6) % 7; // 0 for Mon … 6 for Sun
      const from = new Date(
        day.getTime() - mondayOffset * 24 * 60 * 60 * 1000,
      );
      return { from, to: new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000) };
    }
    case "MONTH": {
      const from = new Date(
        Date.UTC(measuredAt.getUTCFullYear(), measuredAt.getUTCMonth(), 1),
      );
      const to = new Date(
        Date.UTC(
          measuredAt.getUTCFullYear(),
          measuredAt.getUTCMonth() + 1,
          1,
        ),
      );
      return { from, to };
    }
    case "YEAR": {
      const from = new Date(Date.UTC(measuredAt.getUTCFullYear(), 0, 1));
      const to = new Date(Date.UTC(measuredAt.getUTCFullYear() + 1, 0, 1));
      return { from, to };
    }
  }
}

/**
 * v1.4.38 — per-userId in-flight dedup. v1.4.37.1 fire-and-forgets the
 * `ensureUserRollupsFresh` call from the read path so a stale 90-day
 * recompute can no longer stall the response, but if a request DOES
 * end up awaiting a synchronous recompute (worker code path, future
 * caller without the fire-and-forget) and the same user has a cold
 * fan-out hitting analytics + comprehensive + summaries within the
 * same tick, the legacy shape would queue N parallel
 * `recomputeUserRollups` invocations against the same 90-day window.
 * The map below collapses those into one shared promise — every
 * caller after the first re-uses the in-flight resolution and only
 * one Postgres aggregate runs. Mirrors the `buildCoachSnapshot` dedup
 * pattern that lives one layer up. Cleared in `finally` so a slow
 * promise that eventually rejects does not poison the next request.
 */
const ensureUserRollupsFreshInFlight = new Map<
  string,
  Promise<{ recomputed: boolean }>
>();

/**
 * Cheap read-side warm-up. Called from the analytics + comprehensive
 * read paths so the rollup table stays current for downstream
 * consumers without each read paying the full live-aggregation cost
 * twice.
 *
 * Contract:
 *   - If the user has at least one DAY rollup row that is current
 *     (newest measurement ≤ newest rollup `computed_at`), this is a
 *     no-op.
 *   - Otherwise the function kicks off a `recomputeUserRollups` over
 *     the trailing 90-day window (the dashboard hot path) for the
 *     DAY granularity only. WEEK / MONTH / YEAR follow on the next
 *     write hook or the explicit backfill — we don't pay for them
 *     here.
 *   - Best-effort: thrown errors are swallowed so the read path
 *     never fails because of a populator hiccup.
 *   - v1.4.38: concurrent callers for the same `userId` share one
 *     in-flight promise so a cold fan-out can never queue N parallel
 *     `recomputeUserRollups` runs against the same 90-day window.
 */
export async function ensureUserRollupsFresh(
  userId: string,
): Promise<{ recomputed: boolean }> {
  // v1.4.38 — share the in-flight promise across concurrent callers
  // for the same userId. The map is keyed on `userId` because the
  // helper has no other parameters; the next caller hits the
  // resolved promise as soon as it lands. We delete the slot in
  // `finally` so a slow rejected promise does not stay cached and
  // poison the next request.
  const existing = ensureUserRollupsFreshInFlight.get(userId);
  if (existing) return existing;
  const inflight = ensureUserRollupsFreshImpl(userId).finally(() => {
    ensureUserRollupsFreshInFlight.delete(userId);
  });
  ensureUserRollupsFreshInFlight.set(userId, inflight);
  return inflight;
}

/**
 * Test-only handle on the in-flight map. Mirrors the
 * `_resetTrustViolationWarningForTests` pattern in api-response.ts —
 * production code never calls this.
 */
export function _resetEnsureUserRollupsFreshInFlightForTests(): void {
  ensureUserRollupsFreshInFlight.clear();
}

async function ensureUserRollupsFreshImpl(
  userId: string,
): Promise<{ recomputed: boolean }> {
  try {
    // Single round-trip — the most-recent DAY rollup for the user
    // and the most-recent measurement updatedAt. If the rollup is
    // ahead of the measurement, we're done.
    const [newestRollup, newestMeasurement] = await Promise.all([
      prisma.measurementRollup.findFirst({
        where: { userId, granularity: "DAY" },
        orderBy: { computedAt: "desc" },
        select: { computedAt: true },
      }),
      prisma.measurement.findFirst({
        where: { userId, deletedAt: null },
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true, measuredAt: true },
      }),
    ]);

    if (!newestMeasurement) {
      // User has no measurements — rollups are trivially fresh.
      return { recomputed: false };
    }
    const watermark =
      newestMeasurement.updatedAt > newestMeasurement.measuredAt
        ? newestMeasurement.updatedAt
        : newestMeasurement.measuredAt;
    if (newestRollup && watermark <= newestRollup.computedAt) {
      return { recomputed: false };
    }

    // Stale — refresh the trailing 90-day DAY window. Synchronous so
    // the next read of `comprehensive` / `analytics` benefits even on
    // the first cold-mount fan-out. Bounded to DAY granularity so the
    // read path doesn't accidentally pay the WEEK / MONTH / YEAR
    // cost; those are handled by write hooks + the backfill script.
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await recomputeUserRollups(userId, {
      granularities: ["DAY"],
      from: ninetyDaysAgo,
      to: new Date(),
    });
    return { recomputed: true };
  } catch (err) {
    // Best-effort — never block the read path on a populator failure.
    // v1.4.36 QA H3 — surface the failure so ops can spot a silent
    // populator regression. `annotate` is a no-op when there's no
    // request context (worker calls, tests); `console.error` carries
    // the same shape through the worker log pipeline so the regression
    // is visible regardless of caller surface.
    const message = err instanceof Error ? err.message : String(err);
    annotate({
      meta: {
        rollup_refresh_failed: true,
        rollup_refresh_error: message,
      },
    });
    console.error("[rollups] ensureUserRollupsFresh failed:", message);
    return { recomputed: false };
  }
}

/**
 * v1.4.35.1 — boot-time enqueue helper. Finds users with measurements
 * but zero rollup coverage and enqueues one full-fold job per account
 * onto `ROLLUP_FULL_BACKFILL_QUEUE`. Designed to be called once at
 * worker boot so every self-hosted instance auto-converges on the
 * persistent rollup tier without operator intervention.
 *
 * Idempotent across reboots:
 *   - the discovery query matches accounts that either have zero
 *     rollup coverage at all OR have at least one measurement type
 *     whose DAY-rollup partition is empty. Once every type the user
 *     has logged has at least one DAY bucket, the user drops off the
 *     list and subsequent boots skip them. The v1.4.35.1 shape (zero-
 *     rollups only) silently stranded users who logged a brand-new
 *     type after the initial fold — their `isFullyCovered` probe stays
 *     `false`, every read fans out to the live SQL aggregator, and
 *     `/api/analytics` cold-mounts in tens of seconds instead of
 *     1.5-3 s. v1.4.38.5 widens discovery to per-type missing coverage.
 *   - pg-boss `singletonKey` coalesces duplicate sends within the
 *     queue, so a fast restart while a backfill is queued doesn't
 *     double up
 *
 * Best-effort: errors are swallowed and reported through the return
 * value so the worker boot never fails because of a backfill miss.
 */
export async function enqueueBootTimeRollupBackfill(): Promise<{
  enqueued: number;
  skipped: number;
  error: string | null;
}> {
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    // Users where at least one (type, day) pair in `measurements`
    // has no matching DAY rollup row.
    //
    // v1.4.39.1 — tightened from per-type to per-day. The legacy shape
    // matched users where ANY type had zero rollup rows. That stranded
    // accounts whose Withings sync / `/api/import` / admin restore
    // wrote measurements without firing the rollup write hook: as soon
    // as ONE rollup row existed for the type (even from a prior boot
    // backfill), the LEFT JOIN found a match and the user dropped off
    // the discovery list — leaving the dashboard chart's
    // `source=rollup` fast-path under-counting the missing days.
    // Switching the join to `(user, type, bucketStart)` surfaces every
    // per-day gap. Cost: the inner DISTINCT widens from
    // `(user_id, type)` (≈15 rows/user) to
    // `(user_id, type, day)` (≈5 k rows/user on a 5-year power user),
    // which is still bounded by the `(user_id, type, measured_at)`
    // index path. The LEFT JOIN walks `measurement_rollups` against
    // its composite primary key.
    //
    // v1.4.41 — the v1.4.39 W-SUM legacy-NULL `sum_value` UNION arm
    // has been retired. Marc's tenant converged at v1.4.40, so the
    // arm was a permanent no-op seq scan over `measurement_rollups`.
    // Per-day missing coverage remains the sole discovery anchor.
    const users = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT mt."user_id" AS id
      FROM (
        SELECT DISTINCT
          m."user_id",
          m."type",
          date_trunc('day', m."measured_at") AS bucket_start
        FROM measurements m
        WHERE m."deleted_at" IS NULL
      ) mt
      LEFT JOIN measurement_rollups r
        ON  r."user_id"     = mt."user_id"
        AND r."type"        = mt."type"
        AND r."granularity" = 'DAY'
        AND r."bucket_start" = mt."bucket_start"
      WHERE r."bucket_start" IS NULL
    `;

    if (users.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const { id } of users) {
      const payload: RollupFullBackfillPayload = {
        userId: id,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(ROLLUP_FULL_BACKFILL_QUEUE, payload, {
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
        // Coalesce: if a backfill for this user is already queued and
        // we restart, pg-boss returns null instead of duplicating.
        singletonKey: `boot-backfill|${id}`,
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

/**
 * Collapse a list of `(type, day)` keys to the set of distinct
 * `(type, dayStart)` pairs. Used by the batch-ingest hooks so a 500-
 * row batch fires at most N DAY recomputes (typically <10 for a
 * single-day batch).
 */
export function collapseToTypeDayKeys(
  rows: Array<{ type: MeasurementType; measuredAt: Date }>,
): Array<{ type: MeasurementType; measuredAt: Date }> {
  const seen = new Map<string, { type: MeasurementType; measuredAt: Date }>();
  for (const row of rows) {
    const dayStart = startOfUtcDay(row.measuredAt);
    const key = `${row.type}|${dayStart.toISOString()}`;
    if (!seen.has(key)) {
      seen.set(key, { type: row.type, measuredAt: dayStart });
    }
  }
  return Array.from(seen.values());
}
