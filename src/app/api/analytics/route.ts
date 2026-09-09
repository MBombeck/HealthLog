import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { analyticsQuerySchema } from "@/lib/validations/analytics";
import { NO_STORE_BUT_BFCACHE } from "@/lib/http/cache-headers";
import { cachedSwr, caches, type ServerCache } from "@/lib/cache/server-cache";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import { computeSummariesSlice } from "@/lib/analytics/summaries-slice";
import { resolveEffectiveBpTargets } from "@/lib/analytics/effective-range";
import { bpTargetsEqual, getBpTargets } from "@/lib/analytics/bp-targets";
import { DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import {
  buildSleepStageComposition,
  type SleepStageComposition,
} from "@/lib/analytics/sleep-stage-composition";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { ensureUserRollupsFresh } from "@/lib/rollups/measurement-rollups";
import { probeRollupCoverage } from "@/lib/rollups/measurement-coverage";
import {
  computeBpInTargetFastPath,
  type BpInTargetEnvelope,
} from "@/lib/analytics/bp-in-target-fast-path";
import { computeAndRecordUserHealthScore } from "@/lib/analytics/score/record";
import { isModuleEnabled, resolveModuleMap } from "@/lib/modules/gate";
import { gateSummariesByModules } from "@/lib/dashboard/widget-modules";
import { resolveRestMode } from "@/lib/illness/rest-mode";
import { deriveBpWindow90 } from "@/lib/analytics/window-confidence";
import { computeCorrelationHypothesesFastPath } from "@/lib/analytics/correlations-fast-path";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { type Locale } from "@/lib/i18n/config";
import {
  computeGlucoseClinicalMetrics,
  GLUCOSE_PANEL_WINDOW_DAYS,
  type GlucoseClinicalMetrics,
} from "@/lib/analytics/glucose-metrics";
import { groupByGlucoseContext } from "@/lib/glucose";
import {
  decisionForEvidence,
  PATTERN_FAMILIES,
  syncAcceptedPatterns,
} from "@/lib/insights/correlation-patterns";

export const dynamic = "force-dynamic";

/**
 * v1.4.33 C1 — pull `?slice=…` from either a NextRequest (the
 * route's production wrapper) or a plain `Request` (the integration
 * tests instantiate `new Request("http://localhost/api/analytics")`
 * and cast through). Falls back to the raw `URL(request.url)` parse
 * so the slim slice branch is reachable from both call shapes.
 *
 * Returns the object the query schema parses: an absent parameter is an
 * absent KEY, not an empty string, so `slice` stays optional rather than
 * failing the enum on every unparameterised call.
 */
function readQueryParams(request: Request | undefined): Record<string, string> {
  if (!request) return {};
  try {
    return Object.fromEntries(new URL(request.url).searchParams);
  } catch {
    return {};
  }
}

export const GET = apiHandler(async (request?: Request) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "analytics.get" } });

  // A `slice` outside the closed set is refused rather than served the
  // default body. Falling through was the expensive failure: `?slice=summary`
  // ran the full 30-query chain and answered 200, so a client could sit on a
  // typo indefinitely while paying for the heaviest read on the surface.
  const parsedQuery = analyticsQuerySchema.safeParse(readQueryParams(request));
  if (!parsedQuery.success) {
    annotate({
      action: { name: "analytics.get" },
      meta: { outcome: "invalid_query" },
    });
    return returnAllZodIssues(parsedQuery.error, 422, {
      errorCode: "analytics.invalid_query",
    });
  }

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
  if (parsedQuery.data.slice === "summaries") {
    // v1.4.34 IW-G — read-through the analytics cache keyed on
    // (userId, slice). The slim slice is the dashboard tile strip's hot
    // path; multiple dashboard mounts inside a 60-second TTL all hit a
    // warm cache.
    // v1.16.7 — SWR read: a sync-write marks the cell stale, and the
    // tile strip's next mount should repaint from the prior summaries
    // instantly while one background recompute refreshes them, instead
    // of paying the 2-SQL-pass rebuild inline.
    const slim = await cachedSwr(
      caches.analytics as ServerCache<
        Awaited<ReturnType<typeof computeSummariesSlice>>
      >,
      `${user.id}|summaries`,
      () => computeSummariesSlice(user.id),
      annotate,
    );
    // Drop the types whose module the user turned off, from the SAME map
    // the snapshot builder gates on (`SUMMARY_TYPE_MODULE`, via
    // `gateSummariesByModules`). With `NEXT_PUBLIC_DASHBOARD_SNAPSHOT=false`
    // this slice — not the snapshot — feeds the dashboard tile strip, and
    // it used to hand back every type regardless: recovery off plus an
    // RMSSD-only account still painted the HRV tile, because nothing on
    // this path had ever filtered.
    //
    // Gated AFTER the cache read on purpose. The cached cell stays
    // module-independent, so toggling a module takes effect on the next
    // request instead of waiting out the TTL, and two users' module states
    // can never share a cached answer.
    const slimModules = await resolveModuleMap(user.id);
    const slimGated = gateSummariesByModules(
      slim.summaries,
      slim.lastSeenByType,
      slimModules,
    );
    // v1.4.34 IW-B — bfcache-friendly directive on the slim slice too
    // so a back-forward navigation that landed on the dashboard tile
    // strip can restore from memory instead of paying a full reload.
    const slimRes = apiSuccess({
      ...slim,
      summaries: slimGated.summaries,
      lastSeenByType: slimGated.lastSeenByType,
    });
    slimRes.headers.set("Cache-Control", NO_STORE_BUT_BFCACHE);
    return slimRes;
  }

  // v1.4.34 IW-G — wrap the heavy default-slice body in the analytics
  // cache keyed on (userId, "default"). The dashboard, the checklist
  // mount, and the Coach drawer all hit this endpoint within seconds
  // of each other; the 60s TTL converts the 7.99s combined dashboard
  // wait to a Map lookup on every subsequent caller.
  // v1.16.7 — SWR read, same rationale as the slim slice above: the
  // thick body is the 30-query chain feeding the dashboard + insights
  // hero score; after a measurement sync the next mount serves the
  // prior body instantly while one background recompute refreshes it.
  // v1.30.10 — the `correlations` block carries user-facing narration that is
  // localised per reader, so the cache key MUST include the locale; otherwise a
  // language switch would serve another locale's cached interpretation for up to
  // the TTL. Every other block is locale-independent, so per-locale entries only
  // cost a little duplication (most users have one locale).
  const locale = await resolveServerLocale({ userLocale: user.locale ?? null });
  const cachedBody = await cachedSwr(
    caches.analytics as ServerCache<
      Awaited<ReturnType<typeof buildAnalyticsResponse>>
    >,
    `${user.id}|default|${locale}`,
    () => buildAnalyticsResponse(user, locale),
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
async function buildAnalyticsResponse(user: AuthedUser, locale: Locale) {
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
  //   - `avg7 / avg30 / slope7 / slope30` from the narrow query
  //   - `avg30LastMonth` from the same narrow query (added in this
  //     release; previously only the live walk produced it)
  //   - `avg30LastYear` populated for any type whose WMY tier carries
  //     the year-ago window
  //   - `lastSeenByType` from the `DISTINCT ON (type)` latest read
  //
  // `anomalyCount` and `slope90` left this wire in v1.37.19: the slim
  // path could never compute the former (it always reported 0) and no
  // client component read the latter — the insights pipeline computes
  // both from its own `summarize()` / comprehensive-aggregator reads.
  // The one field the slim path leaves at a default value is
  // `avg30LastYear` on types with no WMY coverage, which matches the
  // pre-fix behaviour for tenants whose year-ago window happened to
  // fall outside the 425-day floor.
  const slim = await computeSummariesSlice(user.id);
  // Same module gate as the slim slice and the snapshot builder — the
  // default slice feeds the dashboard too (it is the thick half of the
  // legacy two-cell path), so it cannot be the one feed that leaks a
  // disabled module's types.
  const thickModules = await resolveModuleMap(user.id);
  const thickGated = gateSummariesByModules(
    slim.summaries,
    slim.lastSeenByType,
    thickModules,
  );
  const results = thickGated.summaries;
  const lastSeenByType = thickGated.lastSeenByType;

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
  // v1.17 W1b — 90-day pair count + effective label span for the tile's
  // thin-data gate. Surfaced so the BD-Zielbereich tile renders "collecting
  // data" until the window holds enough readings, with a dynamic span label.
  let bpInTargetCount90: number | null = null;
  let bpInTargetSpanDays90: number | null = null;
  // v1.17 W1b — hold the current + prior-week BP envelopes so the shared
  // Health-Score input builder grades the pillar off the identical shape the
  // dashboard snapshot uses (one builder, no per-surface assembly drift).
  // The graded score + prior-week BP figures the score consumes are read off
  // these envelopes inside `buildHealthScoreBpInputs`.
  let bpEnvelope: BpInTargetEnvelope | null = null;
  let bpEnvelopePriorWeek: BpInTargetEnvelope | null = null;
  let bpEnvelopePriorTwoWeeks: BpInTargetEnvelope | null = null;
  const bpTargets = resolveEffectiveBpTargets(
    {
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      heightCm: user.heightCm ?? null,
    },
    user.thresholdsJson,
  );
  const clinicalBpTargets = getBpTargets(user.dateOfBirth);
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
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const [windows, windowsPriorWeek, windowsPriorTwoWeeks] = await Promise.all(
      [
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
        computeBpInTargetFastPath({
          userId: user.id,
          targets: bpTargets,
          now: fourteenDaysAgo,
          coverage,
          userTz,
        }),
      ],
    );
    // The pillar is graded against the CLINICAL band even when the user
    // keeps a personal target (that band is the number's identity; the
    // personal one is displayed beside it and scores nothing). So when the
    // two differ we re-run the whole helper against the clinical targets
    // and the score comes from that second run.
    //
    // v1.34.5 — the "why this number" basis rides the same envelope, so it
    // is the same run, the same representative pair and the same ceilings
    // by construction. Assign envelopes WHOLE here; picking `graded.score`
    // off one run and a basis off the other would let the popover explain
    // a number nobody is looking at, and it would look correct in review.
    if (bpTargetsEqual(bpTargets, clinicalBpTargets)) {
      bpEnvelope = windows;
      bpEnvelopePriorWeek = windowsPriorWeek;
      bpEnvelopePriorTwoWeeks = windowsPriorTwoWeeks;
    } else if (clinicalBpTargets) {
      [bpEnvelope, bpEnvelopePriorWeek, bpEnvelopePriorTwoWeeks] =
        await Promise.all([
          computeBpInTargetFastPath({
            userId: user.id,
            targets: clinicalBpTargets,
            now,
            coverage,
            userTz,
          }),
          computeBpInTargetFastPath({
            userId: user.id,
            targets: clinicalBpTargets,
            now: sevenDaysAgo,
            coverage,
            userTz,
          }),
          computeBpInTargetFastPath({
            userId: user.id,
            targets: clinicalBpTargets,
            now: fourteenDaysAgo,
            coverage,
            userTz,
          }),
        ]);
    }
    // v1.17 W1d — the BD-Zielbereich headline standardises on the
    // trailing-90-day window (labelled "· 90 T" in the tile). All-time
    // remains carried below for the BP detail page's long view only.
    bpInTargetPct = windows.last90Days?.pct ?? null;
    bpInTargetPct7d = windows.last7Days?.pct ?? null;
    bpInTargetPct30d = windows.last30Days?.pct ?? null;
    bpInTargetPctAllTime = windows.allTime?.pct ?? null;
    bpInTargetPctPriorMonth = windows.priorMonth?.pct ?? null;
    bpInTargetPctPriorYear = windows.priorYear?.pct ?? null;
    // v1.17 W1b — count + effective span for the BD-Zielbereich tile's
    // confidence gate (thin-data → "collecting data"; dynamic span label).
    // Shared helper keeps this identical to the dashboard snapshot.
    const bpWindow = deriveBpWindow90(
      windows.last90Days,
      windows.last90EarliestAt,
      now,
    );
    bpInTargetCount90 = bpWindow.count;
    bpInTargetSpanDays90 = bpWindow.spanDays;
  }

  // Per-context glucose summaries (canonical mg/dL).
  //
  // v1.4.29 H2 — bound to the trailing 30 days. The dashboard tile
  // path only reads the trailing window; pre-bound this query
  // walked every persisted BG row a multi-year user has written.
  const glucoseSince = new Date(
    Date.now() - GLUCOSE_PANEL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
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
  // #943 — grouped through the shared bucket resolver, so readings with no
  // meal-time tag land in `UNSPECIFIED` instead of being dropped on the floor.
  const glucoseByContext: Record<string, ReturnType<typeof summarize>> = {};
  for (const [bucket, ctxRows] of groupByGlucoseContext(
    glucoseRows,
    (r) => r.glucoseContext,
  )) {
    glucoseByContext[bucket] = summarize(
      ctxRows.map((r): DataPoint => ({ date: r.measuredAt, value: r.value })),
    );
  }

  // v1.17.0 — server-authoritative glucose clinical panel. The TIR / GMI /
  // eA1C / CV% headline and the advanced J-index + LBGI/HBGI tier are computed
  // ONCE here over the declared 30-day window (matching `glucoseSince`) so the
  // insights panel, the coach snapshot, and the doctor report all render the
  // same numbers instead of each re-deriving. The learning gate keeps a thin
  // spot-data window from being asserted as a clinical AGP. Always present in
  // the payload (even with zero readings) so the client renders the calm
  // "still learning" state from a populated object rather than a missing key.
  const glucoseClinical: GlucoseClinicalMetrics = computeGlucoseClinicalMetrics(
    glucoseRows.map((r) => ({ measuredAt: r.measuredAt, mgdl: r.value })),
    { windowDays: GLUCOSE_PANEL_WINDOW_DAYS, now: new Date() },
  );

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
    locale,
  });
  const fixedDefinitions = [
    {
      key: "bpCompliance" as const,
      factorKey: "HYPOTHESIS:MEDICATION_COMPLIANCE",
      outcomeKey: "BLOOD_PRESSURE_SYS",
    },
    {
      key: "moodPulse" as const,
      factorKey: "HYPOTHESIS:MOOD",
      outcomeKey: "RESTING_PULSE",
    },
    {
      key: "weightWeekday" as const,
      factorKey: "HYPOTHESIS:WEEKDAY",
      outcomeKey: "WEIGHT",
    },
  ];
  const acceptedFixed = fixedDefinitions.flatMap((definition) => {
    const result = correlations[definition.key];
    return result.status === "ok"
      ? [
          {
            factorKey: definition.factorKey,
            outcomeKey: definition.outcomeKey,
            lagDays: 0,
            sampleSize: result.n,
            effectSize: result.statistic,
            pValue: result.pValue,
            qValue: null,
          },
        ]
      : [];
  });
  const fixedDecisions = await syncAcceptedPatterns({
    userId: user.id,
    family: PATTERN_FAMILIES.fixed,
    accepted: acceptedFixed,
  });
  const correlationsWithPatterns = { ...correlations };
  for (const definition of fixedDefinitions) {
    const result = correlations[definition.key];
    if (result.status !== "ok") continue;
    const decision = decisionForEvidence(fixedDecisions, {
      factorKey: definition.factorKey,
      outcomeKey: definition.outcomeKey,
      lagDays: 0,
    });
    correlationsWithPatterns[definition.key] = decision
      ? { ...result, ...decision }
      : result;
  }

  // v1.34 — the versioned cardiometabolic reference report. The shared reader
  // admits only evidence-backed pillars with their own windows and coverage
  // floors, then applies the three-domain breadth rule. Its BP envelopes come
  // from the same rollup/live fast path the dashboard uses; every other domain
  // resolves through the canonical reader and fails independently.
  const [
    glucoseEnabled,
    labsEnabled,
    sleepEnabled,
    mentalHealthEnabled,
    scoreSourcePriority,
  ] = await Promise.all([
    isModuleEnabled(user.id, "glucose"),
    isModuleEnabled(user.id, "labs"),
    isModuleEnabled(user.id, "sleep"),
    isModuleEnabled(user.id, "mentalHealth"),
    loadUserSourcePriority(user.id),
  ]);
  const glucoseByContextOut = glucoseEnabled ? glucoseByContext : null;
  const glucoseClinicalOut = glucoseEnabled ? glucoseClinical : null;
  const scoredAt = new Date();
  const healthScore = await computeAndRecordUserHealthScore({
    userId: user.id,
    now: scoredAt,
    profile: {
      dateOfBirth: user.dateOfBirth,
      heightCm: user.heightCm ?? null,
      timezone: userTz,
      sourcePriorityJson: scoreSourcePriority,
      thresholdsJson: user.thresholdsJson ?? null,
    },
    modules: {
      glucose: glucoseEnabled,
      labs: labsEnabled,
      sleep: sleepEnabled,
      mentalHealth: mentalHealthEnabled,
    },
    healthScoreConfigJson: user.healthScoreConfigJson,
    bpTargets: clinicalBpTargets,
    bpEnvelope,
    bpEnvelopePriorWeek,
    bpEnvelopePriorTwoWeeks,
  });

  // v1.18.1 P4 — Rest Mode annotation. When an illness/condition episode is
  // active we frame the score (not penalise it): the number above is left
  // exactly as computed and we attach a value-free "you were unwell" context.
  // Resolved server-side so iOS mirrors the same fact, never recomputing it.
  // Resolved as-of the scored window (`scoredAt`), not a fresh now.
  if (healthScore) {
    const restMode = await resolveRestMode(user.id, scoredAt);
    healthScore.restMode = restMode.active
      ? {
          active: true,
          since: restMode.since,
          episodeCount: restMode.episodeCount,
        }
      : null;
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
    bpInTargetCount90,
    bpInTargetSpanDays90,
    glucoseByContext: glucoseByContextOut,
    glucoseClinical: glucoseClinicalOut,
    correlations: correlationsWithPatterns,
    healthScore,
    sleepStages,
    // v1.28.x — the latest night's source-discrepancy annotation, computed
    // inside the slim slice's per-night post-pass. Additive: the dashboard
    // sleep tile marks the headline with a discreet "sources disagree"
    // hint; clients that don't read the field stay unchanged.
    sleepSourceDiscrepancy: slim.sleepSourceDiscrepancy,
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
 *
 * The per-night stages are the MAIN NIGHT's stages. A nap ends on the
 * same wake day as that morning's night, and the per-wake-day totals
 * folded it into the night's buckets — an afternoon nap added CORE to
 * the night and the column read longer and shallower than the night
 * was. The nap's minutes now ride alongside on `napMinutes` /
 * `napCount`, both absent on a day without one.
 */
async function computeSleepStageBreakdown(
  userId: string,
  userTz: string,
): Promise<SleepStageComposition | null> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WINDOW_DAYS = 30;
  const since = new Date(Date.now() - WINDOW_DAYS * DAY_MS);
  // v1.11.5 — read the FULL per-stage row set (not `sleepStage: { not: null }`)
  // and route it through the canonical session reconstruction so the
  // stacked-bar agrees with the dashboard tile + chart series. The old path
  // keyed each stage row by its OWN calendar day (splitting a midnight-
  // spanning night across two buckets) and never collapsed multi-source
  // (double-counting a WHOOP + Apple Health night). Routing through the
  // helper fixes both: it session-clusters, keys by the wake day, and picks
  // one canonical source per night. The bare-vs-granular de-dup is applied
  // per-session to the per-stage breakdown too. The `source` is selected so
  // the helper's source-collapse can run.
  const rows = await prisma.measurement.findMany({
    where: {
      userId,
      type: "SLEEP_DURATION",
      measuredAt: { gte: since },
      deletedAt: null,
    },
    select: {
      value: true,
      measuredAt: true,
      sleepStage: true,
      source: true,
      deviceType: true,
    },
  });

  if (rows.length === 0) return null;

  const priorityJson = await loadUserSourcePriority(userId);
  return buildSleepStageComposition(rows, userTz, priorityJson, WINDOW_DAYS);
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
