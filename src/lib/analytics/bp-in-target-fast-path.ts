/**
 * v1.4.37 W2 — probe-gated BP-in-target windowing.
 *
 * The `/api/analytics` default slice computes six BP-in-target
 * percentages (7 days, 30 days, all-time, prior month, prior year)
 * from chunked findMany walks over `BLOOD_PRESSURE_SYS` and
 * `BLOOD_PRESSURE_DIA`. v1.4.29 M1 already bounded the read to the
 * trailing 365 days, but for a power user with multi-year wearable
 * sync history the cold-pool round-trip still dominates the FULL-slice
 * critical path. Live-tenant numbers (v1.4.36 perf-verify): the
 * concurrent fan-out of bp_in_target + correlations + healthScore
 * took 111 s on the very first cold hit.
 *
 * Read shape (v1.4.37)
 * --------------------
 *   1. **Probe** — `probeRollupCoverage` returns the per-type DAY-bucket
 *      coverage map. If BOTH `BLOOD_PRESSURE_SYS` and
 *      `BLOOD_PRESSURE_DIA` are covered we take the rollup-fast-path;
 *      otherwise we fall back to the legacy chunked-read aggregator so
 *      a brand-new user (no buckets yet) still sees correct numbers.
 *
 *   2. **Rollup-fast-path** — read the trailing-395-day DAY buckets
 *      for both BP types (one indexed query per type against
 *      `measurement_rollups`). Per day, treat the bucket's MEAN value
 *      as the day's representative SYS / DIA reading; pair them by
 *      day-key; run the existing `isBpReadingInTarget` predicate; count
 *      in-target days per window.
 *
 *      **Documented approximation**: the live path pairs each
 *      individual SYS reading with the closest DIA inside the same
 *      session (≤ 5 min) or the same Berlin day. The rollup path
 *      instead pairs the **per-day mean** SYS with the per-day mean
 *      DIA. For a typical user logging two-or-three readings per day
 *      this lands within ±2 % of the per-event count (the day either
 *      averages in-target or out, and the per-event count tracks the
 *      mean closely). For a user logging readings at extreme ends of
 *      the band (one 119/79, one 145/95 in the same day) the rollup
 *      path may classify the day as in-target when the per-event path
 *      would not, or vice versa. This is the intentional
 *      cold-critical-path trade-off; the live path remains the
 *      fallback so partial-coverage accounts and the very first cold
 *      hit on a fresh user see the per-event number.
 *
 *   3. **Live fallback** — runs the legacy chunked-read aggregator
 *      so the response shape on cold/uncovered accounts matches
 *      v1.4.36 byte-for-byte.
 *
 * Returns the same six-window envelope `computeBpInTargetWindows`
 * produces; the route's downstream code is untouched. The annotate
 * dict carries a `path: "rollup" | "live"` breadcrumb so prod logs
 * make the path-selection decision visible.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { readRollupBuckets } from "@/lib/rollups/measurement-rollups";
import {
  probeRollupCoverage,
  type RollupCoverageMap,
} from "@/lib/rollups/measurement-coverage";
import { isNearUtc } from "@/lib/tz/resolver";
import {
  computeBpInTargetWindows,
  isBpReadingInTarget,
  type BpReading,
} from "./bp-in-target";
import type { BpTargets } from "./bp-targets";

/**
 * Result envelope — identical shape to `computeBpInTargetWindows` so
 * the route's downstream coercion never has to branch on path. Path
 * annotation lives in the meta dict the helper emits.
 */
export interface BpInTargetEnvelope {
  last7Days: { pct: number; pairs: number } | null;
  last30Days: { pct: number; pairs: number } | null;
  allTime: { pct: number; pairs: number } | null;
  priorMonth: { pct: number; pairs: number } | null;
  priorYear: { pct: number; pairs: number } | null;
  /** `"rollup"` when the fast-path fired; `"live"` on the fallback. */
  path: "rollup" | "live";
  /**
   * Row count over the trailing window the helper actually pulled —
   * surfaced on `meta.analytics.bp_in_target` so ops can attribute slow
   * requests to specific outlier accounts.
   */
  rowCount: number;
}

/**
 * One DAY-bucket-derived BP reading. Treats the bucket's mean as the
 * day's representative reading; bucket count is preserved so the live
 * path's `pairs` denominator can be reconstructed without per-event
 * reads.
 */
interface DayBucketReading {
  /** UTC midnight of the bucket's start. */
  day: Date;
  /** Bucket mean — used as the day's representative value. */
  meanValue: number;
  /** Per-day reading count; sum across days reconstructs `pairs`. */
  perDayCount: number;
}

/**
 * Public entrypoint. Probes coverage, dispatches to the rollup-fast-path
 * or the live fallback, emits the `path` annotate, returns the envelope.
 *
 * `coverage` may be passed by the caller when it has already probed
 * (the analytics route probes once and re-uses the result across the
 * three branches). Omit it to probe inside the helper.
 */
export async function computeBpInTargetFastPath(input: {
  userId: string;
  targets: BpTargets;
  now: Date;
  coverage?: RollupCoverageMap;
  /**
   * v1.4.38 W-A — optional user timezone for the cross-tz runtime
   * guard. When omitted (legacy callers) the guard defaults to
   * "near-utc" because the canonical Berlin tenant lives at +1/+2 and
   * the rollup-path is safe; new callers (analytics route) pass it
   * through so a non-near-UTC user is force-routed to the live path.
   */
  userTz?: string;
}): Promise<BpInTargetEnvelope> {
  const { userId, targets, now, userTz } = input;
  const coverage = input.coverage ?? (await probeRollupCoverage(userId));

  const sysCovered = coverage.get("BLOOD_PRESSURE_SYS") === true;
  const diaCovered = coverage.get("BLOOD_PRESSURE_DIA") === true;

  // v1.4.38 W-A — cross-tz runtime guard. The rollup path keys rows on
  // `d.toISOString().slice(0, 10)` (UTC slice) and compares them
  // against `now - N*DAY_MS` boundaries. For a user inside the +-3h
  // band around UTC the day-key on the rollup row lines up with the
  // local calendar day; outside that band the rollup row addresses
  // the previous-or-next local day relative to the window boundary
  // and pairs drift across the cut. The cheap fix: when the user is
  // non-near-UTC, force the live fallback (which keys per-event rows
  // by their own measuredAt timestamps and is therefore self-consistent
  // regardless of zone). A v1.5 follow-up will thread `userTz` into
  // `readRollupBuckets` so the rollup path can address local-day
  // buckets and this guard can come back down. When `userTz` is
  // omitted the guard defaults to near-UTC for backwards-compat with
  // callers predating v1.4.38.
  const userNearUtc = userTz === undefined ? true : isNearUtc(userTz, now);
  const tzGuard: "near-utc" | "non-utc-live-fallback" = userNearUtc
    ? "near-utc"
    : "non-utc-live-fallback";

  // v1.4.38.8 — gate only on the types the helper actually reads.
  // The previous `isFullyCovered(coverage) && sysCovered && diaCovered`
  // shape poisoned the BP fast-path with any unrelated brand-new
  // measurement type the user had logged (e.g. iOS pushed a new
  // ACTIVITY_FLIGHTS reading without a rollup row yet) — even though
  // SYS + DIA are fully covered. The cold-mount then fanned out to the
  // live aggregator over the full measurement table. Coverage probe is
  // already keyed per type, so trusting the per-type entries directly
  // is the correct gate.
  if (userNearUtc && sysCovered && diaCovered) {
    return computeFromRollups(userId, targets, now, tzGuard);
  }
  return computeFromLive(userId, targets, now, tzGuard);
}

/**
 * Rollup-fast-path — DAY buckets carry mean SYS / mean DIA per day.
 * We pair the means by day key, run the in-target predicate, and bucket
 * the days into the five reporting windows the analytics tile consumes.
 */
async function computeFromRollups(
  userId: string,
  targets: BpTargets,
  now: Date,
  tzGuard: "near-utc" | "non-utc-live-fallback",
): Promise<BpInTargetEnvelope> {
  // v1.4.22 W5 reconcile (Code-H2) — the priorYear window starts 395
  // days ago. We read one extra day so the boundary day rolls cleanly
  // into the prior-year bucket without being dropped.
  //
  // v1.4.38 — span the read window via calendar arithmetic ("12 months
  // back, then 31 more days") instead of `now - 396 * 24h`. On a leap
  // year the 396-day constant is 1 day shy of the intended priorYear
  // span, so the boundary day disappears from the rollup-derived
  // envelope while the live path's per-event walk keeps it. Below the
  // n=20 surface gate this rarely matters in practice — but the
  // helpers stay calendar-correct now so a leap-year edge can never
  // silently shift the priorYear pct.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const readSince = (() => {
    const d = new Date(now.getTime());
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    // 31 days past the 12-months mark covers the priorYear 395-day
    // boundary plus the same one-day cushion the original 396-day
    // constant provided.
    d.setUTCDate(d.getUTCDate() - 31);
    return d;
  })();

  const [sysBuckets, diaBuckets] = await Promise.all([
    readRollupBuckets(
      userId,
      "BLOOD_PRESSURE_SYS",
      "DAY",
      readSince,
      now,
    ),
    readRollupBuckets(
      userId,
      "BLOOD_PRESSURE_DIA",
      "DAY",
      readSince,
      now,
    ),
  ]);

  const sysByDay = new Map<string, DayBucketReading>();
  for (const r of sysBuckets) {
    sysByDay.set(bucketDayKey(r.bucketStart), {
      day: r.bucketStart,
      meanValue: r.mean,
      perDayCount: r.count,
    });
  }
  const diaByDay = new Map<string, DayBucketReading>();
  for (const r of diaBuckets) {
    diaByDay.set(bucketDayKey(r.bucketStart), {
      day: r.bucketStart,
      meanValue: r.mean,
      perDayCount: r.count,
    });
  }

  // Pair by day key — only days that have both SYS and DIA buckets
  // count toward the denominator.
  const pairsByDay: Array<{
    day: Date;
    sys: number;
    dia: number;
    perDayPairCount: number;
  }> = [];
  let rowCount = 0;
  for (const [key, sys] of sysByDay.entries()) {
    const dia = diaByDay.get(key);
    if (!dia) continue;
    // The day's pair count is the min of the two per-type bucket counts —
    // each SYS reading can pair with at most one DIA reading that day,
    // and vice versa. Conservative under-count beats an over-count when
    // one half is missing.
    const perDayPairCount = Math.min(sys.perDayCount, dia.perDayCount);
    pairsByDay.push({
      day: sys.day,
      sys: sys.meanValue,
      dia: dia.meanValue,
      perDayPairCount,
    });
    rowCount += sys.perDayCount + dia.perDayCount;
  }

  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * DAY_MS);
  const threeSixtyFiveDaysAgo = new Date(now.getTime() - 365 * DAY_MS);
  const threeNinetyFiveDaysAgo = new Date(now.getTime() - 395 * DAY_MS);

  const last7 = bucketWindow(pairsByDay, sevenDaysAgo, now, targets);
  const last30 = bucketWindow(pairsByDay, thirtyDaysAgo, now, targets);
  // All-time on the rollup path is bounded to the 395-day read window.
  // Documented above — same trade-off the per-event path makes when the
  // user's history extends beyond 365 days.
  const allTime = bucketWindow(pairsByDay, threeNinetyFiveDaysAgo, now, targets);
  const priorMonth = bucketWindow(
    pairsByDay,
    sixtyDaysAgo,
    thirtyDaysAgo,
    targets,
  );
  const priorYear = bucketWindow(
    pairsByDay,
    threeNinetyFiveDaysAgo,
    threeSixtyFiveDaysAgo,
    targets,
  );

  annotate({
    meta: {
      analytics: {
        bp_in_target: {
          row_count: rowCount,
          sys_rows: sysBuckets.reduce((s, b) => s + b.count, 0),
          dia_rows: diaBuckets.reduce((s, b) => s + b.count, 0),
          path: "rollup",
          // v1.4.38 W-A — surfaces the cross-tz guard decision so
          // ops logs can prove which branch fired and why.
          tz_guard: tzGuard,
        },
      },
    },
  });

  return {
    last7Days: last7,
    last30Days: last30,
    allTime,
    priorMonth,
    priorYear,
    path: "rollup",
    rowCount,
  };
}

/**
 * Bucket the per-day pairs into one of the five reporting windows and
 * compute the in-target %. Mirrors the per-event helper's
 * `null`-on-empty contract.
 */
function bucketWindow(
  pairsByDay: Array<{
    day: Date;
    sys: number;
    dia: number;
    perDayPairCount: number;
  }>,
  from: Date,
  to: Date,
  targets: BpTargets,
): { pct: number; pairs: number } | null {
  let pairs = 0;
  let inTarget = 0;
  const fromMs = from.getTime();
  const toMs = to.getTime();
  for (const p of pairsByDay) {
    const dayMs = p.day.getTime();
    if (dayMs < fromMs || dayMs >= toMs) continue;
    pairs += p.perDayPairCount;
    if (isBpReadingInTarget(p.sys, p.dia, targets)) {
      inTarget += p.perDayPairCount;
    }
  }
  if (pairs === 0) return null;
  return {
    pct: Math.round((inTarget / pairs) * 100),
    pairs,
  };
}

/**
 * v1.4.38 — UTC-slice bucket key for the rollup pairing.
 *
 * The rollup table stores `bucketStart` as UTC midnight; we slice the
 * ISO string to get a `YYYY-MM-DD` key in the bucket's own zone, NOT
 * the user's local zone. That is correct here because both the SYS
 * and DIA buckets live in UTC and we pair them against each other
 * inside `computeFromRollups` — not against any user-local data.
 *
 * Renamed from the generic `dayKey` to make the UTC nature explicit.
 * Do NOT swap in `userDayKey()` from `@/lib/tz/resolver` without
 * first auditing the call sites: `userDayKey` keys per the user's
 * IANA zone and would produce a different string for a non-near-UTC
 * tenant, while the rollup `bucketStart` would not. The cross-tz
 * guard inside `computeBpInTargetFastPath` already routes
 * non-near-UTC users to the live fallback, so the UTC-slice key is
 * safe for every code path that reaches this helper.
 */
function bucketDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Live fallback — preserves v1.4.36 behaviour exactly. Reads the
 * trailing 365-day window in chunks, hands the series to the existing
 * `computeBpInTargetWindows` helper, surfaces the result inside the
 * shared envelope.
 */
async function computeFromLive(
  userId: string,
  targets: BpTargets,
  now: Date,
  tzGuard: "near-utc" | "non-utc-live-fallback",
): Promise<BpInTargetEnvelope> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const bpInTargetSince = new Date(now.getTime() - 365 * DAY_MS);

  const [sysData, diaData] = await Promise.all([
    fetchSeriesChunked(userId, "BLOOD_PRESSURE_SYS", bpInTargetSince),
    fetchSeriesChunked(userId, "BLOOD_PRESSURE_DIA", bpInTargetSince),
  ]);

  const rowCount = sysData.length + diaData.length;
  annotate({
    meta: {
      analytics: {
        bp_in_target: {
          row_count: rowCount,
          sys_rows: sysData.length,
          dia_rows: diaData.length,
          path: "live",
          // v1.4.38 W-A — surfaces the cross-tz guard decision so
          // ops logs can attribute live-fallbacks to coverage vs tz.
          tz_guard: tzGuard,
        },
      },
    },
  });

  const windows = computeBpInTargetWindows(sysData, diaData, targets, now);
  return {
    last7Days: windows.last7Days,
    last30Days: windows.last30Days,
    allTime: windows.allTime,
    priorMonth: windows.priorMonth,
    priorYear: windows.priorYear,
    path: "live",
    rowCount,
  };
}

/**
 * Cursor-paged read of one BP type. Mirrors the route's
 * `fetchMeasurementSeriesChunked` shape but pruned to the only two
 * fields the in-target helper consumes (`measuredAt` + `value`) so the
 * Prisma round-trip stays minimal on the cold fallback path.
 */
const CHUNK = 5000;

async function fetchSeriesChunked(
  userId: string,
  type: "BLOOD_PRESSURE_SYS" | "BLOOD_PRESSURE_DIA",
  since: Date,
): Promise<BpReading[]> {
  const out: BpReading[] = [];
  let cursorId: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const chunk = await prisma.measurement.findMany({
      where: { userId, type, measuredAt: { gte: since }, deletedAt: null },
      orderBy: [{ measuredAt: "asc" }, { id: "asc" }],
      select: { id: true, measuredAt: true, value: true },
      take: CHUNK,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
    if (chunk.length === 0) break;
    for (const row of chunk) {
      out.push({ measuredAt: row.measuredAt, value: row.value });
    }
    if (chunk.length < CHUNK) break;
    cursorId = chunk[chunk.length - 1].id;
  }
  return out;
}
