/**
 * Shared base for the three per-user-day consolidation drains:
 *   - `drain-per-sample-cumulative.ts` (SUM, hard-delete)
 *   - `consolidate-daily-mean.ts`      (MEAN, soft-delete)
 *   - `consolidate-legacy-steps.ts`    (SUM, soft-delete, existing-total skip)
 *
 * All three walk the same skeleton: load the user set, resolve each
 * user's timezone, scan live source rows for a type set inside an
 * optional grace window, group the rows into per-day buckets in the
 * user's timezone, reduce each day's values, then mint one canonical
 * `stats:<HKIdentifier>:<YYYY-MM-DD>` daily row and drop the source rows.
 *
 * The drains diverge on the reducer (sum vs mean), the delete strategy
 * (hard vs soft), the source-scope filter, the canonical-unit resolution,
 * the mint `source`, and — for the legacy-step pass only — an
 * existing-total skip plus a P2002 conflict step-over. This module owns
 * the common machinery and parameterises the divergent parts through the
 * `runConsolidation` driver below; each drain stays a thin caller that
 * supplies its reducer/types and keeps its own public summary shape.
 *
 * The timezone day-math helpers (`dayKeyForUserTz`,
 * `canonicalDailyTimestamp`, `localStartOfDay`, `localDayWindow`), the
 * `PerSampleRow` shape, and `CONSOLIDATION_GRACE_CUTOFF_HOURS` all live
 * in the dependency-free leaf `consolidation-tz.ts`. Both this module
 * and `drain-per-sample-cumulative.ts` import them from there, so there
 * is no value-level cycle between the two — a cycle would otherwise trip
 * a module-init TDZ in the production bundle.
 */
import type {
  MeasurementType,
  PrismaClient,
  Prisma,
} from "@/generated/prisma/client";

import { reportJobProgress } from "@/lib/jobs/job-observer";

import {
  CONSOLIDATION_GRACE_CUTOFF_HOURS,
  canonicalDailyTimestamp,
  dayKeyForUserTz,
  type PerSampleRow,
} from "./consolidation-tz";

// Re-export the shared grace constant so the established
// `consolidation-base` import surface stays unchanged for callers.
export { CONSOLIDATION_GRACE_CUTOFF_HOURS };

/** Fallback timezone for users with no `User.timezone` set. */
const DEFAULT_TIMEZONE = "Europe/Berlin";

/**
 * Options shared by every drain. Each drain re-exports its own alias of
 * this shape so the call sites and tests keep their established names.
 */
export interface ConsolidationOptions {
  /** Limit the pass to a single user. Default = every user. */
  userId?: string;
  /** Preview-only mode — no DB writes. */
  dryRun?: boolean;
  /** Logger sink — defaults to `console.log`. */
  log?: (line: string) => void;
  /**
   * Asked before every day bucket. Returning `true` ends the pass cleanly
   * after the day in flight has committed, and the result reports
   * `stoppedEarly`. The queue handlers wire it to the job's time budget and
   * to pg-boss's abort signal, so a pass that cannot finish inside its expiry
   * stops on its own instead of being declared dead while it keeps writing.
   *
   * Stopping loses nothing: every day commits on its own, and a folded day's
   * source rows leave the scan predicate, so the next run starts at the first
   * day this one did not reach.
   */
  shouldStop?: () => boolean;
}

/**
 * Resolve a user's effective timezone, falling back to `Europe/Berlin`
 * for an empty / null value.
 */
export function resolveUserTimezone(timezone: string | null): string {
  return timezone && timezone.length > 0 ? timezone : DEFAULT_TIMEZONE;
}

/**
 * Compute the cutoff instant for a grace window. Returns `null` when no
 * positive `cutoffHours` is supplied (drain everything the caller points
 * at), matching the one-shot / CLI default the drains carry.
 */
export function resolveCutoffInstant(
  cutoffHours: number | undefined,
): Date | null {
  return typeof cutoffHours === "number" && cutoffHours > 0
    ? new Date(Date.now() - cutoffHours * 60 * 60 * 1000)
    : null;
}

/**
 * Load the `{ id, timezone }` set the pass walks — a single user when
 * `userId` is set, every user otherwise. Identical query across all
 * three drains.
 */
export async function loadConsolidationUsers(
  prismaClient: PrismaClient,
  userId: string | undefined,
): Promise<Array<{ id: string; timezone: string | null }>> {
  return userId
    ? prismaClient.user.findMany({
        where: { id: userId },
        select: { id: true, timezone: true },
      })
    : prismaClient.user.findMany({
        select: { id: true, timezone: true },
      });
}

/**
 * Group an array of per-sample rows into per-day buckets keyed by the
 * user's timezone. Rows already in the daily-stats shape (externalId
 * starting with `statsPrefix`) are skipped — re-running on a
 * previously-collapsed bucket is a no-op. This is the single bucketing
 * implementation behind `bucketRowsByUserDay`, `bucketMeanRows`, and
 * `bucketLegacyStepRows`; the only thing that varied between them was the
 * prefix they skip on.
 */
export function bucketRowsByDay(
  rows: readonly PerSampleRow[],
  tz: string,
  statsPrefix: string,
): Map<string, PerSampleRow[]> {
  const byDay = new Map<string, PerSampleRow[]>();
  for (const row of rows) {
    if (row.externalId !== null && row.externalId.startsWith(statsPrefix)) {
      continue;
    }
    const key = dayKeyForUserTz(row.measuredAt, tz);
    const slot = byDay.get(key) ?? [];
    slot.push(row);
    byDay.set(key, slot);
  }
  return byDay;
}

/** Outcome of writing a single per-day bucket. */
export type DayWriteOutcome =
  { kind: "written"; sourceRowsRemoved: number } | { kind: "skipped-conflict" };

/**
 * Context a per-day write strategy receives. The strategy owns its own
 * `$transaction` so the mint + delete commit atomically — the original
 * drains each wrapped the pair in one transaction and that is preserved.
 */
export interface DayWriteContext {
  prismaClient: PrismaClient;
  userId: string;
  type: MeasurementType;
  externalId: string;
  canonicalTimestamp: Date;
  reducedValue: number;
  dayRows: PerSampleRow[];
  sourceRowIds: string[];
  /**
   * The user's resolved IANA timezone and the bucket's calendar-day key.
   * A drain whose write grain is finer than the day (the dense-tier hourly
   * fold) needs both to derive per-hour sub-buckets; the day-grain drains
   * ignore them.
   */
  tz: string;
  dateKey: string;
}

/** Inputs to one per-user-type-day consolidation pass. */
export interface ConsolidationParams<TType extends MeasurementType> {
  prismaClient: PrismaClient;
  options: ConsolidationOptions & { cutoffHours?: number };
  /** Types the pass scans. Accepts an array or a `ReadonlySet`. */
  types: Iterable<TType>;
  /** Maps a type to its canonical HealthKit identifier, or `null` to skip. */
  hkIdentifierForType: (type: TType) => string | null;
  /** Builds the daily `stats:<HKIdentifier>:<dateKey>` externalId. */
  dailyStatsExternalId: (hkIdentifier: string, dateKey: string) => string;
  /** Prefix marking an already-collapsed daily-stats row. */
  statsPrefix: string;
  /** Reduce a non-empty per-day bucket to its canonical value. */
  reduce: (rows: readonly PerSampleRow[]) => number;
  /**
   * Build the per-(user, type) Prisma `where` for the scan, given the
   * grace cutoff (or `null`). Owns the source-scope + soft-delete-filter
   * differences between drains.
   */
  buildScanWhere: (input: {
    userId: string;
    type: TType;
    cutoffAt: Date | null;
    statsPrefix: string;
  }) => Prisma.MeasurementWhereInput;
  /**
   * Columns the scan selects. Mean needs `unit`; the others don't.
   * Defaults to the shared set when omitted.
   */
  scanSelect?: Prisma.MeasurementSelect;
  /**
   * Per-day callback invoked BEFORE the write transaction (dry-run
   * included). Returns `false` to record the bucket but skip the mint
   * (legacy-step existing-total case). Optional; defaults to always-write.
   */
  onBucket?: (input: {
    prismaClient: PrismaClient;
    userId: string;
    type: TType;
    dateKey: string;
    dayRows: PerSampleRow[];
    reducedValue: number;
    canonicalTimestamp: Date;
    externalId: string;
  }) => Promise<boolean> | boolean;
  /**
   * Write one per-day bucket inside the supplied transaction (mint +
   * delete/soft-delete). Owns the hard-vs-soft delete + mint-source
   * differences. `shouldMint` carries the `onBucket` decision.
   */
  writeDay: (
    ctx: DayWriteContext & { shouldMint: boolean },
  ) => Promise<DayWriteOutcome>;
  /**
   * Accumulate a written / previewed bucket into the drain's own summary.
   * Called once per day the pass acts on. `outcome` is `null` on dry-run.
   */
  recordBucket: (input: {
    userId: string;
    type: TType;
    dateKey: string;
    dayRows: PerSampleRow[];
    reducedValue: number;
    canonicalTimestamp: Date;
    externalId: string;
    shouldMint: boolean;
    outcome: DayWriteOutcome | null;
  }) => void;
  /** Per-user log line, START — optional. */
  onUserStart?: (input: {
    userId: string;
    tz: string;
    dryRun: boolean;
  }) => void;
  /**
   * Fired once per (user, type) after the type's rows have been walked,
   * with the raw scanned-row count and per-day bucket count. Only invoked
   * for types that yielded at least one source row. Lets a single-type
   * drain (legacy steps) reproduce its scan-time log line. Optional.
   */
  onScan?: (input: {
    userId: string;
    type: TType;
    tz: string;
    rowCount: number;
    dayCount: number;
    dryRun: boolean;
  }) => void;
  /** Per-user log line, COMPLETE — optional. */
  onUserComplete?: (input: {
    userId: string;
    tz: string;
    dryRun: boolean;
  }) => void;
  /**
   * Per-day failure boundary — optional. When supplied, an error thrown
   * while reducing / writing / recording ONE day bucket is reported here
   * and the walk continues with the next bucket, so a single poisoned day
   * (e.g. a unique-index collision on the mint) can no longer abort the
   * whole global pass and strand every later user / type / day. When
   * omitted, errors propagate exactly as before — drains whose `writeDay`
   * classifies its own errors (and relies on the rethrow reaching pg-boss
   * for a retry) keep their established semantics.
   */
  onBucketError?: (input: {
    userId: string;
    type: TType;
    dateKey: string;
    error: unknown;
  }) => void;
}

const DEFAULT_SCAN_SELECT: Prisma.MeasurementSelect = {
  id: true,
  type: true,
  value: true,
  measuredAt: true,
  externalId: true,
};

/**
 * Page size for the keyset-paginated source-row scan.
 */
const CONSOLIDATION_SCAN_PAGE_SIZE = 5000;

/**
 * Keyset-paginate the per-(user, type) source-row scan on `(measuredAt, id)`
 * ascending, one page at a time.
 *
 * Two properties matter, and both used to be missing.
 *
 * The pages are yielded, not accumulated. The previous helper gathered every
 * page into one array before a single day was folded, so the pass held a
 * type's whole history at once: on an account with 766 000 heart-rate samples
 * that is about 230 MB of live heap for the array alone, most of a 524 MB
 * limit, and nothing was written until the whole scan had finished.
 *
 * The cursor is index-usable. `measuredAt > c OR (measuredAt = c AND id > i)`
 * cannot be an index condition, so Postgres walked the index from the user's
 * first row on every page and filtered its way to the cursor, which makes the
 * whole scan quadratic (measured: 47 ms and 248 000 rows filtered for one
 * page halfway through). The redundant `measuredAt >= c` conjunct is the
 * index condition; the OR only breaks ties at the boundary instant.
 *
 * The caller's `baseWhere` is AND-combined, so the scope / soft-delete /
 * grace filters always still apply.
 */
export async function* iterateSourcePages(
  prismaClient: PrismaClient,
  baseWhere: Prisma.MeasurementWhereInput,
  scanSelect: Prisma.MeasurementSelect,
  pageSize: number = CONSOLIDATION_SCAN_PAGE_SIZE,
): AsyncGenerator<PerSampleRow[], void, void> {
  let cursor: { measuredAt: Date; id: string } | null = null;

  for (;;) {
    const where: Prisma.MeasurementWhereInput = cursor
      ? {
          AND: [
            baseWhere,
            { measuredAt: { gte: cursor.measuredAt } },
            {
              OR: [
                { measuredAt: { gt: cursor.measuredAt } },
                { measuredAt: cursor.measuredAt, id: { gt: cursor.id } },
              ],
            },
          ],
        }
      : baseWhere;

    const page = (await prismaClient.measurement.findMany({
      where,
      select: scanSelect,
      orderBy: [{ measuredAt: "asc" }, { id: "asc" }],
      take: pageSize,
    })) as PerSampleRow[];

    if (page.length === 0) return;

    const last = page[page.length - 1]!;
    const isLastPage = page.length < pageSize;
    yield page;

    // A short page is the last page — no further rows can satisfy the keyset.
    if (isLastPage) return;
    cursor = { measuredAt: last.measuredAt, id: last.id };
  }
}

/**
 * Group a stream of ascending pages into complete per-day buckets, in the
 * user's timezone, without holding more than one day at a time.
 *
 * The rows arrive in `measuredAt` order and a local calendar day is one
 * contiguous span of instants, so a day is complete the moment a row from a
 * later day shows up. Rows already in the daily-stats shape are skipped, the
 * same as `bucketRowsByDay`. `onRow` sees every scanned row, stats rows
 * included, for the scan-count log line.
 */
export async function* iterateDayBuckets(
  pages: AsyncIterable<readonly PerSampleRow[]>,
  tz: string,
  statsPrefix: string,
  onRow?: () => void,
): AsyncGenerator<[dateKey: string, rows: PerSampleRow[]], void, void> {
  let currentKey: string | null = null;
  let current: PerSampleRow[] = [];
  for await (const page of pages) {
    for (const row of page) {
      onRow?.();
      if (row.externalId !== null && row.externalId.startsWith(statsPrefix)) {
        continue;
      }
      const key = dayKeyForUserTz(row.measuredAt, tz);
      if (key !== currentKey) {
        if (currentKey !== null && current.length > 0) {
          yield [currentKey, current];
        }
        currentKey = key;
        current = [];
      }
      current.push(row);
    }
  }
  if (currentKey !== null && current.length > 0) yield [currentKey, current];
}

/**
 * Drive one consolidation pass. Walks `users → types → days`, scans live
 * source rows inside the grace window, buckets them, reduces each day,
 * and delegates the per-day mint + delete to `writeDay`. Returns the
 * number of users scanned (so the caller can seed its summary totals)
 * plus the number of day buckets absorbed by `onBucketError` (0 when the
 * boundary is not supplied), and whether `options.shouldStop` ended the
 * walk before every day was reached.
 *
 * Idempotency, the grace-window cutoff, and the "skip already-collapsed
 * rows" predicate are all owned here; the divergent reducer / delete /
 * scope / summary concerns are supplied by the params.
 */
export async function runConsolidation<TType extends MeasurementType>(
  params: ConsolidationParams<TType>,
): Promise<{
  usersScanned: number;
  dryRun: boolean;
  daysFailed: number;
  stoppedEarly: boolean;
}> {
  const { prismaClient, options } = params;
  const dryRun = options.dryRun ?? false;
  const cutoffAt = resolveCutoffInstant(options.cutoffHours);
  const scanSelect = params.scanSelect ?? DEFAULT_SCAN_SELECT;
  const shouldStop = options.shouldStop ?? (() => false);
  let daysFailed = 0;
  let daysWalked = 0;
  let stoppedEarly = false;

  const users = await loadConsolidationUsers(prismaClient, options.userId);

  walk: for (const user of users) {
    const tz = resolveUserTimezone(user.timezone);
    params.onUserStart?.({ userId: user.id, tz, dryRun });

    for (const type of params.types) {
      const hkIdentifier = params.hkIdentifierForType(type);
      if (!hkIdentifier) continue;

      // Streamed: each day is folded as soon as its last row has been read,
      // so the pass holds one page and one day, never the type's history.
      // See `iterateSourcePages` and `iterateDayBuckets`.
      let rowCount = 0;
      let dayCount = 0;
      const days = iterateDayBuckets(
        iterateSourcePages(
          prismaClient,
          params.buildScanWhere({
            userId: user.id,
            type,
            cutoffAt,
            statsPrefix: params.statsPrefix,
          }),
          scanSelect,
        ),
        tz,
        params.statsPrefix,
        () => {
          rowCount += 1;
        },
      );

      for await (const [dateKey, dayRows] of days) {
        if (shouldStop()) {
          stoppedEarly = true;
          // Leaving the loop closes both generators, so no further page is
          // requested.
          break walk;
        }
        dayCount += 1;
        daysWalked += 1;
        // How far the pass has got, for the job's progress and expiry lines.
        reportJobProgress({
          consolidation_user: user.id,
          consolidation_type: type,
          consolidation_day: dateKey,
          consolidation_days_walked: daysWalked,
        });

        try {
          const reducedValue = params.reduce(dayRows);
          const canonicalTimestamp = canonicalDailyTimestamp(dateKey, tz);
          const externalId = params.dailyStatsExternalId(hkIdentifier, dateKey);

          const shouldMint = params.onBucket
            ? await params.onBucket({
                prismaClient,
                userId: user.id,
                type,
                dateKey,
                dayRows,
                reducedValue,
                canonicalTimestamp,
                externalId,
              })
            : true;

          let outcome: DayWriteOutcome | null = null;
          if (!dryRun) {
            const sourceRowIds = dayRows.map((r) => r.id);
            outcome = await params.writeDay({
              prismaClient,
              userId: user.id,
              type,
              externalId,
              canonicalTimestamp,
              reducedValue,
              dayRows,
              sourceRowIds,
              tz,
              dateKey,
              shouldMint,
            });
          }

          params.recordBucket({
            userId: user.id,
            type,
            dateKey,
            dayRows,
            reducedValue,
            canonicalTimestamp,
            externalId,
            shouldMint,
            outcome,
          });
        } catch (err) {
          // No boundary supplied → preserve the historical abort-the-run
          // behaviour for the drains that classify errors in `writeDay`.
          if (!params.onBucketError) throw err;
          daysFailed += 1;
          params.onBucketError({
            userId: user.id,
            type,
            dateKey,
            error: err,
          });
        }
      }

      if (rowCount > 0) {
        params.onScan?.({
          userId: user.id,
          type,
          tz,
          rowCount,
          dayCount,
          dryRun,
        });
      }
    }

    params.onUserComplete?.({ userId: user.id, tz, dryRun });
  }

  return { usersScanned: users.length, dryRun, daysFailed, stoppedEarly };
}
