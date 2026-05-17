import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { NO_STORE_BUT_BFCACHE } from "@/lib/http/cache-headers";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import { computeSummariesSlice } from "@/lib/analytics/summaries-slice";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { computeBpInTargetWindows } from "@/lib/analytics/bp-in-target";
import { userDayKey, DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import { calculateCompliance } from "@/lib/analytics/compliance";
import {
  computeHealthScore,
  defaultWeightTargetFromHeight,
  type ContributingSource,
  type HealthScoreInput,
  type HealthScoreResult,
} from "@/lib/analytics/health-score";
import {
  correlateBpCompliance,
  correlateMoodPulse,
  correlateWeightWeekday,
  type CorrelationResult,
} from "@/lib/insights/correlations";
import type {
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import { pickCanonicalSourceRows } from "@/lib/analytics/source-priority";
import type { SourcePriorityMetricKey } from "@/lib/validations/source-priority";
import { ensureUserRollupsFresh } from "@/lib/measurements/rollups";
import {
  isCumulativeDaySumType,
  pickCumulativeDaySum,
} from "@/lib/measurements/cumulative-day-sum";

export const dynamic = "force-dynamic";

/**
 * v1.4.36 W4c — cumulative MeasurementType → SourcePriorityMetricKey
 * for `pickCanonicalSourceRows`. Returns `null` for types without a
 * dedicated priority ladder (e.g. TIME_IN_DAYLIGHT), which fall
 * through the picker's "no ladder" pass-through branch.
 */
function cumulativeMetricKey(
  type: MeasurementType,
): SourcePriorityMetricKey | null {
  switch (type) {
    case "ACTIVITY_STEPS":
      return "steps";
    case "ACTIVE_ENERGY_BURNED":
      return "activeEnergy";
    case "WALKING_RUNNING_DISTANCE":
      return "walkingRunningDistance";
    case "FLIGHTS_CLIMBED":
      return "flightsClimbed";
    default:
      return null;
  }
}

/**
 * v1.4.33 C1 — pull `?slice=…` from either a NextRequest (the
 * route's production wrapper) or a plain `Request` (the integration
 * tests instantiate `new Request("http://localhost/api/analytics")`
 * and cast through). Falls back to the raw `URL(request.url)` parse
 * so the slim slice branch is reachable from both call shapes.
 */
function readSliceParam(request: Request | undefined): string | null {
  if (!request) return null;
  try {
    return new URL(request.url).searchParams.get("slice");
  } catch {
    return null;
  }
}

export const GET = apiHandler(async (request?: Request) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "analytics.get" } });

  // v1.4.33 C1 — slim summaries slice for the dashboard tile strip.
  // The default path runs 30+ chunked findMany reads to feed
  // `summarize()` per type; under `?slice=summaries` the route
  // resolves the same per-type DataSummary shape from 2 SQL passes
  // (a `groupBy` for count/min/max/mean plus a single `$queryRaw`
  // carrying the windowed averages and Postgres `regr_slope` /
  // `regr_r2` for the slope tuples). The slim slice drops the thick
  // `correlations` / `healthScore` / `bpInTargetPct` / `glucoseByContext`
  // / `sleepStages` / `bmi` blocks — those stay on the default path
  // behind a hover-prefetch from the Coach drawer + the correlation
  // tile's `<InView>` boundary. Consumers that need only the headline
  // tile values land on this branch and skip the heavy chain.
  if (readSliceParam(request) === "summaries") {
    // v1.4.34 IW-G — read-through the analytics cache keyed on
    // (userId, slice). The slim slice is the dashboard tile strip's hot
    // path; multiple dashboard mounts inside a 60-second TTL all hit a
    // warm cache.
    const slim = await cached(
      caches.analytics as ServerCache<Awaited<ReturnType<typeof computeSummariesSlice>>>,
      `${user.id}|summaries`,
      () => computeSummariesSlice(user.id),
      annotate,
    );
    // v1.4.34 IW-B — bfcache-friendly directive on the slim slice too
    // so a back-forward navigation that landed on the dashboard tile
    // strip can restore from memory instead of paying a full reload.
    const slimRes = apiSuccess(slim);
    slimRes.headers.set("Cache-Control", NO_STORE_BUT_BFCACHE);
    return slimRes;
  }

  // v1.4.34 IW-G — wrap the heavy default-slice body in the analytics
  // cache keyed on (userId, "default"). The dashboard, the checklist
  // mount, and the Coach drawer all hit this endpoint within seconds
  // of each other; the 60s TTL converts the 7.99s combined dashboard
  // wait to a Map lookup on every subsequent caller.
  const body = await cached(
    caches.analytics as ServerCache<Awaited<ReturnType<typeof buildAnalyticsResponse>>>,
    `${user.id}|default`,
    () => buildAnalyticsResponse(user),
    annotate,
  );

  const response = apiSuccess(body);
  // v1.4.34 IW-B — bfcache-friendly directive so back-forward navigation
  // restores the dashboard from memory. Per `src/lib/http/cache-headers.ts`:
  // `private` keeps shared caches out of personal data, `max-age=0` forces
  // revalidation on every navigation so session swaps detect on the wire,
  // and `must-revalidate` holds the staleness contract. Replaces the
  // framework's stock `no-store` which Chromium treats as a hard
  // bfcache breaker.
  response.headers.set("Cache-Control", NO_STORE_BUT_BFCACHE);
  return response;
});

type AuthedUser = Awaited<ReturnType<typeof requireAuth>>["user"];

/**
 * v1.4.34 IW-G — the heavy default-slice body, lifted out of the route
 * handler so `cached()` can wrap it. Returns the raw JSON payload; the
 * route handler attaches `Cache-Control` headers afterward. The split
 * matches the v1.4.33 snapshot LRU's `buildCoachSnapshot` →
 * `buildCoachSnapshotImpl` shape.
 */
async function buildAnalyticsResponse(user: AuthedUser) {
  // v1.5.0 — warm the persistent rollup table as a side effect of
  // the analytics fan-out. No-op when rollups are already ahead of
  // the newest measurement; on first cold-mount after a process
  // restart it folds the trailing 90-day window so downstream
  // consumers (Coach drawer, weekly report, admin analytics) see a
  // warm rollup table on their next read. The route's response
  // shape is untouched.
  await ensureUserRollupsFresh(user.id);

  // v1.4.25 W7b — every day-bucket call inside this route now honours
  // the user's display timezone. The legacy `berlinDayKey()` import
  // remains for sleep-stage and correlation paths that share their
  // helper signature with non-tz-aware code (`computeSleepStageBreakdown`
  // is called with a userId only); the per-call sites below all pass
  // `userTz` through `userDayKey()`.
  const userTz = user.timezone ?? DEFAULT_TIMEZONE;

  // Derived from canonical enum so a new measurement type is auto-summarised
  // by /api/analytics (V3 audit: enum drift cousins).
  const types = [...measurementTypeEnum.options] as MeasurementType[];

  // v1.4.23 Sr-H1 — every per-type read goes through the chunked helper
  // so the route's working set stays bounded at MEASUREMENT_CHUNK_SIZE
  // rows per Prisma round-trip even for users with multi-year HealthKit
  // sync history. `summarize()` requires the full series (slope7/30/90,
  // anomalies) so groupBy cannot replace this read; the chunked path is
  // the smallest pagination contract that still satisfies the helper.
  // v1.4.25 W5e — per-metric-class source priority pulled once. The
  // aggregator passes the persisted JSON straight through so the
  // helper's `parseSourcePriority` runs and falls back to defaults
  // when the column is null or malformed.
  const sourcePriorityJson = user.sourcePriorityJson;

  // v1.4.34 IW-B — capture the most-recent `measuredAt` per type so the
  // dashboard tile strip can render an "Letzter Wert vor Xd" caption on
  // tiles whose latest reading is older than a week. The series read
  // already orders ascending (`fetchMeasurementSeriesChunked`'s stable
  // `(measuredAt, id)` order); the last entry is the freshest sample.
  // Surface as ISO + a server-computed `daysAgo` so the client never
  // has to do tz-aware date math to colour the tile.
  const nowForStaleness = new Date();
  const lastSeenByType: Record<string, {
    lastSeenAt: string;
    daysAgo: number;
  } | null> = {};

  let totalRowsReadForAggregate = 0;
  const measurementsByType = await Promise.all(
    types.map((type) =>
      fetchMeasurementSeriesChunked(user.id, type, {
        includeSleepStage: true,
      }).then((measurements) => {
        totalRowsReadForAggregate += measurements.length;
        // v1.4.34 IW-B — record the freshest `measuredAt` for this type
        // (or null when the user has never logged this metric). The
        // helper returns rows sorted ascending so `.at(-1)` is the
        // most-recent point without an extra pass.
        const latest = measurements.at(-1);
        if (latest) {
          const daysAgo = Math.floor(
            (nowForStaleness.getTime() - latest.measuredAt.getTime()) /
              (24 * 60 * 60 * 1000),
          );
          lastSeenByType[type] = {
            lastSeenAt: latest.measuredAt.toISOString(),
            daysAgo,
          };
        } else {
          lastSeenByType[type] = null;
        }
        // v1.4.23 — Apple Health's sleep ingest stores one row per
        // stage per night. Summarising the raw rows would treat each
        // stage as its own datapoint and grossly understate "average
        // sleep". Aggregate per Berlin day before summarising so the
        // summary matches the user's intuition (one number per night
        // = total minutes asleep).
        let datapoints: DataPoint[];
        if (type === "SLEEP_DURATION") {
          // v1.4.25 W5e — pick ONE source per day before summing the
          // night's stages. With only WITHINGS + MANUAL today, the
          // picker passes everything through; once iOS passthrough
          // lands (v1.5) the picker prevents double-counted nights
          // (HealthKit forwards Withings' Sleep summary to iOS in
          // addition to ScanWatch's own stream).
          const sleepRows = pickCanonicalSourceRows(
            measurements,
            "sleep",
            sourcePriorityJson,
            (d) => userDayKey(d, userTz),
          ).canonicalRows;
          datapoints = pickCumulativeDaySum(sleepRows, (d) =>
            userDayKey(d, userTz),
          );
        } else if (isCumulativeDaySumType(type)) {
          // v1.4.36 W4c — broaden the SLEEP_DURATION day-bucket-sum
          // pattern to every cumulative metric (steps, active energy,
          // walking + running distance, flights climbed, time in
          // daylight). Apple Health writes minute-level slices for
          // these series; the dashboard tile was reading the
          // *latest slice* via `summary.latest` instead of the day's
          // total, which Marc reported as "Steps tile shows
          // last-measurement-not-day-sum". After the per-day sum
          // collapse, `summary.latest` is the most-recent day's
          // total — exactly what the tile expects.
          //
          // Map cumulative MeasurementType → SourcePriorityMetricKey
          // for the canonical-row picker. TIME_IN_DAYLIGHT has no
          // dedicated priority ladder (no clinical-grade competitor
          // to Apple Health for daylight minutes today) so it falls
          // through `pickCanonicalSourceRows`'s "no ladder"
          // pass-through branch — we ALWAYS bucket-and-sum it
          // regardless of source.
          const metricKey = cumulativeMetricKey(type);
          const canonicalRows = metricKey
            ? pickCanonicalSourceRows(
                measurements,
                metricKey,
                sourcePriorityJson,
                (d) => userDayKey(d, userTz),
              ).canonicalRows
            : measurements;
          datapoints = pickCumulativeDaySum(canonicalRows, (d) =>
            userDayKey(d, userTz),
          );
        } else {
          datapoints = measurements.map(
            (m): DataPoint => ({
              date: m.measuredAt,
              value: m.value,
            }),
          );
        }
        return {
          type,
          summary: summarize(datapoints),
        };
      }),
    ),
  );

  const results: Record<string, ReturnType<typeof summarize>> = {};
  for (const { type, summary } of measurementsByType) {
    results[type] = summary;
  }

  // v1.4.23 Sr-H1 — slow-query attribution. Total rows pulled across
  // every per-type chunked read so ops can spot outlier users whose
  // analytics requests dominate the route's tail latency.
  annotate({
    meta: {
      analytics: {
        bp_aggregate: { row_count: totalRowsReadForAggregate },
      },
    },
  });

  // v1.4.23 — sleep-stage breakdown for the trailing 30 days. Only
  // included when the user has stage-tagged rows in window; null
  // otherwise so the UI can render a plain total without the
  // breakdown card painting empty.
  const sleepStages = await computeSleepStageBreakdown(user.id, userTz);

  // BMI calculation
  let bmi: number | null = null;
  if (user.heightCm && results.WEIGHT?.latest) {
    const heightM = user.heightCm / 100;
    bmi = Math.round((results.WEIGHT.latest / (heightM * heightM)) * 10) / 10;
  }

  // BP in-target percentage (auto-calculated from date of birth)
  let bpInTargetPct: number | null = null;
  let bpInTargetPct7d: number | null = null;
  let bpInTargetPct30d: number | null = null;
  let bpInTargetPctAllTime: number | null = null;
  /**
   * v1.4.22 W5 reconcile (Code-H2) — period-aligned prior-window
   * pcts so the BD-Zielbereich tile's comparison-overlay caption
   * stops mismatching its math with its label. The tile's
   * `compareDelta` is `last30Days - priorMonth` (or `… - priorYear`)
   * matching the user's `comparisonBaseline` selection, never
   * `last30Days - allTime` (the v1.4.22 A2 shortcut).
   */
  let bpInTargetPctPriorMonth: number | null = null;
  let bpInTargetPctPriorYear: number | null = null;
  const bpTargets = getBpTargets(user.dateOfBirth);
  if (bpTargets) {
    const now = new Date();
    // v1.4.22 A1 — re-anchor the BD-Zielbereich tile headline to the
    // last-30-day window. Up to v1.4.19 the headline pinned to the
    // 30-day average (so 7d / 30d / total all read 50 %). v1.4.19 A1
    // flipped the headline to all-time, which made the tile correct
    // but emotionally wrong: the headline was the slowest-moving
    // aggregate possible, punishing recent improvement. v1.4.22 A1
    // re-routes the headline to last-30-days and surfaces 7d / 30d /
    // all-time as a 3-line sub-row so power users still see the
    // long-arc number without it dominating. The helper still returns
    // every window — only the headline pick changed.
    //
    // v1.4.23 H2 — chunked aggregation replaces an unbounded findMany.
    // The W2-of-v1.4.20 fix did the right thing semantically (all-time
    // window for the headline) but read the entire BP table into one
    // array per type. A 5-year power user holds ~9 000 rows × 2; the
    // single-shot fetch produced a 50-100 ms Prisma round-trip plus a
    // ~2 MB allocation per request. Page through in 5 000-row chunks
    // so the working set stays bounded; accumulate into the same
    // `BpReading[]` shape the existing helper expects. The
    // `analytics.bp_in_target.row_count` wide-event meta lets ops
    // attribute slow requests to specific outlier users.
    // v1.4.29 M1 — bound the BP-in-target reads to the trailing
    // 365 days. `computeBpInTargetWindows` only needs the last
    // year (the longest sub-window it computes is `priorYear`);
    // pre-bound, each chunked walk pulled the entire BP history
    // every dashboard mount.
    const bpInTargetSince = new Date(
      now.getTime() - 365 * 24 * 60 * 60 * 1000,
    );
    const [sysData, diaData] = await Promise.all([
      fetchMeasurementSeriesChunked(user.id, "BLOOD_PRESSURE_SYS", {
        since: bpInTargetSince,
      }),
      fetchMeasurementSeriesChunked(user.id, "BLOOD_PRESSURE_DIA", {
        since: bpInTargetSince,
      }),
    ]);

    annotate({
      meta: {
        analytics: {
          bp_in_target: {
            row_count: sysData.length + diaData.length,
            sys_rows: sysData.length,
            dia_rows: diaData.length,
          },
        },
      },
    });

    const windows = computeBpInTargetWindows(sysData, diaData, bpTargets, now);
    bpInTargetPct = windows.last30Days?.pct ?? null;
    bpInTargetPct7d = windows.last7Days?.pct ?? null;
    bpInTargetPct30d = windows.last30Days?.pct ?? null;
    bpInTargetPctAllTime = windows.allTime?.pct ?? null;
    bpInTargetPctPriorMonth = windows.priorMonth?.pct ?? null;
    bpInTargetPctPriorYear = windows.priorYear?.pct ?? null;
  }

  // Per-context glucose summaries (canonical mg/dL).
  //
  // v1.4.29 H2 — bound to the trailing 30 days. The dashboard tile
  // path only reads the trailing window; pre-bound this query
  // walked every persisted BG row a multi-year user has written.
  const glucoseSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const glucoseRows = await prisma.measurement.findMany({
    where: {
      userId: user.id,
      type: "BLOOD_GLUCOSE",
      measuredAt: { gte: glucoseSince },
    },
    orderBy: { measuredAt: "asc" },
    select: { value: true, measuredAt: true, glucoseContext: true },
  });
  const glucoseByContext: Record<string, ReturnType<typeof summarize>> = {};
  if (glucoseRows.length > 0) {
    const contexts = ["FASTING", "POSTPRANDIAL", "RANDOM", "BEDTIME"] as const;
    for (const ctx of contexts) {
      const ctxRows = glucoseRows.filter((r) => r.glucoseContext === ctx);
      if (ctxRows.length === 0) continue;
      glucoseByContext[ctx] = summarize(
        ctxRows.map((r): DataPoint => ({ date: r.measuredAt, value: r.value })),
      );
    }
  }

  // v1.4.20 phase B3 — three pre-defined correlation hypotheses.
  // All three run on the trailing 30 days so a sparse account doesn't
  // burn the n >= 20 gate on a stale window (v1.4.23 H6 raised the
  // floor from 14 → 20). Each runner gates on n >= 20 + p < 0.05;
  // below the bar the result.status === "insufficient" and the UI
  // paints an EmptyState.
  const correlations = await computeCorrelationHypotheses(user.id, userTz);

  // v1.4.20 phase B5 — Personal Health Score. Server-deterministic
  // composite of BP-in-target % + weight-trend alignment + mood
  // stability + medication compliance. The "vs last week" delta
  // re-runs the same compute against a 7-day-shifted snapshot.
  const healthScore = await computeUserHealthScore(user.id, {
    bpInTargetPct,
    heightCm: user.heightCm ?? null,
  });
  if (healthScore) {
    annotate({
      meta: {
        healthScore: {
          score: healthScore.score,
          band: healthScore.band,
          delta: healthScore.delta,
        },
      },
    });
  }

  return {
    summaries: results,
    bmi,
    bpInTargetPct,
    bpInTargetPct7d,
    bpInTargetPct30d,
    bpInTargetPctAllTime,
    bpInTargetPctPriorMonth,
    bpInTargetPctPriorYear,
    glucoseByContext,
    correlations,
    healthScore,
    sleepStages,
    // v1.4.34 IW-B — per-type freshness map drives the dashboard's
    // staleness caption on each `<TrendCard>`. Additive: clients that
    // don't read the field stay unchanged.
    lastSeenByType,
  };
}

/**
 * Per-stage sleep-minutes breakdown over the trailing 30 days.
 *
 * Returns `null` when the user has no stage-tagged sleep rows in
 * window — the analytics consumer renders the existing
 * `summaries.SLEEP_DURATION` totals without a stage card in that
 * case. Returns the sum-per-stage AND the day count covered so the
 * UI can render an "averaged across N nights" caption truthfully.
 *
 * v1.4.25 W3f — also returns a `perNight` array: one entry per
 * Berlin-tz day inside the window, with minutes-per-stage for the
 * stacked-bar chart. Days with zero stage-tagged rows are omitted
 * from `perNight` (the chart treats them as gaps).
 */
async function computeSleepStageBreakdown(
  userId: string,
  userTz: string,
): Promise<{
  windowDays: number;
  nights: number;
  totalMinutes: number;
  stages: Record<string, number>;
  perNight: Array<{ dayKey: string; stages: Record<string, number> }>;
} | null> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const since = new Date(Date.now() - 30 * DAY_MS);
  const rows = await prisma.measurement.findMany({
    where: {
      userId,
      type: "SLEEP_DURATION",
      sleepStage: { not: null },
      measuredAt: { gte: since },
    },
    select: { value: true, measuredAt: true, sleepStage: true },
  });

  if (rows.length === 0) return null;

  const stages: Record<string, number> = {};
  const dayKeys = new Set<string>();
  let totalMinutes = 0;
  // v1.4.25 W3f — per-day accumulator. Keyed by Berlin-tz day so the
  // chart's 7/14/30-day slicer can build a left-aligned series.
  const perNightMap = new Map<string, Record<string, number>>();
  for (const row of rows) {
    if (!row.sleepStage) continue;
    stages[row.sleepStage] = (stages[row.sleepStage] ?? 0) + row.value;
    totalMinutes += row.value;
    const dayKey = userDayKey(row.measuredAt, userTz);
    dayKeys.add(dayKey);
    const nightStages = perNightMap.get(dayKey) ?? {};
    nightStages[row.sleepStage] =
      (nightStages[row.sleepStage] ?? 0) + row.value;
    perNightMap.set(dayKey, nightStages);
  }

  // Sort per-night ascending so the chart consumer can slice the
  // trailing N entries for the 7d / 14d / 30d toggle.
  const perNight = Array.from(perNightMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dayKey, stages]) => ({ dayKey, stages }));

  return {
    windowDays: 30,
    nights: dayKeys.size,
    totalMinutes,
    stages,
    perNight,
  };
}

/**
 * Build inputs for the three pre-defined hypotheses + run them.
 * Pure-ish — only Prisma reads, no external calls.
 *
 * Window: trailing 30 days. Anything older falls outside the surface
 * because the user-facing "based on N paired readings · last 30 days"
 * source-chip has to remain truthful.
 */
async function computeCorrelationHypotheses(
  userId: string,
  userTz: string,
): Promise<{
  bpCompliance: CorrelationResult;
  moodPulse: CorrelationResult;
  weightWeekday: CorrelationResult;
}> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const since = new Date(Date.now() - 30 * DAY_MS);

  // v1.4.23 Sr-H1 — the four measurement reads route through the
  // chunked helper so even a noisy 30-day window (e.g. minute-level
  // HealthKit pulse samples) cannot allocate an unbounded buffer. The
  // helper still returns the full filtered series the Pearson runners
  // need; we just bound the per-page Prisma round-trip.
  const [sysRows, pulseRows, weightRows, moodRows, intakeRows] =
    await Promise.all([
      fetchMeasurementSeriesChunked(userId, "BLOOD_PRESSURE_SYS", { since }),
      fetchMeasurementSeriesChunked(userId, "PULSE", { since }),
      fetchMeasurementSeriesChunked(userId, "WEIGHT", { since }),
      prisma.moodEntry.findMany({
        where: { userId, moodLoggedAt: { gte: since } },
        select: { score: true, moodLoggedAt: true, date: true },
      }),
      prisma.medicationIntakeEvent.findMany({
        where: { userId, scheduledFor: { gte: since } },
        select: { scheduledFor: true, takenAt: true, skipped: true },
      }),
    ]);

  // ── Hypothesis 1: BP × medication compliance ────────────────
  // Aggregate by the user's display-tz day key so DST + UTC boundary
  // issues don't split a day's readings. The day's "compliance %" is
  // taken / expected for that calendar day across all medications.
  const dayKey = (d: Date): string => userDayKey(d, userTz);

  const dailySys = new Map<string, number[]>();
  for (const row of sysRows) {
    const key = dayKey(row.measuredAt);
    const list = dailySys.get(key) ?? [];
    list.push(row.value);
    dailySys.set(key, list);
  }

  const dailyCompliance = new Map<
    string,
    { expected: number; taken: number }
  >();
  for (const event of intakeRows) {
    const key = dayKey(event.scheduledFor);
    const slot = dailyCompliance.get(key) ?? { expected: 0, taken: 0 };
    slot.expected += 1;
    if (event.takenAt && !event.skipped) slot.taken += 1;
    dailyCompliance.set(key, slot);
  }

  const bpCompliancePairs: Array<{
    date: Date;
    systolic: number;
    compliancePct: number;
  }> = [];
  for (const [key, sysValues] of dailySys.entries()) {
    const slot = dailyCompliance.get(key);
    if (!slot || slot.expected === 0) continue;
    const compliancePct = (slot.taken / slot.expected) * 100;
    const meanSys = sysValues.reduce((s, v) => s + v, 0) / sysValues.length;
    bpCompliancePairs.push({
      date: dateFromDayKey(key),
      systolic: meanSys,
      compliancePct,
    });
  }
  const bpCompliance = correlateBpCompliance({ daily: bpCompliancePairs });

  // ── Hypothesis 2: Mood × resting pulse ──────────────────────
  // Same-day pairing: take the day's mean mood vs the day's mean pulse.
  // "Resting" is approximated by mean — HealthLog has no separate
  // resting-pulse field, so we accept the noise rather than skip.
  const dailyMood = new Map<string, number[]>();
  for (const row of moodRows) {
    const key = userDayKey(row.moodLoggedAt, userTz);
    const list = dailyMood.get(key) ?? [];
    list.push(row.score);
    dailyMood.set(key, list);
  }
  const dailyPulse = new Map<string, number[]>();
  for (const row of pulseRows) {
    const key = userDayKey(row.measuredAt, userTz);
    const list = dailyPulse.get(key) ?? [];
    list.push(row.value);
    dailyPulse.set(key, list);
  }
  const moodPulsePairs: Array<{
    date: Date;
    mood: number;
    restingPulse: number;
  }> = [];
  for (const [key, moodScores] of dailyMood.entries()) {
    const pulseValues = dailyPulse.get(key);
    if (!pulseValues || pulseValues.length === 0) continue;
    const meanMood = moodScores.reduce((s, v) => s + v, 0) / moodScores.length;
    const meanPulse =
      pulseValues.reduce((s, v) => s + v, 0) / pulseValues.length;
    moodPulsePairs.push({
      date: dateFromDayKey(key),
      mood: meanMood,
      restingPulse: meanPulse,
    });
  }
  const moodPulse = correlateMoodPulse({ daily: moodPulsePairs });

  // ── Hypothesis 3: Weight × weekday ──────────────────────────
  // 0 = Monday … 6 = Sunday. ISO weekday minus 1.
  //
  // v1.4.25 W10 reconcile (Code-H1) — buckets the weekday by the
  // user's display tz, matching W7's per-user-tz threading that the
  // BP, mood, sleep, and pulse aggregators above already honour. The
  // pre-W10 helper was pinned to `Europe/Berlin` and would land a
  // user-local 23:30 weight reading from `Pacific/Auckland` under
  // Sunday's bucket instead of Monday's — Pearson on the wrong
  // weekday column.
  const weightWeekdayPairs: Array<{ weekday: number; weight: number }> = [];
  for (const row of weightRows) {
    const isoWeekday = isoWeekdayInTz(row.measuredAt, userTz); // 1..7, 1=Mon
    weightWeekdayPairs.push({
      weekday: isoWeekday - 1,
      weight: row.value,
    });
  }
  const weightWeekday = correlateWeightWeekday({ daily: weightWeekdayPairs });

  // Annotate so admin observability can attribute coverage to the
  // corresponding wide-event rather than chasing it via DB queries.
  annotate({
    meta: {
      correlations: {
        bpCompliance: bpCompliance.status,
        moodPulse: moodPulse.status,
        weightWeekday: weightWeekday.status,
      },
    },
  });

  return { bpCompliance, moodPulse, weightWeekday };
}

/**
 * v1.4.23 Sr-H1 — paged read of every Measurement of a given type for
 * a single user.
 *
 * Boundary contract:
 *   - The route's per-type loop, the BD-Zielbereich BP windowing, and
 *     the correlation-hypothesis reads ALL pull through this helper so
 *     no analytics path holds an unbounded `findMany` against
 *     `measurement` any more.
 *   - `summarize()` (slope7/30/90, anomaly z-scores) and
 *     `computeBpInTargetWindows` (paired sys/dia matching) both need
 *     row-level access that `prisma.groupBy` cannot provide; chunked
 *     paging is the smallest contract that bounds the working set
 *     without changing the helpers.
 *   - The cursor is `id` with a stable `(measuredAt, id)` order so two
 *     rows sharing a timestamp (bulk-imported manual entries) don't
 *     stall the cursor or duplicate a row across pages.
 *
 * Page size is `MEASUREMENT_CHUNK_SIZE`; the safety-bound loop caps
 * total pages at 1 000 (= 5 M rows) which is well above any plausible
 * single-user single-type plausibility range — defence in depth against
 * a cursor-staleness infinite-loop bug.
 *
 * `since` lets the correlation path pull only the trailing 30 days
 * without first reading older rows. `includeSleepStage` opts the
 * per-type loop into the SLEEP_DURATION-only field.
 */
const MEASUREMENT_CHUNK_SIZE = 5000;

interface ChunkedRow {
  measuredAt: Date;
  value: number;
  sleepStage: string | null;
  /** v1.4.25 W5e — needed by `pickCanonicalSourceRows` so the SLEEP /
   *  cumulative aggregators can pick ONE source per day when more than
   *  one ingest path contributes to the same metric. */
  source: MeasurementSource;
  /** v1.4.25 W8c — second axis of the canonical picker. Nullable until
   *  the iOS app starts shipping HKDevice.model with each sample;
   *  legacy / Withings rows stay NULL and the picker treats them as
   *  `unknown`. Carried on every type's read so the cumulative-metric
   *  path can break Apple-Watch-vs-iPhone ties.
   */
  deviceType: string | null;
  /** v1.4.25 W8c — feeds the per-MeasurementType device-type override
   *  inside the picker. The picker keys
   *  `deviceTypePriority[type]` off this so the user's "phone wins for
   *  steps but watch wins for HR" config is honoured. */
  type: MeasurementType;
}

async function fetchMeasurementSeriesChunked(
  userId: string,
  type: MeasurementType,
  options: { since?: Date; includeSleepStage?: boolean } = {},
): Promise<ChunkedRow[]> {
  const out: ChunkedRow[] = [];
  let cursorId: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const chunk = await prisma.measurement.findMany({
      where: {
        userId,
        type,
        ...(options.since ? { measuredAt: { gte: options.since } } : {}),
      },
      orderBy: [{ measuredAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        measuredAt: true,
        value: true,
        source: true,
        // v1.4.25 W8c — read deviceType so the canonical picker can
        // honour the per-metric / per-device override. Nullable until
        // iOS sends it.
        deviceType: true,
        ...(options.includeSleepStage ? { sleepStage: true } : {}),
      },
      take: MEASUREMENT_CHUNK_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
    if (chunk.length === 0) break;
    for (const row of chunk) {
      out.push({
        measuredAt: row.measuredAt,
        value: row.value,
        source: row.source,
        deviceType: row.deviceType ?? null,
        type,
        sleepStage:
          "sleepStage" in row
            ? ((row.sleepStage as string | null) ?? null)
            : null,
      });
    }
    if (chunk.length < MEASUREMENT_CHUNK_SIZE) break;
    cursorId = chunk[chunk.length - 1].id;
  }
  return out;
}

// v1.4.22 W5 reconcile (Code-MED-3) — `berlinDayKey()` lifted to
// `src/lib/analytics/berlin-day.ts` so the targets route's sparkline
// bucketing shares the same Europe/Berlin contract. The
// `weekday: "short"` formatter still lives here because it's only
// used by `isoWeekdayInTz()` below.
//
// v1.4.25 W10 reconcile (Code-H1) — formatter is now per-tz so the
// weight-weekday correlator honours the same per-user-tz contract the
// BP/mood/pulse aggregators above already use. Memoised by tz so the
// formatter is built once per unique timezone per process (tz strings
// rarely change at runtime; the cache is bounded by the IANA database
// to a few hundred entries even in the worst case).
const WEEKDAY_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
function getWeekdayFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = WEEKDAY_FORMATTER_CACHE.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    });
    WEEKDAY_FORMATTER_CACHE.set(timeZone, formatter);
  }
  return formatter;
}

function dateFromDayKey(key: string): Date {
  // Anchor to UTC midnight — the date is a sortable bucket label rather
  // than a wall-clock timestamp, so DST drift is irrelevant. The tz
  // info is already baked into the key (built via `userDayKey` upstream).
  return new Date(`${key}T00:00:00.000Z`);
}

const ISO_WEEKDAY: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

function isoWeekdayInTz(d: Date, timeZone: string): number {
  const parts = getWeekdayFormatter(timeZone).formatToParts(d);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return ISO_WEEKDAY[weekday] ?? 1;
}


/**
 * v1.4.25 W8e — collapse the persisted `MeasurementSource` enum onto
 * the camelCase token set the health-score analytics layer consumes.
 *
 * - `MANUAL` and `IMPORT` (CSV import — still user-supplied data) both
 *   surface as `"manual"`.
 * - `WITHINGS` and `APPLE_HEALTH` ride one-to-one.
 *
 * Returns `null` for source values that don't fall into the three
 * exposed buckets — defence-in-depth in case the enum grows before the
 * client is taught about it.
 */
function mapMeasurementSourceToLabel(
  source: MeasurementSource,
): ContributingSource | null {
  switch (source) {
    case "MANUAL":
    case "IMPORT":
      return "manual";
    case "WITHINGS":
      return "withings";
    case "APPLE_HEALTH":
      return "appleHealth";
    default:
      return null;
  }
}

/**
 * v1.4.25 W8e — deduplicate the contributing-source list for a single
 * component. Returns the empty array when nothing in the input maps
 * onto a known label so downstream `resolveSourceLabel` falls through
 * to `none` (matches the empty-state branch).
 */
function uniqueComponentSources(
  rows: ReadonlyArray<MeasurementSource>,
): ReadonlyArray<ContributingSource> {
  const seen = new Set<ContributingSource>();
  for (const src of rows) {
    const label = mapMeasurementSourceToLabel(src);
    if (label) seen.add(label);
  }
  return Array.from(seen);
}

/**
 * Build the Health Score input from the user's last-30-day weight,
 * mood, and medication-compliance data, plus the already-computed
 * `bpInTargetPct` headline. Re-runs the same compute against a
 * 7-day-shifted window to populate the "vs last week" delta.
 *
 * Returns null when the score wouldn't carry any signal (every
 * component nullable + no medications). The route surfaces the
 * `null` to the UI so the hero panel hides cleanly.
 */
async function computeUserHealthScore(
  userId: string,
  input: { bpInTargetPct: number | null; heightCm: number | null },
): Promise<HealthScoreResult | null> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date();
  const since30d = new Date(now.getTime() - 30 * DAY_MS);
  // Prior week's snapshot — shift everything 7 days into the past so
  // both windows close at the same wall-clock-of-day boundary.
  const prevSince30d = new Date(now.getTime() - 37 * DAY_MS);
  const prevUntil = new Date(now.getTime() - 7 * DAY_MS);

  // v1.4.25 W8e — read the `source` column alongside the value so the
  // health-score provenance accordion knows which ingest path drove
  // each component. The weight + BP reads already paid the row cost;
  // adding the column to the SELECT is free in Postgres terms (no extra
  // round-trip, no extra plan node) and the alternative — a second
  // aggregate just for the source pill — would burn another findMany.
  const [weightRows, bpSysRowsForSource, moodRows, medications] =
    await Promise.all([
      prisma.measurement.findMany({
        where: {
          userId,
          type: "WEIGHT",
          measuredAt: { gte: prevSince30d, lte: now },
        },
        select: { value: true, measuredAt: true, source: true },
        orderBy: { measuredAt: "asc" },
      }),
      // BP source attribution rides on the systolic-readings row set —
      // diastolic rows always carry the same `source` because both
      // halves of a pair are persisted in the same write. Pull only the
      // trailing 30 days to keep the call bounded for power users.
      prisma.measurement.findMany({
        where: {
          userId,
          type: "BLOOD_PRESSURE_SYS",
          measuredAt: { gte: since30d, lte: now },
        },
        select: { measuredAt: true, source: true },
        orderBy: { measuredAt: "asc" },
      }),
      prisma.moodEntry.findMany({
        where: {
          userId,
          moodLoggedAt: { gte: prevSince30d, lte: now },
        },
        select: { score: true, moodLoggedAt: true },
        orderBy: { moodLoggedAt: "asc" },
      }),
      prisma.medication.findMany({
        where: { userId, active: true },
        select: {
          id: true,
          createdAt: true,
          schedules: {
            select: {
              windowStart: true,
              windowEnd: true,
            },
          },
        },
      }),
    ]);

  // Compliance30 per active medication, then again for the prior-week
  // snapshot. The compliance helper anchors on `Date.now()` internally;
  // for the previous-week snapshot we reuse the same helper but pass a
  // shifted "createdAt" floor so the window mathematically reflects the
  // [-37d, -7d] period — equivalent to running the helper a week ago.
  let medicationCompliance30: number[] = [];
  let medicationCompliance30Previous: number[] = [];
  if (medications.length > 0) {
    const medIds = medications.map((m) => m.id);
    const intakeEvents = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId,
        medicationId: { in: medIds },
        scheduledFor: { gte: prevSince30d, lte: now },
      },
      select: {
        medicationId: true,
        scheduledFor: true,
        takenAt: true,
        skipped: true,
      },
    });
    const eventsByMed = new Map<string, typeof intakeEvents>();
    for (const ev of intakeEvents) {
      const list = eventsByMed.get(ev.medicationId);
      if (list) list.push(ev);
      else eventsByMed.set(ev.medicationId, [ev]);
    }
    medicationCompliance30 = medications.map((med) => {
      const events = eventsByMed.get(med.id) ?? [];
      return calculateCompliance(events, med.schedules, 30, med.createdAt).rate;
    });
    medicationCompliance30Previous = medications.map((med) => {
      const events = (eventsByMed.get(med.id) ?? []).filter(
        (e) => e.scheduledFor <= prevUntil,
      );
      // Compute compliance against the prior-week-aligned window by
      // remapping the helper's "now": shift each event's scheduledFor
      // and takenAt forward by 7 days so the helper's internal `now`
      // anchor still captures the same logical 30 days.
      const shifted = events.map((e) => ({
        scheduledFor: new Date(e.scheduledFor.getTime() + 7 * DAY_MS),
        takenAt: e.takenAt ? new Date(e.takenAt.getTime() + 7 * DAY_MS) : null,
        skipped: e.skipped,
      }));
      return calculateCompliance(shifted, med.schedules, 30, med.createdAt)
        .rate;
    });
  }

  const fallbackTarget = defaultWeightTargetFromHeight(input.heightCm);

  const weightSeriesLast30d = weightRows
    .filter((r) => r.measuredAt >= since30d)
    .map((r) => ({ date: r.measuredAt.toISOString(), kg: r.value }));
  const weightSeriesPrev30d = weightRows
    .filter((r) => r.measuredAt >= prevSince30d && r.measuredAt <= prevUntil)
    .map((r) => ({ date: r.measuredAt.toISOString(), kg: r.value }));

  const moodSeriesLast30d = moodRows
    .filter((r) => r.moodLoggedAt >= since30d)
    .map((r) => ({
      date: r.moodLoggedAt.toISOString(),
      score: r.score,
    }));
  const moodSeriesPrev30d = moodRows
    .filter(
      (r) => r.moodLoggedAt >= prevSince30d && r.moodLoggedAt <= prevUntil,
    )
    .map((r) => ({
      date: r.moodLoggedAt.toISOString(),
      score: r.score,
    }));

  // Skip any input shape where literally nothing is computable — the
  // hero panel hides instead of painting a misleading "0".
  if (
    input.bpInTargetPct === null &&
    weightSeriesLast30d.length === 0 &&
    moodSeriesLast30d.length === 0 &&
    medicationCompliance30.length === 0
  ) {
    // Tag-only annotation so admin observability can see the empty path.
    annotate({
      meta: {
        healthScore: { score: null, reason: "no_components_available" },
      },
    });
    return null;
  }

  // v1.4.25 W8e — build per-component source attribution from the rows
  // we already hold in memory. `mapMeasurementSourceToLabel` collapses
  // the persisted `MeasurementSource` enum onto the camelCase token list
  // the analytics helper consumes; `IMPORT` rides under `manual`
  // because the v1.4.20 CSV importer ingests user-supplied data — it's
  // not a wearable stream.
  const windowEndAt = now.toISOString();

  const weightSourcesIn30d = uniqueComponentSources(
    weightRows
      .filter((r) => r.measuredAt >= since30d)
      .map((r) => r.source),
  );
  const latestWeightInWindow = weightRows
    .filter((r) => r.measuredAt >= since30d)
    .at(-1);

  const bpSourceTokens = uniqueComponentSources(
    bpSysRowsForSource.map((r) => r.source),
  );
  const latestBpInWindow = bpSysRowsForSource.at(-1);

  // Mood doesn't yet have a non-manual ingest (v1.5 will introduce
  // Apple Health mood) so the source list is always `["manual"]` when
  // there are entries in window. Keep the lookup explicit so the
  // v1.5 ingest path slot just drops in.
  const moodSourceTokens = moodSeriesLast30d.length > 0
    ? (["manual"] as const)
    : [];
  const latestMoodInWindow = moodRows
    .filter((r) => r.moodLoggedAt >= since30d)
    .at(-1);

  // Medication compliance always derives from logged intake events —
  // user-driven manual logging today.
  const complianceSourceTokens = medicationCompliance30.length > 0
    ? (["manual"] as const)
    : [];

  const current: HealthScoreInput = {
    bpInTargetRate: input.bpInTargetPct,
    weightSeriesLast30d,
    weightTargetKg: fallbackTarget,
    moodEntriesLast30d: moodSeriesLast30d,
    medicationCompliance30,
    attribution: {
      bpSources: bpSourceTokens,
      asOfBp: latestBpInWindow?.measuredAt.toISOString() ?? null,
      weightSources: weightSourcesIn30d,
      asOfWeight: latestWeightInWindow?.measuredAt.toISOString() ?? null,
      moodSources: moodSourceTokens,
      asOfMood: latestMoodInWindow?.moodLoggedAt.toISOString() ?? null,
      complianceSources: complianceSourceTokens,
      asOfCompliance: complianceSourceTokens.length > 0 ? windowEndAt : null,
      windowEndAt,
    },
  };
  // The all-time `bpInTargetPct` is a slow-moving aggregate and would
  // need a full historical re-pair to "rewind" by a week. We pass the
  // same value to the previous snapshot so the delta primarily
  // reflects week-over-week changes in the weight / mood / compliance
  // pillars — the components that actually move on a weekly cadence.
  const previous: HealthScoreInput = {
    bpInTargetRate: input.bpInTargetPct,
    weightSeriesLast30d: weightSeriesPrev30d,
    weightTargetKg: fallbackTarget,
    moodEntriesLast30d: moodSeriesPrev30d,
    medicationCompliance30: medicationCompliance30Previous,
  };

  return computeHealthScore(current, previous);
}
