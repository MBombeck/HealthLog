import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { NO_STORE_BUT_BFCACHE } from "@/lib/http/cache-headers";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import { computeSummariesSlice } from "@/lib/analytics/summaries-slice";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { userDayKey, DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import type {
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import { pickCanonicalSourceRows } from "@/lib/analytics/source-priority";
import { ensureUserRollupsFresh } from "@/lib/measurements/rollups";
import { probeRollupCoverage } from "@/lib/measurements/rollup-coverage";
import { computeBpInTargetFastPath } from "@/lib/analytics/bp-in-target-fast-path";
import { computeUserHealthScoreFastPath } from "@/lib/analytics/health-score-fast-path";
import { computeCorrelationHypothesesFastPath } from "@/lib/analytics/correlations-fast-path";
import {
  cumulativeMetricKey,
  isCumulativeDaySumType,
  pickCumulativeDaySum,
} from "@/lib/measurements/cumulative-day-sum";

export const dynamic = "force-dynamic";

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
  // v1.4.37.1 hotfix — fire-and-forget the rollup-fresh check.
  // Awaiting it on the read path can stall the Node event loop for
  // 30–60 s on a power-user account whose iOS step samples keep the
  // 90-day DAY window slightly stale, which starves /api/health,
  // /api/version, and concurrent iOS calls. The downstream coverage
  // probe falls back to live SQL when a type is uncovered, so
  // correctness is preserved; the worst the user sees is data from
  // up to ~60 s ago on the very first request after a fresh
  // measurement lands, and the next request returns the up-to-date
  // value once the background refresh completes. `ensureUserRollupsFresh`
  // wraps its own try/catch, so the void call cannot reject.
  void ensureUserRollupsFresh(user.id);

  // v1.4.37 W2 — single per-type coverage probe shared by the
  // bp_in_target / healthScore / correlations branches below. The
  // probe is one indexed query against `measurement_rollups`; the
  // three downstream branches each reuse the resulting `coverage`
  // map to decide between the rollup-fast-path and the live
  // fallback. Probing once instead of per-branch keeps the fan-out
  // cost flat across the three branches.
  const coverage = await probeRollupCoverage(user.id);

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
    // v1.4.37 W2 — probe-gated dispatcher replaces the inline chunked
    // read. When BOTH BP types have DAY-bucket coverage the helper
    // pairs the per-day MEAN SYS + MEAN DIA from `measurement_rollups`
    // and counts in-target days against the five reporting windows,
    // skipping the heavy 365-day chunked walk against `measurements`.
    // Falls back to the legacy `computeBpInTargetWindows` over a
    // chunked read when coverage is partial so a brand-new account
    // (no buckets yet) still sees per-event numbers. The helper emits
    // a `path: "rollup" | "live"` annotate so prod logs prove which
    // branch fired. See `bp-in-target-fast-path.ts` for the
    // documented per-day-mean approximation.
    const windows = await computeBpInTargetFastPath({
      userId: user.id,
      targets: bpTargets,
      now,
      coverage,
    });
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
  // v1.4.37 W2 — probe-gated helper. The 28-day scan window (down
  // from 30 to keep the cold critical path tight while still
  // satisfying the n >= 20 surface gate) reads SYS / PULSE / WEIGHT
  // per-day means from `measurement_rollups` when the user has full
  // coverage; mood and medication-intake reads always stay live (no
  // rollup equivalent). The helper emits `meta.correlations.path` +
  // `meta.correlations.window_days` so prod logs prove the branch
  // selection and the truthful window.
  const correlations = await computeCorrelationHypothesesFastPath({
    userId: user.id,
    userTz,
    now: new Date(),
    coverage,
  });

  // v1.4.20 phase B5 — Personal Health Score. Server-deterministic
  // composite of BP-in-target % + weight-trend alignment + mood
  // stability + medication compliance. The "vs last week" delta
  // re-runs the same compute against a 7-day-shifted snapshot.
  //
  // v1.4.37 W2 — probe-gated helper. The weight pillar derives from
  // DAY-bucket means on `measurement_rollups` when the user has full
  // coverage; the source-attribution accordion still pulls a narrow
  // 2-column projection from `measurements` for the ingest-path
  // pills. Falls back to the legacy 37-day raw read on partial /
  // missing coverage. Path annotate sits on `meta.healthScore.path`.
  const healthScore = await computeUserHealthScoreFastPath({
    userId: user.id,
    bpInTargetPct,
    heightCm: user.heightCm ?? null,
    now: new Date(),
    coverage,
  });

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

// v1.4.37 W2 — `computeCorrelationHypotheses` body relocated to
// `src/lib/analytics/correlations-fast-path.ts` so the probe-gated
// rollup / live dispatcher can be unit-tested independently of the
// route. The new helper also tightens the scan window to 28 days and
// emits a sentinel on `meta.correlations.window_days` / `degraded`.

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

// v1.4.37 W2 — `WEEKDAY_FORMATTER_CACHE`, `getWeekdayFormatter`,
// `dateFromDayKey`, `ISO_WEEKDAY`, and `isoWeekdayInTz` relocated
// alongside the correlation runner in
// `src/lib/analytics/correlations-fast-path.ts`. They were only ever
// used by the weight-weekday + day-key helpers inside the old inline
// correlation builder.


// v1.4.37 W2 — `mapMeasurementSourceToLabel`, `uniqueComponentSources`,
// and the inline `computeUserHealthScore` body relocated to
// `src/lib/analytics/health-score-fast-path.ts` so the probe-gated
// rollup / live dispatcher can be unit-tested independently of the
// route. The route now delegates through `computeUserHealthScoreFastPath`.
