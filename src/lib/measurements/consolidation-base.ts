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
 * `canonicalDailyTimestamp`, `localStartOfDay`, `localDayWindow`) live in
 * `drain-per-sample-cumulative.ts` and are imported here to avoid a
 * cyclic dependency — that module is the historical home the other two
 * already import them from.
 */
import type {
  MeasurementType,
  PrismaClient,
  Prisma,
} from "@/generated/prisma/client";

import {
  canonicalDailyTimestamp,
  dayKeyForUserTz,
  type PerSampleRow,
} from "./drain-per-sample-cumulative";

/**
 * Canonical grace window shared by the cumulative + mean drains. Rows
 * whose `measuredAt` is newer than `now() - CONSOLIDATION_GRACE_CUTOFF_HOURS`
 * stay raw so today's still-in-flight watch syncs surface in the live
 * "today" view. 36 hours covers the previous calendar day plus a
 * trailing sync window for watches that weren't worn at midnight.
 */
export const CONSOLIDATION_GRACE_CUTOFF_HOURS = 36;

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
export function resolveCutoffInstant(cutoffHours: number | undefined): Date | null {
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
  | { kind: "written"; sourceRowsRemoved: number }
  | { kind: "skipped-conflict" };

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
  onUserStart?: (input: { userId: string; tz: string; dryRun: boolean }) => void;
  /**
   * Fired once per (user, type) immediately after the rows are bucketed,
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
  onUserComplete?: (input: { userId: string; tz: string; dryRun: boolean }) => void;
}

const DEFAULT_SCAN_SELECT: Prisma.MeasurementSelect = {
  id: true,
  type: true,
  value: true,
  measuredAt: true,
  externalId: true,
};

/**
 * Drive one consolidation pass. Walks `users → types → days`, scans live
 * source rows inside the grace window, buckets them, reduces each day,
 * and delegates the per-day mint + delete to `writeDay`. Returns the
 * number of users scanned so the caller can seed its summary totals.
 *
 * Idempotency, the grace-window cutoff, and the "skip already-collapsed
 * rows" predicate are all owned here; the divergent reducer / delete /
 * scope / summary concerns are supplied by the params.
 */
export async function runConsolidation<TType extends MeasurementType>(
  params: ConsolidationParams<TType>,
): Promise<{ usersScanned: number; dryRun: boolean }> {
  const { prismaClient, options } = params;
  const dryRun = options.dryRun ?? false;
  const cutoffAt = resolveCutoffInstant(options.cutoffHours);
  const scanSelect = params.scanSelect ?? DEFAULT_SCAN_SELECT;

  const users = await loadConsolidationUsers(prismaClient, options.userId);

  for (const user of users) {
    const tz = resolveUserTimezone(user.timezone);
    params.onUserStart?.({ userId: user.id, tz, dryRun });

    for (const type of params.types) {
      const hkIdentifier = params.hkIdentifierForType(type);
      if (!hkIdentifier) continue;

      const sourceRows = (await prismaClient.measurement.findMany({
        where: params.buildScanWhere({
          userId: user.id,
          type,
          cutoffAt,
          statsPrefix: params.statsPrefix,
        }),
        select: scanSelect,
        orderBy: { measuredAt: "asc" },
      })) as PerSampleRow[];

      if (sourceRows.length === 0) continue;

      const byDay = bucketRowsByDay(sourceRows, tz, params.statsPrefix);

      params.onScan?.({
        userId: user.id,
        type,
        tz,
        rowCount: sourceRows.length,
        dayCount: byDay.size,
        dryRun,
      });

      for (const [dateKey, dayRows] of byDay) {
        if (dayRows.length === 0) continue;

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
      }
    }

    params.onUserComplete?.({ userId: user.id, tz, dryRun });
  }

  return { usersScanned: users.length, dryRun };
}
