/**
 * The default `GET /api/analytics` body, built once per (user, locale) and
 * cached by the route: the module-gated summaries, BMI, the blood-pressure
 * in-target block, the glucose blocks, the correlations, the Health Score and
 * the sleep stages. The stages run in the order the route always ran them.
 */
import type { SessionUser } from "@/lib/auth/session-user";
import { runDetached } from "@/lib/logging/detached";
import { trackBackgroundTask } from "@/lib/logging/background-tasks";
import { annotate } from "@/lib/logging/context";
import type { Locale } from "@/lib/i18n/config";
import { DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import { readSummariesSlice } from "@/lib/analytics/summaries-slice";
import { ensureUserRollupsFresh } from "@/lib/rollups/measurement-rollups";
import { probeRollupCoverage } from "@/lib/rollups/measurement-coverage";
import { resolveModuleMap } from "@/lib/modules/gate";
import { gateSummariesByModules } from "@/lib/dashboard/widget-modules";

import { readBpInTargetBlock } from "./bp-in-target";
import { readCorrelationBlock } from "./correlations";
import { readGlucoseBlocks } from "./glucose";
import { readHealthScoreBlock } from "./health-score";
import { computeSleepStageBreakdown } from "./sleep-stages";

export type AnalyticsBody = Awaited<ReturnType<typeof buildAnalyticsResponse>>;

/**
 * The heavy default-slice body, outside the route handler so `cachedSwr()`
 * can wrap it. Returns the raw JSON payload; the route attaches the
 * `Cache-Control` header afterward.
 */
export async function buildAnalyticsResponse(
  user: SessionUser,
  locale: Locale,
) {
  // Fire-and-forget the rollup-fresh check.
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
  trackBackgroundTask(runDetached(() => ensureUserRollupsFresh(user.id)));

  // Single per-type coverage probe shared by the
  // bp_in_target / healthScore / correlations branches below. The
  // probe is one indexed query against `measurement_rollups`; the
  // three downstream branches each reuse the resulting `coverage`
  // map to decide between the rollup-fast-path and the live
  // fallback. Probing once instead of per-branch keeps the fan-out
  // cost flat across the three branches.
  const coverage = await probeRollupCoverage(user.id);

  // Every day-bucket call inside this route honours the
  // user's display timezone via `userDayKey(date, userTz)` (the legacy
  // `berlinDayKey()` helper was retired in v1.4.40).
  const userTz = user.timezone ?? DEFAULT_TIMEZONE;

  // Replace the 15-way per-type `fetchMeasurementSeriesChunked`
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
  //   - `lastSeenByType` from the per-type latest read
  //
  // `anomalyCount` and `slope90` left this wire in v1.37.19: the slim
  // path could never compute the former (it always reported 0) and no
  // client component read the latter — the insights pipeline computes
  // both from its own `summarize()` / comprehensive-aggregator reads.
  // The one field the slim path leaves at a default value is
  // `avg30LastYear` on types with no WMY coverage, which matches the
  // pre-fix behaviour for tenants whose year-ago window happened to
  // fall outside the 425-day floor.
  const slim = await readSummariesSlice(user.id);
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

  // Sleep-stage breakdown for the trailing 30 days. Only
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

  const bp = await readBpInTargetBlock(user, coverage, userTz);
  const { glucoseByContext, glucoseClinical } = await readGlucoseBlocks(
    user.id,
  );
  const correlationsWithPatterns = await readCorrelationBlock({
    userId: user.id,
    userTz,
    coverage,
    locale,
  });
  const { glucoseEnabled, healthScore } = await readHealthScoreBlock({
    user,
    userTz,
    clinicalBpTargets: bp.clinicalBpTargets,
    bpEnvelope: bp.bpEnvelope,
    bpEnvelopePriorWeek: bp.bpEnvelopePriorWeek,
    bpEnvelopePriorTwoWeeks: bp.bpEnvelopePriorTwoWeeks,
  });
  const glucoseByContextOut = glucoseEnabled ? glucoseByContext : null;
  const glucoseClinicalOut = glucoseEnabled ? glucoseClinical : null;

  return {
    summaries: results,
    bmi,
    bpInTargetPct: bp.bpInTargetPct,
    bpInTargetPct7d: bp.bpInTargetPct7d,
    bpInTargetPct30d: bp.bpInTargetPct30d,
    bpInTargetPctAllTime: bp.bpInTargetPctAllTime,
    bpInTargetPctPriorMonth: bp.bpInTargetPctPriorMonth,
    bpInTargetPctPriorYear: bp.bpInTargetPctPriorYear,
    bpInTargetCount90: bp.bpInTargetCount90,
    bpInTargetSpanDays90: bp.bpInTargetSpanDays90,
    glucoseByContext: glucoseByContextOut,
    glucoseClinical: glucoseClinicalOut,
    correlations: correlationsWithPatterns,
    healthScore,
    sleepStages,
    // The latest night's source-discrepancy annotation, computed
    // inside the slim slice's per-night post-pass. Additive: the dashboard
    // sleep tile marks the headline with a discreet "sources disagree"
    // hint; clients that don't read the field stay unchanged.
    sleepSourceDiscrepancy: slim.sleepSourceDiscrepancy,
    // Per-type freshness map drives the dashboard's
    // staleness caption on each `<TrendCard>`. Additive: clients that
    // don't read the field stay unchanged.
    lastSeenByType,
  };
}
