/**
 * v1.4.30 — drain pre-Option-A per-sample APPLE_HEALTH cumulative rows
 * into one row per day per type, keyed by the locked `dailyStatsExternalId`
 * shape. Idempotent: re-running collapses zero rows once every cumulative
 * bucket already holds a single `stats:...` row.
 *
 * Scope per `CUMULATIVE_HK_TYPES`:
 *   ACTIVITY_STEPS, ACTIVE_ENERGY_BURNED, FLIGHTS_CLIMBED,
 *   WALKING_RUNNING_DISTANCE, TIME_IN_DAYLIGHT
 *
 * Per user × type × calendar day (anchored to `User.timezone`):
 *   1. SELECT all `Measurement` rows with `source = 'APPLE_HEALTH'` and
 *      `type = <cumulative type>` and `measuredAt` within that user's
 *      calendar day boundary and `externalId NOT LIKE 'stats:%'`.
 *   2. If 0 rows → continue.
 *   3. If 1 row whose externalId already follows the `stats:...`
 *      shape → continue (already collapsed).
 *   4. SUM the values; pick canonical timestamp = midday UTC of the
 *      user's calendar day (matches the Withings activity-sync
 *      convention per R-A §5 / W17b).
 *   5. UPSERT a row with `externalId = dailyStatsExternalId(...)`,
 *      `value = sumValue`, `measuredAt = canonicalTimestamp`.
 *   6. DELETE the original per-sample rows in the same transaction.
 *
 * Designed to be invoked by both:
 *   - the CLI at `scripts/drain-per-sample-cumulative.ts`
 *   - the admin endpoint at
 *     `POST /api/admin/drain-per-sample-cumulative`
 *
 * The dry-run path emits the same per-user-day summary without
 * touching the DB so the operator can inspect what would change before
 * committing.
 */
import { Prisma } from "@/generated/prisma/client";
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";

import {
  CUMULATIVE_HK_TYPES,
  dailyStatsExternalId,
  hkIdentifierForType,
} from "./apple-health-mapping";

/**
 * v1.4.38 — canonical cutoff for the nightly scheduled drain. Rows
 * whose `measuredAt` is newer than `now() - DRAIN_CUMULATIVE_CUTOFF_HOURS`
 * are excluded so today's still-in-flight Apple Watch syncs stay as
 * per-sample rows in the user's "today" view. 36 hours covers the
 * previous calendar day plus a generous trailing sync window for
 * watches that weren't worn at midnight. The CLI and the admin route
 * import the constant for visibility but deliberately pass `undefined`
 * by default so an explicit one-shot drain collapses every row the
 * operator points it at; pass the constant explicitly when mirroring
 * the nightly behaviour from an interactive shell.
 */
export const DRAIN_CUMULATIVE_CUTOFF_HOURS = 36;

/** Per-(user, type, day) action summary. */
export interface DrainBucket {
  userId: string;
  type: MeasurementType;
  /** Calendar-day key in the user's timezone (`YYYY-MM-DD`). */
  dateKey: string;
  /** Number of per-sample rows scanned for this bucket. */
  perSampleCount: number;
  /** SUM of per-sample values for this bucket (canonical-unit). */
  sumValue: number;
  /** ISO-8601 canonical timestamp (midday UTC of the user's calendar day). */
  canonicalTimestamp: string;
  /** Resulting `externalId` of the daily-aggregated row. */
  externalId: string;
}

export interface DrainSummary {
  /** Did the run actually write to the DB (false for `dryRun`). */
  dryRun: boolean;
  /** Per-user-day buckets the drain rewrote (or would rewrite). */
  buckets: DrainBucket[];
  /** Aggregate counts across the run. */
  totals: {
    usersScanned: number;
    bucketsCollapsed: number;
    perSampleRowsDeleted: number;
    dailyRowsUpserted: number;
  };
}

export interface DrainOptions {
  /** Limit the drain to a single user. Default = every user. */
  userId?: string;
  /** Preview-only mode — no DB writes, no transaction commits. */
  dryRun?: boolean;
  /** Logger sink — defaults to `console.log`. */
  log?: (line: string) => void;
  /**
   * v1.4.37 W7c — protect recent per-sample rows from collapse so late
   * watch syncs still surface in real time before the list view shows
   * the day's total. When set, rows whose `measuredAt` is newer than
   * `now() - cutoffHours` are excluded from the scan; the drain only
   * acts on completed days that have had enough time to stabilise.
   *
   * The scheduled nightly call passes `36` so the previous day's
   * trailing sync window (Apple Watch reconciliations land up to a few
   * hours after midnight when the watch wasn't worn) is fully covered.
   * The CLI + admin endpoint default to `undefined` (drain everything
   * the operator points at) for explicit one-shot use.
   */
  cutoffHours?: number;
}

/**
 * Resolve the user's calendar-day key (`YYYY-MM-DD`) for a given
 * timestamp + timezone. Reuses the same `sv-SE` Intl formatting choice
 * the mood-entries path locked in v1.4.25 W7b so iOS-side and
 * server-side day-keys round-trip byte-identically.
 */
export function dayKeyForUserTz(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(date);
}

/**
 * Read the IANA-zone offset (in minutes east of UTC) at a given
 * instant. Returns 0 for UTC and any zone the shortOffset formatter
 * can't resolve (defensive — Node 22's full-icu build covers every
 * zone we care about).
 */
function tzOffsetMinutesAt(instant: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "shortOffset",
  });
  const parts = fmt.formatToParts(instant);
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const match = tzPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return 0;
  const sign = match[1] === "+" ? 1 : -1;
  const hours = Number.parseInt(match[2], 10);
  const minutes = match[3] ? Number.parseInt(match[3], 10) : 0;
  return sign * (hours * 60 + minutes);
}

/**
 * Compute the canonical timestamp for a calendar-day key in the user's
 * timezone. Returns the JS-Date instant at the user's local 12:00 noon
 * — matches the Withings activity sync convention (one daily row per
 * type, anchored to midday so the row sorts cleanly between same-day
 * spot samples). The string returned by `toISOString()` is UTC.
 */
export function canonicalDailyTimestamp(
  dateKey: string,
  tz: string,
): Date {
  // Compute the UTC offset for noon-local of the given day. We don't
  // have a lightweight TZ-math library on the server, so the trick is:
  // build "12:00 UTC of the day", read what wall-clock that shows in
  // the target zone, then shift by the resulting offset.
  const utcNoon = new Date(`${dateKey}T12:00:00.000Z`);
  const offsetMinutes = tzOffsetMinutesAt(utcNoon, tz);
  // utcNoon represents 12:00 UTC. The user's local clock reads
  // 12:00 + offsetMinutes at that instant. To anchor at local 12:00,
  // subtract the offset.
  return new Date(utcNoon.getTime() - offsetMinutes * 60 * 1000);
}

/**
 * v1.4.37 W10 — Compute the JS-Date instant at the user's local 00:00
 * for a calendar-day key. Robust on DST transitions because the offset
 * is read at the UTC-midnight instant of the day, and EU/US DST
 * transitions happen at local 02:00 / 03:00 — so the offset at UTC
 * midnight is unambiguous on every day of the year.
 *
 * Used by the W7c drill-down branch to resolve [dayStart, dayEnd) on
 * a 23-h spring-forward or 25-h fall-back day; the previous shape
 * (`canonicalDailyTimestamp ± 12h`) silently leaked or hid an hour
 * of samples on two days per year.
 *
 * Pair with `localStartOfDay(nextDayKey, tz)` for the right bound so
 * the returned window covers the true local-day span — 23 h on
 * spring-forward, 24 h on a regular day, 25 h on fall-back.
 */
export function localStartOfDay(dateKey: string, tz: string): Date {
  // Anchor at 00:00 UTC of the day; the offset read at that instant
  // is the same offset the local clock uses at midnight (DST
  // transitions in EU/US happen at 02:00 / 03:00 local, not at the
  // 00:00 boundary). For sub-half-hour zones (Asia/Kathmandu UTC+5:45,
  // Pacific/Chatham UTC+12:45) the minute component is preserved.
  const utcMidnight = new Date(`${dateKey}T00:00:00.000Z`);
  const offsetMinutes = tzOffsetMinutesAt(utcMidnight, tz);
  // Local 00:00 at this date = UTC midnight - offset.
  return new Date(utcMidnight.getTime() - offsetMinutes * 60 * 1000);
}

/**
 * v1.4.37 W10 — Resolve the [dayStart, dayEnd) UTC window for a
 * calendar-day key in the user's IANA timezone. The window honours
 * DST so the drill-down branch returns the correct 23 / 24 / 25-hour
 * span for transition days.
 *
 * Returns a tuple where `dayEnd` is the local 00:00 of the FOLLOWING
 * calendar day — `< dayEnd` is the canonical half-open bound used by
 * the route's `measuredAt: { gte: dayStart, lt: dayEnd }` predicate.
 */
export function localDayWindow(
  dateKey: string,
  tz: string,
): { dayStart: Date; dayEnd: Date } {
  const dayStart = localStartOfDay(dateKey, tz);
  // Add ONE day to dateKey using UTC arithmetic on a noon anchor (noon
  // sidesteps every DST edge case for the calendar increment). Then
  // re-extract the ISO date slice — guaranteed to be the next-day key.
  const nextUtcNoon = new Date(`${dateKey}T12:00:00.000Z`);
  nextUtcNoon.setUTCDate(nextUtcNoon.getUTCDate() + 1);
  const nextDateKey = nextUtcNoon.toISOString().slice(0, 10);
  const dayEnd = localStartOfDay(nextDateKey, tz);
  return { dayStart, dayEnd };
}

/**
 * Group an array of per-sample rows into per-day buckets keyed by the
 * user's timezone. Exposed for unit testing the bucketing semantics
 * without booting Prisma.
 */
export interface PerSampleRow {
  id: string;
  type: MeasurementType;
  value: number;
  measuredAt: Date;
  externalId: string | null;
}

export interface BucketedRows {
  /** Map keyed by `YYYY-MM-DD` (user TZ). */
  byDay: Map<string, PerSampleRow[]>;
}

export function bucketRowsByUserDay(
  rows: readonly PerSampleRow[],
  tz: string,
): BucketedRows {
  const byDay = new Map<string, PerSampleRow[]>();
  for (const row of rows) {
    // Skip rows already in the daily-stats shape — re-running the
    // drain on a previously-collapsed bucket is a no-op.
    if (row.externalId !== null && row.externalId.startsWith("stats:")) {
      continue;
    }
    const key = dayKeyForUserTz(row.measuredAt, tz);
    const slot = byDay.get(key) ?? [];
    slot.push(row);
    byDay.set(key, slot);
  }
  return { byDay };
}

/**
 * Sum the values in a per-day bucket. Tiny helper; keeps the call
 * site (transactional drain loop) readable.
 */
export function sumBucketValues(rows: readonly PerSampleRow[]): number {
  let acc = 0;
  for (const row of rows) acc += row.value;
  return acc;
}

/**
 * Run the drain. Idempotent — re-invocation after a successful drain
 * reports zero buckets collapsed.
 *
 * The function does NOT enforce the admin gate or the operator-confirm
 * flag — the CLI wrapper + the admin endpoint own those concerns.
 */
export async function drainPerSampleCumulative(
  prismaClient: PrismaClient,
  options: DrainOptions = {},
): Promise<DrainSummary> {
  const dryRun = options.dryRun ?? false;
  const log = options.log ?? ((line) => console.log(line));
  // v1.4.37 W7c — when the scheduler passes a cutoff window we leave
  // rows newer than the cutoff alone so the user's "today" view keeps
  // updating in real time. Cutoff is computed once per invocation so
  // every per-user-type scan uses the same boundary instant.
  const cutoffAt =
    typeof options.cutoffHours === "number" && options.cutoffHours > 0
      ? new Date(Date.now() - options.cutoffHours * 60 * 60 * 1000)
      : null;

  const users = options.userId
    ? await prismaClient.user.findMany({
        where: { id: options.userId },
        select: { id: true, timezone: true },
      })
    : await prismaClient.user.findMany({
        select: { id: true, timezone: true },
      });

  const summary: DrainSummary = {
    dryRun,
    buckets: [],
    totals: {
      usersScanned: users.length,
      bucketsCollapsed: 0,
      perSampleRowsDeleted: 0,
      dailyRowsUpserted: 0,
    },
  };

  for (const user of users) {
    const tz = user.timezone && user.timezone.length > 0 ? user.timezone : "Europe/Berlin";
    log(`[drain] user=${user.id} tz=${tz}${dryRun ? " (dry-run)" : ""}`);

    // v1.4.38 — per-user counters that mirror the existing aggregate
    // totals. Lets the per-user COMPLETE log line carry useful
    // numbers without re-walking the summary list later.
    const beforeBucketsCollapsed = summary.totals.bucketsCollapsed;
    const beforePerSampleDeleted = summary.totals.perSampleRowsDeleted;
    const beforeDailyUpserted = summary.totals.dailyRowsUpserted;

    for (const type of CUMULATIVE_HK_TYPES) {
      const hkIdentifier = hkIdentifierForType(type);
      if (!hkIdentifier) continue;

      const perSampleRows = (await prismaClient.measurement.findMany({
        where: {
          userId: user.id,
          source: "APPLE_HEALTH",
          type,
          // v1.4.37 W7c — exclude rows that fall inside the grace
          // window so the nightly scheduled drain never collapses
          // today's still-in-flight watch syncs.
          ...(cutoffAt ? { measuredAt: { lt: cutoffAt } } : {}),
        },
        select: {
          id: true,
          type: true,
          value: true,
          measuredAt: true,
          externalId: true,
        },
        orderBy: { measuredAt: "asc" },
      })) as PerSampleRow[];

      if (perSampleRows.length === 0) continue;

      const { byDay } = bucketRowsByUserDay(perSampleRows, tz);

      for (const [dateKey, dayRows] of byDay) {
        if (dayRows.length === 0) continue;

        // Already-collapsed buckets are caught above (rows with
        // externalId starting "stats:" never enter the bucket map).
        // A single per-sample row left over is still drained — that
        // way the externalId converges to the canonical shape even
        // when iOS happened to emit exactly one sample on a quiet
        // day.

        const sumValue = sumBucketValues(dayRows);
        const canonicalTs = canonicalDailyTimestamp(dateKey, tz);
        const externalId = dailyStatsExternalId(hkIdentifier, dateKey);

        const bucket: DrainBucket = {
          userId: user.id,
          type,
          dateKey,
          perSampleCount: dayRows.length,
          sumValue,
          canonicalTimestamp: canonicalTs.toISOString(),
          externalId,
        };
        summary.buckets.push(bucket);
        summary.totals.bucketsCollapsed += 1;

        if (!dryRun) {
          await prismaClient.$transaction(async (tx) => {
            // Upsert the daily-aggregated row first, then drop the
            // per-sample rows. The unique index
            // (userId, type, source, externalId) makes the upsert
            // idempotent across re-runs.
            await tx.measurement.upsert({
              where: {
                userId_type_source_externalId: {
                  userId: user.id,
                  type,
                  source: "APPLE_HEALTH",
                  externalId,
                },
              },
              create: {
                userId: user.id,
                type,
                value: sumValue,
                unit: dayRows[0]?.value !== undefined
                  ? // pick the canonical unit from the existing row by
                    // looking it up via the mapping table; the per-sample
                    // rows all carry the same unit on a given type, so
                    // any of them would do.
                    await resolveCanonicalUnit(tx, user.id, type)
                  : "count",
                source: "APPLE_HEALTH",
                measuredAt: canonicalTs,
                externalId,
              },
              update: {
                value: sumValue,
                measuredAt: canonicalTs,
              },
            });

            // Delete the per-sample rows that contributed to the sum.
            // Using `id IN (...)` is bounded by the per-bucket cap
            // (the largest cumulative bucket in real data is a
            // ~1 440-row stepCount day on a phone-only user).
            const ids = dayRows.map((r) => r.id);
            const del = await tx.measurement.deleteMany({
              where: { id: { in: ids } },
            });
            summary.totals.perSampleRowsDeleted += del.count;
            summary.totals.dailyRowsUpserted += 1;
          });
        } else {
          summary.totals.perSampleRowsDeleted += dayRows.length;
          summary.totals.dailyRowsUpserted += 1;
        }
      }
    }

    // v1.4.38 — per-user COMPLETE log line. Mirrors the START line on
    // line 311 so an operator scanning the worker log can pair
    // "drain started for user X" with "drain finished for user X"
    // without scrolling through every per-type bucket. Counts are
    // computed as the delta against the snapshot taken before the
    // per-type loop started.
    const userBucketsCollapsed =
      summary.totals.bucketsCollapsed - beforeBucketsCollapsed;
    const userPerSampleDeleted =
      summary.totals.perSampleRowsDeleted - beforePerSampleDeleted;
    const userDailyUpserted =
      summary.totals.dailyRowsUpserted - beforeDailyUpserted;
    log(
      `[drain] user=${user.id} complete bucketsCollapsed=${userBucketsCollapsed} perSampleRowsDeleted=${userPerSampleDeleted} dailyRowsUpserted=${userDailyUpserted}${dryRun ? " (dry-run)" : ""}`,
    );
  }

  log(
    `[drain] done — usersScanned=${summary.totals.usersScanned} bucketsCollapsed=${summary.totals.bucketsCollapsed} perSampleRowsDeleted=${summary.totals.perSampleRowsDeleted} dailyRowsUpserted=${summary.totals.dailyRowsUpserted}${dryRun ? " (dry-run)" : ""}`,
  );
  return summary;
}

/**
 * Pull the canonical unit for a `(userId, type)` pair from an existing
 * per-sample row. Used during the upsert's `create` branch when we
 * need to populate `Measurement.unit` for the new aggregated row.
 */
async function resolveCanonicalUnit(
  tx: Prisma.TransactionClient,
  userId: string,
  type: MeasurementType,
): Promise<string> {
  const row = await tx.measurement.findFirst({
    where: { userId, type, source: "APPLE_HEALTH" },
    select: { unit: true },
  });
  return row?.unit ?? "count";
}
