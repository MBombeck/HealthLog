/**
 * IO seam for the intraday pulse / tension layer.
 *
 * Loads ONE local day's raw signals on demand (read-swap; never persisted as
 * 10-min rollups) and hands them to the pure `intraday-pulse` computations:
 *
 *   - raw PULSE for the day → the 10-minute mean shape;
 *   - the personal resting baseline (RESTING_HEART_RATE, else the
 *     low-percentile PULSE proxy) → the elevation line;
 *   - intraday step samples → the mandatory low-movement gate;
 *   - workouts overlapping the day → exercise never reads as tension;
 *   - intraday HRV (WHOOP RMSSD) below the personal median → an optional
 *     confirming flag.
 *
 * Shared by `GET /api/insights/pulse/intraday` (the chart) and the daily
 * digest's `tension_window` builder, so the signal is computed one way.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { mergeRestingWithProxy } from "@/lib/analytics/resting-pulse";
import { readRestingPulseProxy } from "@/lib/analytics/resting-pulse-read";
import { pickCanonicalSourceRows } from "@/lib/analytics/source-priority";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { readLocalDayMinuteBuckets } from "@/lib/measurements/dense-bucket-read";
import { CUMULATIVE_SAMPLE_SOURCES } from "@/lib/measurements/intraday-cumulative-profile";
import { localDayWindow } from "@/lib/tz/local-day";
import { userDayKey } from "@/lib/tz/format";
import {
  BUCKET_MINUTES,
  HOURLY_BUCKET_MINUTES,
  MIN_BASELINE_DAYS,
  computeHourlyMeanSeries,
  computeUploadedBucketSeries,
  detectTensionWindow,
  makeLocalResolver,
  type IntradayHrBucket,
  type IntradayResolution,
  type LocalResolver,
  type TensionWindow,
  type WorkoutInterval,
} from "@/lib/analytics/intraday-pulse";
import {
  isAggregatedBucketExternalId,
  parseAggregatedBucketStart,
} from "@/lib/measurements/apple-health-mapping";
import { median, roundTo } from "@/lib/stats/central";

/** UTC padding around the local calendar day so the query is a safe superset. */
const WINDOW_LEAD_MS = 15 * 60 * 60 * 1000; // covers UTC−14…+12 day starts
const WINDOW_TRAIL_MS = 39 * 60 * 60 * 1000;

/**
 * How far back the PULSE proxy reaches when the resting rows cannot carry the
 * baseline. The baseline is the median of the last 30 daily points, so 30
 * days of proxy days is everything it can use; it is the same window the
 * targets card folds its proxy over.
 */
const PROXY_BASELINE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** The DTO both the route and the digest read. */
export interface IntradayPulseResult {
  dateKey: string;
  timezone: string;
  bucketMinutes: number;
  series: IntradayHrBucket[];
  baseline: number | null;
  baselineSource: "resting" | "proxy" | "none";
  tension: TensionWindow | null;
  /**
   * S11 day navigator — `"tenMin"` when `series` was folded from live raw
   * per-sample rows, `"hourly"` when the day fell outside
   * `DENSE_INTRADAY_RETENTION_DAYS` and `series` is the coarser fallback
   * read off the folded `stats:` hourly-mean tier instead. `tension` is
   * always `null` on an `"hourly"` day — see `detectTensionWindow`'s
   * docblock for why a tension read needs per-sample resolution.
   */
  resolution: IntradayResolution;
}

/**
 * How old the newest RESTING_HEART_RATE row may be before the baseline stops
 * trusting the resting rows alone and pulls the PULSE history in as well. Two
 * days tolerates a single missed night without widening the read.
 */
const RESTING_STALE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Resolve the personal resting baseline and its maturity. Prefers the clean
 * RESTING_HEART_RATE rows; falls back to the low-percentile PULSE proxy. The
 * baseline is the median of the resolved daily series — robust to the odd
 * outlier — and is "mature" only once at least `MIN_BASELINE_DAYS` distinct
 * daily points exist.
 *
 * `timezone` buckets the PULSE-proxy fallback in the USER's local day
 * (DATAINT M5) — the caller previously omitted it, so
 * `deriveRestingProxyFromPulse` defaulted to Berlin-day buckets for every
 * user. A non-Berlin user's late-evening (often workout-heavy) samples then
 * folded into the wrong day's bucket, shifting the daily floor the tension
 * detector's `baseline + 12 bpm` threshold judges the day against.
 */
async function resolveBaseline(
  userId: string,
  timezone: string,
): Promise<{
  baseline: number | null;
  mature: boolean;
  source: "resting" | "proxy" | "none";
}> {
  const dayKeyOf = (d: Date) => userDayKey(d, timezone);
  // A day with resting rows from two sources keeps the one the person's
  // ladder puts first, so the median weighs each day once.
  const restingRows = pickCanonicalSourceRows(
    await prisma.measurement.findMany({
      where: { userId, type: "RESTING_HEART_RATE", deletedAt: null },
      orderBy: [{ measuredAt: "desc" }, { id: "desc" }],
      take: 90,
      select: {
        value: true,
        measuredAt: true,
        source: true,
        deviceType: true,
        type: true,
      },
    }),
    "restingHeartRate",
    await loadUserSourcePriority(userId),
    dayKeyOf,
  ).canonicalRows;

  // Only reach for the heavier PULSE-proxy read when the resting rows
  // cannot carry the baseline on their own: too few of them, OR the newest
  // one is already stale. Staleness matters because the retention fold mints
  // derived resting rows only for the days it has ALREADY folded, so a proxy
  // account accumulates plenty of resting rows for OLD days while the RECENT
  // days still hold nothing but raw PULSE. Gating on the row count alone
  // pinned the baseline to the fold horizon and never advanced it past it.
  // A genuinely native account reports a resting row daily, never trips the
  // staleness arm, and pays for no extra read.
  //
  // The proxy folds in Postgres, one row per local day. It used to read the
  // newest 365 PULSE rows and fold them here, which on a watch recording
  // every few seconds is the last quarter of an hour: one proxy day, a
  // baseline that never matured, and no tension window on any day.
  const newestRestingAt = restingRows[0]?.measuredAt ?? null;
  const restingIsStale =
    newestRestingAt === null ||
    Date.now() - newestRestingAt.getTime() > RESTING_STALE_AFTER_MS;
  const proxySamples =
    restingRows.length >= MIN_BASELINE_DAYS && !restingIsStale
      ? []
      : await readRestingPulseProxy({
          userId,
          since: new Date(Date.now() - PROXY_BASELINE_WINDOW_MS),
          timeZone: timezone,
        });

  const resolved = mergeRestingWithProxy({
    restingSamples: restingRows.map((r) => ({
      measuredAt: r.measuredAt,
      value: r.value,
    })),
    proxySamples,
    dayKeyOf,
  });

  const recentMedian = median(resolved.series.slice(-30).map((p) => p.value));
  return {
    baseline: recentMedian === null ? null : roundTo(recentMedian, 1),
    mature: resolved.series.length >= MIN_BASELINE_DAYS,
    source: resolved.which,
  };
}

/** Clamp a workout's local span to [0, 1440) minutes on `dateKey`, or null. */
function workoutToInterval(
  startedAt: Date,
  endedAt: Date,
  dateKey: string,
  localOf: LocalResolver,
): WorkoutInterval | null {
  const s = localOf(startedAt);
  const e = localOf(endedAt);
  // Reject spans entirely outside the day (both ends on another calendar day
  // on the same side); otherwise clamp an overhanging end into the day.
  const startMinute =
    s.dayKey === dateKey ? s.minuteOfDay : s.dayKey < dateKey ? 0 : -1;
  const endMinute =
    e.dayKey === dateKey ? e.minuteOfDay : e.dayKey > dateKey ? 24 * 60 : -1;
  if (startMinute < 0 || endMinute < 0 || endMinute <= startMinute) return null;
  return { startMinute, endMinute };
}

/**
 * Compute the intraday pulse shape + (cautious) tension window for one local
 * day. Deterministic given the DB state; performs no AI/provider call.
 */
export async function loadIntradayPulse(
  userId: string,
  timezone: string,
  dateKey: string,
): Promise<IntradayPulseResult> {
  const localOf = makeLocalResolver(timezone);
  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: anchor of a superset read window; rows are cut to the exact local day afterwards
  const anchorMs = new Date(`${dateKey}T00:00:00.000Z`).getTime();
  const start = new Date(anchorMs - WINDOW_LEAD_MS);
  const end = new Date(anchorMs + WINDOW_TRAIL_MS);
  // The PULSE and step reads cover the local day (DST-aware; 23/24/25h). The
  // raw readings fold into ten-minute buckets in Postgres
  // (`readLocalDayMinuteBuckets`), at most 144 rows for a day of any density;
  // a capped row read used to end the chart in the fourth hour of a watch
  // writing 35 000 rows a day. The `stats:` rows are aggregates already (an
  // uploaded ten-minute bucket, a folded hour) and are read as rows. The
  // workout read keeps the padded window: a workout can start the local day
  // before or end the local day after.
  const { dayStart, dayEnd } = localDayWindow(dateKey, timezone);

  const [
    rawPulseBuckets,
    statsPulseRows,
    stepBucketRows,
    workoutRows,
    baseline,
  ] = await Promise.all([
    readLocalDayMinuteBuckets({
      userId,
      type: "PULSE",
      dateKey,
      timeZone: timezone,
      bucketMinutes: BUCKET_MINUTES,
    }),
    prisma.measurement.findMany({
      where: {
        userId,
        type: "PULSE",
        deletedAt: null,
        measuredAt: { gte: dayStart, lt: dayEnd },
        externalId: { startsWith: "stats:" },
      },
      orderBy: { measuredAt: "asc" },
      select: {
        value: true,
        valueMin: true,
        valueMax: true,
        measuredAt: true,
        externalId: true,
      },
    }),
    // Intraday step buckets read Apple samples only: a `stats:` or provider
    // day total would dump the whole day's steps into one bucket and wrongly
    // mark an at-rest stretch as moving.
    readLocalDayMinuteBuckets({
      userId,
      type: "ACTIVITY_STEPS",
      dateKey,
      timeZone: timezone,
      bucketMinutes: BUCKET_MINUTES,
      sources: CUMULATIVE_SAMPLE_SOURCES,
    }),
    prisma.workout.findMany({
      where: {
        userId,
        startedAt: { lt: end },
        endedAt: { gt: start },
      },
      select: { startedAt: true, endedAt: true },
    }),
    resolveBaseline(userId, timezone),
  ]);

  // v1.30.7 (iOS #34) — the day's PULSE readings come in three shapes, told
  // apart by externalId (the shapes are disjoint, so this is unambiguous):
  //   · raw per-sample        — no `stats:` prefix, folded in SQL above;
  //   · uploaded 10-min bucket — `stats:HK…:<10-min ISO instant with Z>`
  //     (the go-forward aggregated wire contract);
  //   · server-folded hourly  — any other `stats:` row (the dense-intraday
  //     retention fold's `stats:<HK>:<day>T<HH>` local-hour output).
  // Per the per-day-exclusive cutover invariant a day is normally single-grain;
  // the one cutover-straddling local day is handled by the overlay below.
  const uploadedBucketRows = statsPulseRows.filter((r) =>
    isAggregatedBucketExternalId(r.externalId),
  );
  const foldedPulseRows = statsPulseRows.filter(
    (r) => !isAggregatedBucketExternalId(r.externalId),
  );

  // Same shape and rounding as `computeTenMinuteMeanSeries`: the mean and the
  // range to one decimal, the raw count kept for the density gate.
  const rawSeries: IntradayHrBucket[] = rawPulseBuckets.map((b) => ({
    startMinute: b.startMinute,
    mean: roundTo(b.sum / b.n, 1),
    count: b.n,
    min: roundTo(b.min, 1),
    max: roundTo(b.max, 1),
  }));
  const rawSampleRows = rawPulseBuckets.reduce((n, b) => n + b.n, 0);
  const bucketSeries = computeUploadedBucketSeries(
    uploadedBucketRows.flatMap((r) => {
      const bucketStart = parseAggregatedBucketStart(r.externalId);
      return bucketStart
        ? [{ bucketStart, mean: r.value, min: r.valueMin, max: r.valueMax }]
        : [];
    }),
    dateKey,
    localOf,
  );

  // Merge the two 10-min grains. Normal days are single-grain, so one of the
  // two is empty. The cutover-straddling local day is the only mix: overlay the
  // uploaded buckets onto the raw slots, bucket authoritative on collision
  // (the aggregate is the intended go-forward value for that slot).
  let tenMinSeries: IntradayHrBucket[];
  if (bucketSeries.length > 0 && rawSeries.length > 0) {
    const bySlot = new Map(rawSeries.map((b) => [b.startMinute, b]));
    for (const b of bucketSeries) bySlot.set(b.startMinute, b);
    tenMinSeries = [...bySlot.values()].sort(
      (a, b) => a.startMinute - b.startMinute,
    );
  } else {
    tenMinSeries = bucketSeries.length > 0 ? bucketSeries : rawSeries;
  }

  // Day-navigator fallback (S11 / v1.29.x): a day outside
  // `DENSE_INTRADAY_RETENTION_DAYS` has its raw rows tombstoned by the
  // retention fold, so `tenMinSeries` comes back empty even though the day's
  // shape survives at hour resolution in the folded `stats:` tier. Fall back
  // to that coarser read rather than rendering an empty chart. A day with
  // genuinely no data at all (never synced) stays on the empty "tenMin"
  // series — `foldedPulseRows` is empty there too, so `hourlySeries` is
  // empty and the branch below is skipped.
  const useHourlyFallback = tenMinSeries.length === 0;
  const hourlySeries = useHourlyFallback
    ? computeHourlyMeanSeries(
        foldedPulseRows.map((r) => ({
          measuredAt: r.measuredAt,
          value: r.value,
        })),
        dateKey,
        localOf,
      )
    : [];

  const resolution: IntradayResolution =
    useHourlyFallback && hourlySeries.length > 0 ? "hourly" : "tenMin";
  const series = resolution === "hourly" ? hourlySeries : tenMinSeries;

  const stepBuckets = new Map<number, number>(
    stepBucketRows.map((b) => [b.startMinute, b.sum]),
  );

  const workouts = workoutRows
    .map((w) => workoutToInterval(w.startedAt, w.endedAt, dateKey, localOf))
    .filter((w): w is WorkoutInterval => w !== null);

  // Tension needs per-sample resolution (see `detectTensionWindow`'s
  // docblock) — never compute it against the hourly fallback, regardless of
  // what the (independently folded) step tier happens to report.
  const tension =
    resolution === "tenMin"
      ? detectTensionWindow({
          buckets: series,
          baseline: baseline.baseline,
          baselineMature: baseline.mature,
          stepBuckets,
          workouts,
          hrvConfirmMinutes: [],
        })
      : null;

  // v1.32.1 (issue #585) — per-shape row/bucket breakdown. A report of
  // "the chart looks sparser after the ZIP-import cutoff" is otherwise
  // undiagnosable from server logs: the route's own annotation only ever
  // surfaced the FINAL bucket count, with no visibility into which
  // ingestion shape (raw ZIP-imported samples vs uploaded 10-min
  // aggregates) the day's data actually came from, nor how many DB rows
  // fed each shape before bucketing. Grepping `insights.pulse.intraday`
  // now shows both — e.g. `uploaded_bucket_rows: 6` next to
  // `ten_min_buckets: 6` confirms the uploaded shape IS being read and
  // placed 1:1, narrowing a future report to "the client uploaded too few
  // buckets" rather than leaving the read path itself as a live suspect.
  annotate({
    meta: {
      intraday_raw_sample_rows: rawSampleRows,
      intraday_uploaded_bucket_rows: uploadedBucketRows.length,
      intraday_folded_hourly_rows: foldedPulseRows.length,
      intraday_ten_min_buckets: tenMinSeries.length,
    },
  });

  return {
    dateKey,
    timezone,
    bucketMinutes:
      resolution === "hourly" ? HOURLY_BUCKET_MINUTES : BUCKET_MINUTES,
    series,
    baseline: baseline.baseline,
    baselineSource: baseline.source,
    tension,
    resolution,
  };
}
