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
 *     side (`analytics`, `comprehensive`, `summaries-slice`) decides
 *     whether to fall through to the live aggregator + persist-on-miss
 *     via its own per-tier freshness probe.
 *
 * Repair contract: a recompute REPLACES every bucket in the window it was
 * asked for. That includes buckets the live aggregate returns nothing for —
 * without it, a bucket outlives the rows it was folded from. See the
 * `deleteWhere` note in `persistRollupRows` for the three shapes that hole
 * took. Nothing here reads both tiers; the rollup replaces the legacy read and
 * falls back to live SQL only on a coverage miss.
 */
import { prisma } from "@/lib/db";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";
import {
  readCanonicalRollupBuckets,
  REGRESSION_X_ORIGIN_DAYS,
  utcBucketEnd,
  utcBucketStart,
} from "@/lib/rollups/measurement-read";
import { HOURLY_MEAN_DAY_TYPES } from "@/lib/measurements/day-statistic";
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
 * v1.21.0 — rebased epoch-day x for the regression accumulators.
 *
 * `sum_x / sum_xy / sum_xx` store x RELATIVE to `REGRESSION_X_ORIGIN_DAYS`
 * (epoch-days of 2020-01-01) so the squared terms stay O(1e7) instead of the
 * O(1e10) the raw epoch-day (x ≈ 20 540) basis produced — squaring a ~20 540 x
 * sheds ~10 of double's significant decimal digits BEFORE the sum is stored,
 * losing the sub-day x detail at write time. Slope / r² / sd are invariant under
 * the x-shift, so the live REGR_* probe (which stays on raw epoch-days) still
 * matches the cross-bucket compose. The `slope` / `r2` per-bucket columns also
 * stay on raw epoch-days (shift-invariant; their stored values are unchanged).
 *
 * `REGRESSION_X_ORIGIN_DAYS` is a trusted compile-time integer; assert it stays
 * one at SQL-build time before splicing it in (no user-input surface). Built
 * lazily inside `runRollupAggregate` rather than at module init so a partial
 * test mock of `measurement-read` can't trip the assertion before the SQL runs.
 */
function rebasedX(): string {
  if (!Number.isInteger(REGRESSION_X_ORIGIN_DAYS)) {
    throw new Error("REGRESSION_X_ORIGIN_DAYS must be an integer");
  }
  return `(EXTRACT(EPOCH FROM m."measured_at") / 86400.0 - ${REGRESSION_X_ORIGIN_DAYS})`;
}

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

/**
 * Trailing fold window for `recomputeUserRollups` defaults AND the
 * boot-time discovery scan. The two MUST share this bound: the fold
 * only writes buckets inside it, so a discovery scan over unbounded
 * history would re-flag any account whose oldest measurement pre-dates
 * the window and re-run the full backfill on every worker boot without
 * ever converging. Measurements older than the window deliberately
 * never get buckets — the read tier falls back to live SQL for them.
 */
export const ROLLUP_FOLD_WINDOW_MS = 5 * 365 * 24 * 60 * 60 * 1000;

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
  source: string;
  bucket_start: Date;
  count: bigint;
  mean: number | null;
  min_value: number | null;
  max_value: number | null;
  sum_value: number | null;
  sd: number | null;
  slope: number | null;
  r2: number | null;
  // v1.20.0 F6 — per-bucket OLS regression accumulators (epoch-day x-axis).
  // See `MeasurementRollup.sumX` doc in schema.prisma. These let the
  // windowed slope / r² / sd compose from summed accumulators across DAY
  // buckets with bit-identical parity to live REGR_*/STDDEV_POP.
  sum_x: number | null;
  sum_xy: number | null;
  sum_xx: number | null;
  sum_yy: number | null;
}

/**
 * Recompute the rollup buckets for one user. Bounded by the optional
 * `types` / `granularities` / `from` / `to` filters; defaults cover
 * every type, every granularity, and the trailing 5 years.
 *
 * Idempotent: rows are delete-then-inserted per source under the
 * `(userId, type, granularity, bucketStart, source)` composite primary
 * key, so re-running the call refreshes the affected buckets and drops
 * any per-source row whose source no longer reports that bucket.
 */
export async function recomputeUserRollups(
  userId: string,
  opts: {
    types?: MeasurementType[];
    granularities?: RollupGranularity[];
    from?: Date;
    to?: Date;
    /**
     * Run every statement of the fold under this limit instead of the
     * per-connection request limit (`src/lib/db.ts`, 60 s by default).
     * For callers that fold a whole account outside a request: the restore
     * rebuilds five years of buckets right after writing up to millions of
     * readings, and on a slow disk one granularity's aggregate can run past
     * the request limit, which left the account's charts empty until the
     * next boot backfill (#1031). Scoped with SET LOCAL to a transaction per
     * statement group, so it ends with it.
     */
    statementTimeoutMs?: number;
  } = {},
): Promise<{ rowsUpserted: number; durationMs: number }> {
  const startedAt = Date.now();
  const granularities = opts.granularities ?? ALL_GRANULARITIES;
  const fiveYearsAgo = new Date(Date.now() - ROLLUP_FOLD_WINDOW_MS);
  const from = opts.from ?? fiveYearsAgo;
  const to = opts.to ?? new Date();

  let rowsUpserted = 0;

  for (const granularity of granularities) {
    // Snap the window out to whole buckets before aggregating. The
    // aggregate filters rows by `measured_at` but GROUPS by
    // `date_trunc(<granularity>, measured_at)`, and `persistRollupRows`
    // then deletes every rollup row in the [min, max] bucket range it is
    // about to write. A `from` that lands mid-bucket therefore replaced a
    // COMPLETE bucket with an aggregate computed only from the readings
    // after that instant — and because the callers pass a moving instant
    // (`Date.now() - 90d` on the read-path refresh, an arbitrary
    // client-supplied instant on the coverage fallback, `now - 5y` on the
    // boot backfill and the restore path), a different oldest day was
    // corrupted on every invocation and nothing ever repaired it. Same
    // hazard on the `to` edge for any row measured later in the closing
    // bucket. `bucketSpan` is the canonical truncator — its own contract
    // note already required every recompute to cover whole spans; this is
    // the caller that did not.
    const alignedFrom = bucketSpan(from, granularity).from;
    const alignedTo =
      to > alignedFrom
        ? bucketSpan(new Date(to.getTime() - 1), granularity).to
        : bucketSpan(from, granularity).to;
    const aggregateInput = {
      userId,
      types: opts.types,
      granularity,
      from: alignedFrom,
      to: alignedTo,
    };
    const budget = opts.statementTimeoutMs;
    const rows = budget
      ? await prisma.$transaction(
          async (tx) => {
            await applyStatementBudget(tx, budget);
            return runRollupAggregate(aggregateInput, tx);
          },
          { maxWait: 10_000, timeout: budget + 30_000 },
        )
      : await runRollupAggregate(aggregateInput);
    // No `continue` on an empty aggregate: an empty result is a STATEMENT —
    // this window holds no readings any more — and the prune below is what
    // acts on it. Skipping the write here is what let a bucket outlive its
    // source rows.
    rowsUpserted += await persistRollupRows(
      userId,
      granularity,
      rows,
      { from: alignedFrom, to: alignedTo, types: opts.types },
      opts.statementTimeoutMs,
    );
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
    // No prune scope: this call owns exactly one (type, day) bucket and the
    // branch above already deletes it by hand when the day emptied out.
    await persistRollupRows(userId, "DAY", rows, null);
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
    //
    // The key only does that because the queue carries the `short` policy
    // (see `reminder/register-rollup.ts`); under pg-boss's default `standard`
    // policy nothing indexes `singleton_key` and this key coalesced nothing,
    // which is how a large sync came to fan out thousands of jobs re-deriving
    // byte-identical rows. `short` collapses sends only while an identical job
    // is still QUEUED — safe here precisely because the handler re-reads the
    // bucket's live rows when it starts, so the queued job still sees writes
    // that land after it was enqueued.
    singletonKey: `${input.userId}|${input.type}|${input.granularity}|${input.from.toISOString()}`,
  });
}

/**
 * Read rollup rows for `(userId, type, granularity)` in `[from, to)`.
 * Returns rows sorted ascending by `bucketStart`.
 *
 * Rows are stored per source. Every granularity is built from the DAY tier,
 * collapsed to the ladder-canonical source per DAY and then folded into the
 * requested bucket (`readCanonicalRollupBuckets`), so the return shape stays
 * one row per bucket and a coarse bucket counts every day it covers.
 * Pass `userPriorityJson` to avoid a per-call user lookup when the caller
 * already loaded it (e.g. a loop over many types); omit it to lazy-load.
 */
export async function readRollupBuckets(
  userId: string,
  type: MeasurementType,
  granularity: RollupGranularity,
  from: Date,
  to: Date,
  userPriorityJson?: unknown,
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
  const rows = await readCanonicalRollupBuckets({
    userId,
    type,
    granularity,
    from,
    to,
    userPriorityJson,
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

// ─── internals ────────────────────────────────────────────

/**
 * Pull the raw aggregates from Postgres. Groups by
 * `date_trunc(<granularity>, measured_at)` and folds the stats with
 * `STDDEV_POP` / `REGR_SLOPE` / `REGR_R2`. The slope X-axis is days
 * (epoch / 86400) so the slope is in "units per day", matching the
 * comprehensive-aggregator + summaries-slice convention.
 */
/** Give the statements of a transaction their own limit (SET LOCAL). */
async function applyStatementBudget(
  tx: Pick<typeof prisma, "$executeRaw">,
  ms: number,
): Promise<void> {
  const value = String(Math.max(1, Math.ceil(ms)));
  await tx.$executeRaw`SELECT set_config('statement_timeout', ${value}, true), set_config('idle_in_transaction_session_timeout', ${value}, true)`;
}

async function runRollupAggregate(
  input: {
    userId: string;
    types: MeasurementType[] | undefined;
    granularity: RollupGranularity;
    from: Date;
    to: Date;
  },
  db: Pick<typeof prisma, "$queryRawUnsafe"> = prisma,
): Promise<RollupRow[]> {
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

  // v1.21.0 — rebased epoch-day x for the regression accumulators (see the
  // `rebasedX` doc). Built per-call so the assertion fires with the real module.
  const REBASED_X = rebasedX();

  if (input.types && input.types.length > 0) {
    // Build the type-list literal carefully. The enum values come
    // from `MeasurementType` (Prisma-generated TS enum); we whitelist
    // them with a strict regex before splicing into SQL.
    for (const t of input.types) {
      // Enum members can carry digits (e.g. VO2_MAX) — allow 0-9 so a
      // legitimate type is not rejected on the write-hook's typed recompute.
      if (!/^[A-Z0-9_]+$/.test(t)) {
        throw new Error(`invalid measurement type: ${t}`);
      }
    }
    const typeList = input.types
      .map((t) => `'${t}'::"measurement_type"`)
      .join(",");
    const sql = `
      SELECT
        m."type"::text                                            AS type,
        m."source"::text                                          AS source,
        ${dateTrunc}                                              AS bucket_start,
        COUNT(*)                                                  AS count,
        AVG(m."value")::double precision                          AS mean,
        MIN(COALESCE(m."value_min", m."value"))::double precision AS min_value,
        MAX(COALESCE(m."value_max", m."value"))::double precision AS max_value,
        SUM(m."value")::double precision                          AS sum_value,
        STDDEV_POP(m."value")::double precision                   AS sd,
        REGR_SLOPE(
          m."value",
          EXTRACT(EPOCH FROM m."measured_at") / 86400.0
        )::double precision                                       AS slope,
        REGR_R2(
          m."value",
          EXTRACT(EPOCH FROM m."measured_at") / 86400.0
        )::double precision                                       AS r2,
        -- v1.20.0 F6 — regression accumulators. Summed per (type, source,
        -- bucket) here so the read tier composes the windowed slope / r2 / sd
        -- across DAY buckets without a live scan. value is NOT NULL on
        -- measurements, so every row contributes; the sums are over the same
        -- rows REGR_/STDDEV_POP fold above.
        -- v1.21.0 — x is REBASED to REGRESSION_X_ORIGIN_DAYS so sum_xx stays
        -- O(1e7) and never sheds precision squaring a ~20 540 epoch-day. Slope
        -- / r² / sd are shift-invariant, so the live (raw-epoch) REGR_* probe
        -- still parity-matches the cross-bucket compose.
        SUM(${REBASED_X})::double precision                       AS sum_x,
        SUM(${REBASED_X} * m."value")::double precision           AS sum_xy,
        SUM(${REBASED_X} * ${REBASED_X})::double precision        AS sum_xx,
        SUM(m."value" * m."value")::double precision              AS sum_yy
      FROM measurements m
      WHERE m."user_id" = $1
        AND m."type" IN (${typeList})
        AND m."measured_at" >= $2
        AND m."measured_at" <  $3
        AND m."deleted_at" IS NULL
      GROUP BY m."type", m."source", ${dateTrunc}
    `;
    return applyHourlyMeanDay(
      db,
      input,
      await db.$queryRawUnsafe<RollupRow[]>(
        sql,
        input.userId,
        input.from,
        input.to,
      ),
    );
  }

  const sql = `
    SELECT
      m."type"::text                                            AS type,
      m."source"::text                                          AS source,
      ${dateTrunc}                                              AS bucket_start,
      COUNT(*)                                                  AS count,
      AVG(m."value")::double precision                          AS mean,
      MIN(COALESCE(m."value_min", m."value"))::double precision AS min_value,
      MAX(COALESCE(m."value_max", m."value"))::double precision AS max_value,
      SUM(m."value")::double precision                          AS sum_value,
      STDDEV_POP(m."value")::double precision                   AS sd,
      REGR_SLOPE(
        m."value",
        EXTRACT(EPOCH FROM m."measured_at") / 86400.0
      )::double precision                                       AS slope,
      REGR_R2(
        m."value",
        EXTRACT(EPOCH FROM m."measured_at") / 86400.0
      )::double precision                                       AS r2,
      -- v1.20.0 F6 — regression accumulators. See the typed-list query above
      -- for the rationale; the read tier composes windowed slope / r² / sd from
      -- these summed across DAY buckets.
      -- v1.21.0 — x is REBASED to REGRESSION_X_ORIGIN_DAYS (see above) so the
      -- squared terms stay exact; slope / r² / sd are shift-invariant.
      SUM(${REBASED_X})::double precision                       AS sum_x,
      SUM(${REBASED_X} * m."value")::double precision           AS sum_xy,
      SUM(${REBASED_X} * ${REBASED_X})::double precision        AS sum_xx,
      SUM(m."value" * m."value")::double precision              AS sum_yy
    FROM measurements m
    WHERE m."user_id" = $1
      AND m."measured_at" >= $2
      AND m."measured_at" <  $3
      AND m."deleted_at" IS NULL
    GROUP BY m."type", m."source", ${dateTrunc}
  `;
  return applyHourlyMeanDay(
    db,
    input,
    await db.$queryRawUnsafe<RollupRow[]>(
      sql,
      input.userId,
      input.from,
      input.to,
    ),
  );
}

/**
 * For a type whose DAY value is the mean of its per-hour means (see
 * `day-statistic.ts`), replace the bucket's `mean`: a DAY bucket's is the mean
 * of its hours' means, a WEEK / MONTH / YEAR bucket's the mean of its days'
 * values, each day once. The coarse rows are not read for their mean (every
 * coarse read folds the DAY tier, `readCanonicalRollupBuckets`), but a stored
 * row should not contradict the tier it is folded from. Only `mean` changes:
 * `count`, `min`, `max` and the sums the regression composes from stay over
 * every reading, so the band and the windowed slope are untouched.
 *
 * Hours and days are UTC, matching the UTC day this tier buckets by; migration
 * 0372 applies the same statistic to rows stored before it.
 */
async function applyHourlyMeanDay(
  db: Pick<typeof prisma, "$queryRawUnsafe">,
  input: {
    userId: string;
    granularity: RollupGranularity;
    from: Date;
    to: Date;
  },
  rows: RollupRow[],
): Promise<RollupRow[]> {
  const truncUnit = DATE_TRUNC_UNIT[input.granularity];
  if (!["day", "week", "month", "year"].includes(truncUnit)) {
    throw new Error(`unexpected granularity: ${input.granularity}`);
  }
  const types = [
    ...new Set(
      rows
        .map((r) => r.type)
        .filter((t) => HOURLY_MEAN_DAY_TYPES.has(t as MeasurementType)),
    ),
  ];
  if (types.length === 0) return rows;
  for (const t of types) {
    if (!/^[A-Z0-9_]+$/.test(t)) {
      throw new Error(`invalid measurement type: ${t}`);
    }
  }
  const typeList = types.map((t) => `'${t}'::"measurement_type"`).join(",");
  const means = await db.$queryRawUnsafe<
    Array<{ type: string; source: string; bucket_start: Date; mean: number }>
  >(
    `
    SELECT d."type"::text AS type,
           d."source"::text AS source,
           date_trunc('${truncUnit}', d.day) AS bucket_start,
           AVG(d.day_mean)::double precision AS mean
    FROM (
      SELECT h."type", h."source",
             date_trunc('day', h.hr) AS day,
             AVG(h.hour_mean) AS day_mean
      FROM (
        SELECT m."type", m."source",
               date_trunc('hour', m."measured_at") AS hr,
               AVG(m."value") AS hour_mean
        FROM measurements m
        WHERE m."user_id" = $1
          AND m."type" IN (${typeList})
          AND m."measured_at" >= $2
          AND m."measured_at" <  $3
          AND m."deleted_at" IS NULL
        GROUP BY m."type", m."source", date_trunc('hour', m."measured_at")
      ) h
      GROUP BY 1, 2, 3
    ) d
    GROUP BY 1, 2, 3
  `,
    input.userId,
    input.from,
    input.to,
  );
  const byKey = new Map(
    means.map((m) => [
      `${m.type}|${m.source}|${new Date(m.bucket_start).getTime()}`,
      m.mean,
    ]),
  );
  return rows.map((r) => {
    const mean = byKey.get(
      `${r.type}|${r.source}|${new Date(r.bucket_start).getTime()}`,
    );
    return mean === undefined ? r : { ...r, mean };
  });
}

/**
 * The window a recompute authoritatively re-derived. Every rollup bucket inside
 * it is replaced by the freshly computed rows — including buckets the aggregate
 * returned NOTHING for, which is the only way a bucket whose source rows all
 * disappeared can be removed. `types` narrows the prune to the types the
 * aggregate was scoped to; `undefined` means it covered every type.
 */
interface PruneScope {
  from: Date;
  to: Date;
  types?: MeasurementType[];
}

/**
 * Delete scope for a caller that wrote a single known bucket rather than a
 * re-derived window: the [min, max] bucket range of the rows themselves, per
 * type. Correct there precisely because the caller already knows which bucket
 * it touched and deletes it by hand when the aggregate comes back empty.
 */
function buildReturnedRangeDeleteWhere(
  userId: string,
  granularity: RollupGranularity,
  rows: RollupRow[],
) {
  const types = [...new Set(rows.map((r) => r.type as MeasurementType))];
  let minBucket = rows[0]!.bucket_start;
  let maxBucket = rows[0]!.bucket_start;
  for (const r of rows) {
    if (r.bucket_start < minBucket) minBucket = r.bucket_start;
    if (r.bucket_start > maxBucket) maxBucket = r.bucket_start;
  }
  return {
    userId,
    granularity,
    type: { in: types },
    bucketStart: { gte: minBucket, lte: maxBucket },
  };
}

/**
 * UPSERT the aggregate rows into `measurement_rollups`. Returns the
 * number of rows touched. Uses a chunked raw insert with
 * `ON CONFLICT DO UPDATE` so the round-trip count is bounded
 * regardless of fan-out width AND a concurrent writer on the same
 * partition can never raise a unique violation.
 *
 * `prune` is the recomputed window when the caller re-derived a whole span
 * (`recomputeUserRollups`), or `null` when it wrote a single known bucket and
 * handles its own empty case (`recomputeBucketsForMeasurement`). See the
 * `deleteWhere` note below for why the distinction matters.
 */
async function persistRollupRows(
  userId: string,
  granularity: RollupGranularity,
  rows: RollupRow[],
  prune: PruneScope | null,
  statementTimeoutMs?: number,
): Promise<number> {
  // v1.11.1 — rows are now minted per source. Delete-then-upsert the affected
  // (type, bucket) partitions across ALL sources before writing, so a source
  // that disappeared from a bucket (the user disconnected a provider, or
  // deleted the last reading from one device) does not strand a stale
  // per-source row that a plain upsert would never revisit.
  //
  // The delete is scoped to the RECOMPUTED WINDOW when the caller supplies one,
  // not to the [min, max] range of the rows coming back. Scoping it to the
  // returned rows made the repair self-limiting in exactly the case that needs
  // it: a recompute can only ever overwrite a bucket the live aggregate still
  // produces, so a bucket whose source rows all disappeared was never in the
  // delete range and survived with its stale aggregate. Three shapes of the
  // same hole — an empty aggregate skipped the write entirely, a returned range
  // narrower than the requested window left the edges untouched, and a type
  // that lost every reading dropped out of `type: { in: … }` altogether. The
  // WEEK / MONTH / YEAR worker hit all three: deleting the last reading of a
  // type in a week dropped the DAY bucket (the write hook deletes that one by
  // hand) while the coarser buckets kept the stale aggregate forever, and the
  // coverage probe still reported `hasBuckets = true` so the read-swap served
  // them instead of falling back to live SQL.
  const pruneWhere = prune
    ? {
        userId,
        granularity,
        ...(prune.types ? { type: { in: prune.types } } : {}),
        bucketStart: { gte: prune.from, lt: prune.to },
      }
    : null;

  if (rows.length === 0) {
    // Nothing to write. With a prune scope there is still work to do: the
    // window is authoritatively empty, so every bucket in it must go. No
    // transaction needed — there is no insert leg that could leave a gap.
    if (!pruneWhere) return 0;
    await prisma.measurementRollup.deleteMany({ where: pruneWhere });
    return 0;
  }

  const deleteWhere =
    pruneWhere ?? buildReturnedRangeDeleteWhere(userId, granularity, rows);

  // v1.28.33 (issue #486) — the insert leg is a raw
  // `INSERT … ON CONFLICT (pk) DO UPDATE` instead of `createMany`. The
  // synchronous DAY hook carries no pg-boss singleton, so a write hook
  // can race the end-of-import full fold (or a second hook) on the same
  // (user, type, day, source) partition: under READ COMMITTED the
  // loser's delete leg cannot see the winner's still-uncommitted rows,
  // and its plain insert then tripped `measurement_rollups_pkey`
  // (Postgres 23505). The previous shape swallowed that P2002 and
  // DROPPED the loser's freshly computed aggregate — wrong whenever the
  // loser had already seen newer measurements than the winner: the
  // bucket kept the stale aggregate until the next unrelated write.
  // `DO UPDATE` makes the write last-write-wins: every recompute lands
  // its own freshly computed values, so the later writer overwrites the
  // earlier one and no interleaving can raise or drop. The rows are
  // sorted on (type, source, bucket) so two concurrent multi-row
  // upserts take their row locks in the same order and cannot deadlock.
  const ordered = [...rows].sort((a, b) =>
    a.type !== b.type
      ? a.type < b.type
        ? -1
        : 1
      : a.source !== b.source
        ? a.source < b.source
          ? -1
          : 1
        : a.bucket_start.getTime() - b.bucket_start.getTime(),
  );

  // Chunk to keep the parameter count below Postgres' 65k cap and the
  // round-trip count bounded for large backfills.
  const CHUNK = 500;

  // Delete the partition range and upsert the chunks inside ONE
  // interactive transaction. Pre-v1.16.10 the deleteMany committed
  // standalone before the chunk loop: a concurrent write-hook insert
  // landing mid-loop aborted the loop, the delete stayed committed —
  // and every type in the window lost ALL its buckets until the next
  // race-free fold (the coverage probe then cycled covered/uncovered
  // as the boot backfill re-raced the hooks). The transaction keeps
  // the delete invisible until every chunk landed; the ON CONFLICT
  // upsert absorbs a hook row that commits between two chunks — READ
  // COMMITTED lets a later statement see it — without aborting the
  // batch.
  //
  // Transaction sizing: one call covers ONE granularity, so the worst
  // case is the full 5-year DAY fold of a multi-source power user —
  // tens of thousands of rows in 500-row chunks, well inside Postgres
  // limits but potentially slow on self-host disks. A per-type
  // transaction was considered and rejected: it would re-open the
  // committed-delete gap between types sharing the bucket range. The
  // 120 s timeout (Prisma default: 5 s) covers the chunk round-trips
  // with headroom; the incremental hook path is a single sub-500-row
  // chunk and finishes far inside it.
  let touched = 0;
  await prisma.$transaction(
    async (tx) => {
      if (statementTimeoutMs)
        await applyStatementBudget(tx, statementTimeoutMs);
      await tx.measurementRollup.deleteMany({ where: deleteWhere });
      for (let i = 0; i < ordered.length; i += CHUNK) {
        const slice = ordered.slice(i, i + CHUNK);
        const { sql, params } = buildRollupUpsert(userId, granularity, slice);
        touched += await tx.$executeRawUnsafe(sql, ...params);
      }
    },
    {
      maxWait: 10_000,
      timeout: Math.max(120_000, (statementTimeoutMs ?? 0) + 30_000),
    },
  );
  return touched;
}

/**
 * Build the chunked `INSERT … ON CONFLICT DO UPDATE` statement for one
 * slice of aggregate rows. Every value travels as a positional `$N`
 * parameter — nothing from the rows is spliced into the SQL text; the
 * only literals are the fixed column list and the enum type names.
 */
function buildRollupUpsert(
  userId: string,
  granularity: RollupGranularity,
  rows: RollupRow[],
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const tuples: string[] = [];
  const computedAt = new Date();
  for (const row of rows) {
    const base = params.length;
    params.push(
      userId,
      row.type,
      granularity,
      row.bucket_start,
      row.source,
      Number(row.count),
      row.mean ?? 0,
      row.min_value ?? 0,
      row.max_value ?? 0,
      // v1.4.39 W-SUM — populate for every type. Cumulative read paths
      // (steps, flights, distance, daylight, active-energy) consume this
      // column directly; spot metrics carry it for free because the
      // underlying SUM aggregator runs in the same query as AVG/MIN/MAX.
      row.sum_value ?? null,
      row.sd,
      row.slope,
      row.r2,
      // v1.20.0 F6 — persist the regression accumulators alongside the
      // existing stats; they ride the same aggregate (no extra round-trip).
      row.sum_x ?? null,
      row.sum_xy ?? null,
      row.sum_xx ?? null,
      row.sum_yy ?? null,
      computedAt,
    );
    tuples.push(
      `($${base + 1}, $${base + 2}::"measurement_type", $${base + 3}::"measurement_rollup_granularity", ` +
        `$${base + 4}::timestamptz, $${base + 5}::"measurement_source", $${base + 6}::int, ` +
        `$${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, ` +
        `$${base + 13}, $${base + 14}, $${base + 15}, $${base + 16}, $${base + 17}, $${base + 18}::timestamptz)`,
    );
  }
  const sql = `
    INSERT INTO measurement_rollups
      (user_id, type, granularity, bucket_start, source, count, mean,
       min_value, max_value, sum_value, sd, slope, r2,
       sum_x, sum_xy, sum_xx, sum_yy, computed_at)
    VALUES ${tuples.join(", ")}
    ON CONFLICT (user_id, type, granularity, bucket_start, source)
    DO UPDATE SET
      count       = EXCLUDED.count,
      mean        = EXCLUDED.mean,
      min_value   = EXCLUDED.min_value,
      max_value   = EXCLUDED.max_value,
      sum_value   = EXCLUDED.sum_value,
      sd          = EXCLUDED.sd,
      slope       = EXCLUDED.slope,
      r2          = EXCLUDED.r2,
      sum_x       = EXCLUDED.sum_x,
      sum_xy      = EXCLUDED.sum_xy,
      sum_xx      = EXCLUDED.sum_xx,
      sum_yy      = EXCLUDED.sum_yy,
      computed_at = EXCLUDED.computed_at
  `;
  return { sql, params };
}

/**
 * Span of the bucket containing `measuredAt` at the given granularity.
 * Postgres `date_trunc` is the canonical truncator; we mirror its
 * Monday-anchored ISO week and calendar-month / calendar-year
 * semantics in JS so the worker re-aggregation queries select the
 * same set of rows the read-side `date_trunc` would group on.
 *
 * Exported for callers that enqueue their own `enqueueRollupRecompute`
 * (the dense-tier hourly rebuild) — a recompute over a PARTIAL bucket
 * span would replace the full bucket with a partial aggregate, so every
 * enqueue must cover the whole span this helper resolves.
 */
export function bucketSpan(
  measuredAt: Date,
  granularity: RollupGranularity,
): { from: Date; to: Date } {
  return {
    from: utcBucketStart(measuredAt, granularity),
    to: utcBucketEnd(measuredAt, granularity),
  };
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
      // Deliberately NOT filtered to `deletedAt: null`: a soft-delete
      // bumps `updatedAt` on the tombstone, and that bump is exactly the
      // staleness signal — filtering tombstones out made a deletion
      // invisible to the probe and left the ghost aggregate "fresh".
      prisma.measurement.findFirst({
        where: { userId },
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
export async function enqueueBootTimeRollupBackfill(
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
    // has been retired. The maintainer's tenant converged at v1.4.40, so the
    // arm was a permanent no-op seq scan over `measurement_rollups`.
    // Per-day missing coverage remains the sole discovery anchor.
    //
    // v1.16.10 — discovery is bounded to the same trailing window the
    // fold writes (`ROLLUP_FOLD_WINDOW_MS`). Unbounded, any account
    // with measurements older than the window was re-flagged on every
    // boot: the fold can never produce buckets for those days, so the
    // per-day gap re-surfaced forever and the full backfill re-ran on
    // every restart. Days outside the window are not foldable by
    // design and must not anchor discovery.
    const foldWindowStart = new Date(Date.now() - ROLLUP_FOLD_WINDOW_MS);
    // Two discovery arms, UNION-ed:
    //
    //   1. Per-day MISSING coverage — a (user, type, day) pair in
    //      `measurements` with no matching DAY rollup row (v1.4.39.1).
    //
    //   2. v1.20.0 F6 NULL-accumulator arm — a user whose DAY rollup rows
    //      predate migration 0190 (regression accumulators are NULL) needs a
    //      one-time re-fold so the windowed slope / r² / sd readers compose
    //      from the accumulators instead of falling back to the live REGR_*
    //      scan. Anchored on `sum_xy IS NULL` (the column the read tier
    //      treats as the coverage marker). New writes self-populate the
    //      accumulators, so this arm drains to empty once the boot re-fold
    //      catches up — mirrors the v1.4.39 sum_value rollout, which the
    //      v1.4.41 note confirms converged via this same boot queue. Bounded
    //      to the fold window so days outside it (un-foldable by design)
    //      never re-flag a user on every boot.
    const users = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT id FROM (
        SELECT DISTINCT mt."user_id" AS id
        FROM (
          SELECT DISTINCT
            m."user_id",
            m."type",
            date_trunc('day', m."measured_at") AS bucket_start
          FROM measurements m
          WHERE m."deleted_at" IS NULL
            AND m."measured_at" >= ${foldWindowStart}
        ) mt
        LEFT JOIN measurement_rollups r
          ON  r."user_id"     = mt."user_id"
          AND r."type"        = mt."type"
          AND r."granularity" = 'DAY'
          AND r."bucket_start" = mt."bucket_start"
        WHERE r."bucket_start" IS NULL

        UNION

        SELECT DISTINCT r."user_id" AS id
        FROM measurement_rollups r
        WHERE r."granularity" = 'DAY'
          AND r."bucket_start" >= ${foldWindowStart}
          AND r."sum_xy" IS NULL
      ) discovered
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
