/**
 * GET /api/insights/correlations — FDR-controlled correlation discovery.
 *
 * v1.10.0 — promotes the former placeholder to the real discovery engine.
 * Scans a curated behaviour × outcome matrix (daylight / mood / glucose /
 * BP / steps × sleep / HRV / resting HR / weight), lag-joins each behaviour
 * day to the NEXT day's outcome, runs Pearson with the exact Student-t
 * p-value, and applies Benjamini-Hochberg FDR control across every tested
 * pair so only statistically-defensible patterns surface. Every surfaced
 * pair carries n, r, p, and the BH-adjusted q, framed descriptive — never
 * causal.
 *
 * Reads daily series bounded to a trailing window, day-keyed in the user's
 * display timezone (late-night readings mis-bucket under UTC). The channel set
 * comes from `src/lib/insights/discovery-matrix.ts`, the one assembler every
 * discovery surface shares; the pure compute lives in
 * `src/lib/insights/correlation-discovery.ts`. This route only asks for the
 * matrix, scans it, persists the pattern decisions and responds. No LLM, no
 * narrative, no cache table.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { cachedSwr, caches, type ServerCache } from "@/lib/cache/server-cache";
import { annotate } from "@/lib/logging/context";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { MODULE_KEYS, resolveModuleMap } from "@/lib/modules/gate";
import { isSurfaceVisible, type SurfaceModuleMap } from "@/lib/modules/surface";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { prisma } from "@/lib/db";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import {
  discoverCorrelations,
  discoverEmergingCorrelations,
  discoverLabOutcomeCorrelations,
  EARLY_WINDOW_DAYS,
} from "@/lib/insights/correlation-discovery";
import {
  decisionForEvidence,
  hadFindingsBeforeSeasonalAdjustment,
  PATTERN_FAMILIES,
  syncAcceptedPatterns,
} from "@/lib/insights/correlation-patterns";
import { assembleDiscoveryMatrix } from "@/lib/insights/discovery-matrix";
import { fetchLabDraws } from "@/lib/insights/correlation-channel-series";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

export const dynamic = "force-dynamic";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Trailing window for the discovery scan (days). */
const WINDOW_DAYS = 180;

/** Day key (YYYY-MM-DD) for an instant in the user's display timezone. */
function tzDayKey(at: Date, tz: string): string {
  const { year, month, day } = wallClockInTz(at, tz);
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

export const GET = apiHandler(async () => {
  // v1.37.0 — MANAGE-level read: computed over the whole record, with no
  // provider anywhere on the path.
  const { user } = await requireRecordAuth("manage", "record");

  // v1.15.20 — shared analytics-read budget (generous; caps runaway loops).
  const rl = await checkAnalyticsReadRateLimit(user.id);
  if (!rl.allowed) {
    return apiError("Too many analytics requests. Please retry later.", 429);
  }

  // No AI gate and no `insights` module gate: this is statistics, not model
  // output. The retired Correlations switch gated it and nothing model-written;
  // an operator's AI switches, and the person's AI analysis opt-out, never
  // take a computation down.

  // Reader's locale for the narrated `interpretation` — the correlation cards
  // render this string verbatim, so it MUST be localised (cookie / User.locale /
  // Accept-Language). Without it the never-causal sentence leaked English into a
  // non-English UI. It is part of the cache key for the same reason.
  const locale = await resolveServerLocale({ userLocale: user.locale ?? null });

  // The discovery scan is the most expensive uncached read the app had:
  // ~10 parallel window reads over 180 days + Pearson/FDR in-process, paid on
  // EVERY mount. Cache the built body in the analytics bucket (60 s fresh /
  // 1 h stale — the bucket defaults are exactly the contract this read wants).
  // Eviction truth comes free: every measurement / mood / medication /
  // illness / custom-metric write sweeps the `${userId}|` prefix in this
  // bucket, and a pattern dismiss goes through
  // `invalidateUserCorrelationPatterns`, which sweeps it too. The
  // `syncAcceptedPatterns` calls are DB writes and live INSIDE the builder,
  // so a cache hit performs no write on the read path.
  // Statistics serve only with their owning modules: a channel whose module
  // is off never enters the scan. The switched-off set is part of the cache
  // key, so toggling a module never serves a body computed under the other
  // setting.
  const modules = await resolveModuleMap(user.id);
  const modulesOff = MODULE_KEYS.filter((key) => modules[key] === false);
  const body = await cachedSwr(
    caches.analytics as ServerCache<
      Awaited<ReturnType<typeof buildCorrelationsResponse>>
    >,
    `${user.id}|correlations|${locale}|off:${modulesOff.join(",")}`,
    () => buildCorrelationsResponse(user.id, locale, modules),
    annotate,
  );

  return apiSuccess(body);
});

async function buildCorrelationsResponse(
  userId: string,
  locale: Awaited<ReturnType<typeof resolveServerLocale>>,
  modules: SurfaceModuleMap,
) {
  const profile = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const tz = profile?.timezone ?? DEFAULT_TIMEZONE;
  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS * MS_PER_DAY);

  // The channel set comes from the one assembler every discovery surface
  // shares (`discovery-matrix.ts`) — this route, the per-metric card, the Coach
  // tool and the period narrative all scan the same matrix by construction.
  // `"tiered"` puts the eligible measurement channels on the DAY rollup
  // read-swap, with per-channel fallback to the raw path on any miss (coverage
  // gap, far-from-UTC profile tz, sleep / cumulative grain). The SWR cache cell
  // above stays in front of this read: the swap only lowers the cost of a cache
  // MISS, it does not replace the cache.
  //
  // v1.22 — lab draws (for the labs ↔ outcome pass) fetch alongside; they feed
  // a different pass over a different grain, so they are not matrix channels.
  //
  // The earlier-findings probe is one indexed lookup on the pattern store; it
  // tells the client whether this record had findings under the engine before
  // the seasonal adjustment, which is what earns the one-time explanation.
  const [matrix, labDraws, findingsBeforeSeasonalAdjustment] =
    await Promise.all([
      assembleDiscoveryMatrix(userId, {
        tz,
        since,
        fetchMode: "tiered",
        modules,
      }),
      isSurfaceVisible("correlation:LAB_DRAWS", modules)
        ? fetchLabDraws(userId, tz, since)
        : Promise.resolve([]),
      hadFindingsBeforeSeasonalAdjustment(userId),
    ]);
  const { series, diagnostics } = matrix;

  const result = discoverCorrelations(series, { locale });

  // v1.22 — rolling early-detection pass over the trailing window, re-using
  // the already-built series (no extra DB read). Emerging pairs exclude anything
  // the retrospective scan already established (no double-count).
  const recentFromDayKey = tzDayKey(
    new Date(now.getTime() - EARLY_WINDOW_DAYS * MS_PER_DAY),
    tz,
  );
  const emerging = discoverEmergingCorrelations(series, result, {
    recentFromDayKey,
    locale,
  });

  // v1.22 — labs ↔ outcome pass (point-vs-window over sparse draws). Degrades
  // to absent when the user has too few draws to clear the per-pair floor.
  const labCorrelations = discoverLabOutcomeCorrelations(labDraws, series, {
    locale,
  });

  const toEvidence = (pattern: (typeof result.discovered)[number]) => ({
    factorKey: pattern.behaviour,
    outcomeKey: pattern.outcome,
    lagDays: pattern.lagDays,
    sampleSize: pattern.n,
    effectSize: pattern.r,
    pValue: pattern.pValue,
    qValue: pattern.qValue,
  });
  const [retrospectiveDecisions, recentDecisions] = await Promise.all([
    syncAcceptedPatterns({
      userId,
      family: PATTERN_FAMILIES.discoveryRetrospective,
      accepted: result.discovered.map(toEvidence),
      computedAt: now,
    }),
    syncAcceptedPatterns({
      userId,
      family: PATTERN_FAMILIES.discoveryRecent,
      accepted: emerging.emerging.map(toEvidence),
      computedAt: now,
    }),
  ]);
  const attachPatternDecision = (
    pattern: (typeof result.discovered)[number],
    decisions: typeof retrospectiveDecisions,
  ) => {
    const decision = decisionForEvidence(decisions, toEvidence(pattern));
    return decision ? { ...pattern, ...decision } : pattern;
  };
  const discovered = result.discovered.map((pattern) =>
    attachPatternDecision(pattern, retrospectiveDecisions),
  );
  const emergingWithDecisions = {
    ...emerging,
    emerging: emerging.emerging.map((pattern) =>
      attachPatternDecision(pattern, recentDecisions),
    ),
  };

  annotate({
    action: { name: "insights.correlations.discover" },
    meta: {
      pairs_tested: result.pairsTested,
      discovered: result.discovered.length,
      fdr_q: result.fdrQ,
      // PERFAUDIT M1 — surfaces when a dense account's window exceeded the
      // read cap. The cap now falls on the OLDEST rows (desc + take), so a
      // capped read still covers the recent window `discoverEmergingCorrelations`
      // needs; this only tells a dashboard the retrospective scan's older
      // half of the window may be thin.
      // The cap can only apply to raw-path channels — rollup-served
      // channels read one row per day per source and cannot reach it.
      measurements_capped: diagnostics.measurementsCapped,
      // Rollup read-swap reach: how many measurement channels rode the DAY
      // rollup tier on this build (the rest took the raw fallback path).
      measurement_rollup_channels: diagnostics.rollupTypes.length,
      mood_entries_capped: diagnostics.moodCapped,
      // FDREXTEND — per-channel day-counts so a dashboard can see whether the
      // two sparse new channels reached the n ≥ 20 floor or degraded to absent.
      compliance_days: diagnostics.complianceDays,
      symptom_days: diagnostics.symptomDays,
      // v1.22 — early-detection + labs reach.
      emerging: emerging.emerging.length,
      emerging_window_days: emerging.windowDays,
      lab_draws: labDraws.length,
      lab_correlations: labCorrelations.discovered.length,
      // v1.25 (W-ENV) — env channel reach (sum of stored daily points across
      // the exposure channels) so a dashboard can see whether weather was
      // available for the scan.
      environment_days: diagnostics.environmentDays,
      custom_metric_channels: diagnostics.customMetricChannels,
      symptom_event_channels: diagnostics.symptomEventChannels,
      custom_metric_days: diagnostics.customMetricDays,
    },
  });

  return {
    ...result,
    discovered,
    emerging: emergingWithDecisions,
    labCorrelations,
    findingsBeforeSeasonalAdjustment,
  };
}
