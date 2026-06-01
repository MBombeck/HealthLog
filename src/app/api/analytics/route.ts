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
import { ensureUserRollupsFresh } from "@/lib/rollups/measurement-rollups";
import { probeRollupCoverage } from "@/lib/rollups/measurement-coverage";
import { computeBpInTargetFastPath } from "@/lib/analytics/bp-in-target-fast-path";
import { computeUserHealthScoreFastPath } from "@/lib/analytics/health-score-fast-path";
import { computeCorrelationHypothesesFastPath } from "@/lib/analytics/correlations-fast-path";

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
  const cachedBody = await cached(
    caches.analytics as ServerCache<Awaited<ReturnType<typeof buildAnalyticsResponse>>>,
    `${user.id}|default`,
    () => buildAnalyticsResponse(user),
    annotate,
  );

  // v1.4.38 — `lastSeenByType` lives inside the cached envelope as
  // `{ lastSeenAt }` only; derive the `daysAgo` caption per call so
  // the staleness label updates correctly across day boundaries.
  // The cache TTL is 60s, but the day boundary it can straddle would
  // otherwise leave the cached `daysAgo` off by one until the next
  // refresh. Re-deriving on read is a single Date subtraction per
  // type and stays on the hot path's Map-lookup side of the cache.
  const body = enrichLastSeenDaysAgo(cachedBody);

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
 * v1.4.38 — derive `daysAgo` from the cached `lastSeenAt` ISO string
 * per request. The cached envelope deliberately omits `daysAgo` so
 * the dashboard tile staleness caption stays correct across day
 * boundaries even when the body has been sitting in the 60s LRU.
 *
 * Returns a shallow-copied envelope with the enriched
 * `lastSeenByType` map; everything else is passed through unchanged.
 */
function enrichLastSeenDaysAgo<
  T extends {
    lastSeenByType: Record<string, { lastSeenAt: string } | null>;
  },
>(
  body: T,
): Omit<T, "lastSeenByType"> & {
  lastSeenByType: Record<
    string,
    { lastSeenAt: string; daysAgo: number } | null
  >;
} {
  const nowMs = Date.now();
  const enriched: Record<
    string,
    { lastSeenAt: string; daysAgo: number } | null
  > = {};
  for (const [type, slot] of Object.entries(body.lastSeenByType)) {
    if (slot === null) {
      enriched[type] = null;
      continue;
    }
    const lastMs = new Date(slot.lastSeenAt).getTime();
    const daysAgo = Math.floor((nowMs - lastMs) / (24 * 60 * 60 * 1000));
    enriched[type] = { lastSeenAt: slot.lastSeenAt, daysAgo };
  }
  return { ...body, lastSeenByType: enriched };
}

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

  // v1.4.25 W7b — every day-bucket call inside this route honours the
  // user's display timezone via `userDayKey(date, userTz)` (the legacy
  // `berlinDayKey()` helper was retired in v1.4.40).
  const userTz = user.timezone ?? DEFAULT_TIMEZONE;

  // v1.4.49.1 — replace the 15-way per-type `fetchMeasurementSeriesChunked`
  // fan-out with the slim rollup-tier reader. The previous live walk
  // against `measurements` (425-day window, ≥ 50 Prisma round-trips on a
  // 15-type tenant) saturated the `p-limit(4)` slot pool for ~8 s on the
  // production 467 k-row account — and because Prisma's 20-slot pool was
  // simultaneously claimed by those slots, the concurrent
  // `?slice=summaries` request (only ~9 small queries) queued behind it
  // and observed the same ~8 s wall-clock.
  //
  // `computeSummariesSlice` reads `measurement_rollups` DAY buckets
  // (sub-second) plus one 90-day narrow `$queryRaw` for the windowed
  // avg / slope / r² columns, and falls back to a split-aggregate live
  // path for users with incomplete rollup coverage. Response shape is
  // identical to the previous fan-out output for every field the
  // dashboard actually consumes:
  //   - `count / latest / min / max / mean` from DAY buckets
  //   - `avg7 / avg30 / slope7 / slope30 / slope90` from the narrow query
  //   - `avg30LastMonth` from the same narrow query (added in this
  //     release; previously only the live walk produced it)
  //   - `avg30LastYear` populated for any type whose WMY tier carries
  //     the year-ago window
  //   - `lastSeenByType` from the `DISTINCT ON (type)` latest read
  //
  // The two fields the slim path leaves at default values are
  // `anomalyCount` (always 0) — the insights pipeline consumes it from
  // its own `comprehensive-aggregator` narrow query, never from this
  // route — and `avg30LastYear` on types with no WMY coverage, which
  // matches the pre-fix behaviour for tenants whose year-ago window
  // happened to fall outside the 425-day floor.
  const slim = await computeSummariesSlice(user.id);
  const results = slim.summaries;
  const lastSeenByType = slim.lastSeenByType;

  // `computeSummariesSlice` annotates `action: "analytics.get.slim"`
  // for telemetry on the slim route. Restore the default-slice action
  // name so the wide-event reflects the route the client actually
  // called (otherwise every default-slice request would appear in the
  // logs under the slim action).
  annotate({ action: { name: "analytics.get" } });

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
  /**
   * v1.4.38 — prior-week BP-in-target pct so the Health-Score
   * week-over-week delta reflects BP movement. Pre-v1.4.38 the
   * Health-Score helper pinned both windows to the same value, so the
   * BP pillar always zeroed out of the delta. Computed by running a
   * second `computeBpInTargetFastPath` against `now - 7d` and reading
   * the resulting `last30Days.pct`.
   */
  let bpInTargetPctPriorWeek: number | null = null;
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
    //
    // v1.4.38 — two parallel runs: one anchored at `now` for the
    // standard windows, one anchored at `now - 7d` so the Health-Score
    // helper has a real prior-week BP pct to feed into its previous-
    // window snapshot. The two probes share the coverage map and the
    // same rollup / live branch decision; the extra call is one extra
    // pair of `readRollupBuckets` reads on the rollup path and is a
    // no-op when the user has no BP rows at all.
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const [windows, windowsPriorWeek] = await Promise.all([
      computeBpInTargetFastPath({
        userId: user.id,
        targets: bpTargets,
        now,
        coverage,
        // v1.4.38 W-A — cross-tz runtime guard. The helper falls back
        // to the live SQL path when the user is more than 3 hours
        // from UTC, where the rollup table's UTC-midnight day-key
        // would slip a calendar day relative to the live aggregator's
        // window cuts.
        userTz,
      }),
      computeBpInTargetFastPath({
        userId: user.id,
        targets: bpTargets,
        now: sevenDaysAgo,
        coverage,
        userTz,
      }),
    ]);
    bpInTargetPct = windows.last30Days?.pct ?? null;
    bpInTargetPct7d = windows.last7Days?.pct ?? null;
    bpInTargetPct30d = windows.last30Days?.pct ?? null;
    bpInTargetPctAllTime = windows.allTime?.pct ?? null;
    bpInTargetPctPriorMonth = windows.priorMonth?.pct ?? null;
    bpInTargetPctPriorYear = windows.priorYear?.pct ?? null;
    bpInTargetPctPriorWeek = windowsPriorWeek.last30Days?.pct ?? null;
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
      deletedAt: null,
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
    // v1.4.38 — feed the prior-week BP pct into the Health-Score
    // helper's previous-window snapshot so the week-over-week delta
    // reflects BP movement instead of zeroing out of the BP pillar.
    // Computed alongside the current windows via a second
    // `computeBpInTargetFastPath` run anchored at `now - 7d`.
    bpInTargetPctPriorWeek,
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
      deletedAt: null,
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

// v1.4.49.1 — the chunked `fetchMeasurementSeriesChunked` helper and
// its supporting types / constants relocated entirely. The default
// slice now delegates the per-type summaries work to
// `computeSummariesSlice` (rollup-tier, sub-second on covered tenants)
// so the legacy 15-way live walk against `measurements` no longer has
// a caller. The slim slice was already independent of it. Deleting the
// dead code here removes the pool-starvation surface that gated the
// concurrent slim slice and prevents future regressions from
// accidentally reintroducing the fan-out.

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
