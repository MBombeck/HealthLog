import { prisma } from "@/lib/db";
import { getMoodSystemPrompt, getMoodUserPrompt } from "@/lib/ai/prompts/mood";
import { openerArchetypeHint } from "@/lib/ai/prompts/opener-archetype";
import type { Locale } from "@/lib/i18n/config";
import { getNoKeyMoodStatusText } from "@/lib/insights/no-key-fallbacks";
import {
  formatPreviousContextForPrompt,
  getPreviousInsightContext,
} from "@/lib/insights/memory";
import {
  buildAssessmentContextBlock,
  computeSteadyRun,
  pickVarietyLead,
} from "@/lib/insights/assessment-context";
import { significantPearsonCorrelation } from "@/lib/analytics/correlations";
import { applyPayloadBudget } from "@/lib/insights/bucket-series";
import {
  type TagInfluenceRow,
  MOOD_GREEN_MAX,
  MOOD_GREEN_MIN,
  MOOD_ORANGE_MAX,
  MOOD_ORANGE_MIN,
  type FactorMetricCrosstabRow,
  computeBetterDays,
  computeFactorMetricCrosstab,
  computeInTargetPct,
  computeMoodMetricCorrelation,
  computeMoodStability,
  computeStructuredTagSummary,
  computeTagInfluence,
  computeTagSummary,
  computeTimeOfDayAverages,
  computeWeekdayAverages,
  pairDailyBuckets,
} from "@/lib/insights/mood-aggregates";
import { computeMoodNarratives } from "@/lib/insights/mood-narratives";
import {
  buildGradedSeriesFromPoints,
  degradeStatusSnapshotToBudget,
} from "@/lib/insights/graded-series";
import { buildMetricSignal } from "@/lib/insights/metric-signal";
import {
  type SupportedLocale,
  normalizeLocale,
  finalizeStatusSummary,
  persistStatusInsight,
  round,
  summarizeSeries,
} from "@/lib/insights/status-shared";
import {
  readFreshStatusText,
  refreshUnchangedStatusInsight,
  resolveReadOnlyStatusMiss,
  statusCacheAction,
} from "@/lib/insights/status-cache";
import { hashInsightSnapshot } from "@/lib/insights/snapshot-hash";
import { returnTimeoutFallback } from "@/lib/insights/timeout-fallback";
import {
  runPreparedStatusCard,
  type PreparedStatusCard,
  type StatusCardResult,
} from "@/lib/insights/status-card-generation";
import { annotate } from "@/lib/logging/context";
import { createCustomLabelResolver } from "@/lib/mood/custom-tags";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { resolveUserTimezone, userDayKey } from "@/lib/tz/resolver";

/**
 * Drop the ranking-only `pooledSd` before a tag-influence row enters the
 * snapshot payload — it exists solely to standardize the better-days sort
 * and has no place in the model prompt or the UI.
 */
function stripRankingOnly(
  row: TagInfluenceRow,
): Omit<TagInfluenceRow, "pooledSd"> {
  const { pooledSd: _pooledSd, ...rest } = row;
  void _pooledSd;
  return rest;
}

/**
 * Trim a factor-crosstab row to the load-bearing stats for the prompt — drop
 * the UI-only `icon`. The factor key + metric + low/high averages + delta + n
 * + confidence + inverse flag are what the model reasons over; the Lucide icon
 * is chrome and has no place in the prompt payload (shown == sent for the
 * statistics, not the glyph).
 */
function stripFactorCrosstab(
  row: FactorMetricCrosstabRow,
): Omit<FactorMetricCrosstabRow, "icon"> {
  const { icon: _icon, ...rest } = row;
  void _icon;
  return rest;
}

/**
 * One cross metric's daily buckets for the mood correlations. The type is
 * passed through, so a pulse day is the mean of its hours' means (see
 * `day-mean.ts`) and a workout hour does not decide the day the mood is
 * paired with; every other type keeps its plain daily mean.
 */
export function crossMetricDailySeries(
  measurements: ReadonlyArray<{
    type: string;
    measuredAt: Date;
    value: number;
  }>,
  type: string,
  now: Date,
  tz: string,
): ReturnType<typeof applyPayloadBudget> {
  return applyPayloadBudget(
    measurements
      .filter((m) => m.type === type)
      .map((m) => ({ measuredAt: m.measuredAt, value: m.value })),
    { now, tz, type },
  );
}

/**
 * Public entry — unchanged signature. Prepares the card (cache-read,
 * read-only miss, snapshot build, hash gate) then, when the LLM is still
 * needed, runs ONE completion through the shared single-card path. The
 * one-call-per-metric behaviour and the timeout / no-provider fallbacks are
 * byte-for-byte the same as before the prepare split (v1.18.7 HIGH-1).
 */
export async function generateMoodStatusForUser(
  userId: string,
  options?: {
    locale?: string | null;
    force?: boolean;
    /** v1.8.3 — read-only navigation path; see weight-status for the rationale. */
    readOnly?: boolean;
  },
): Promise<{
  hasProvider: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
  preparing?: boolean;
  /** v1.9.0 — last-good text served while a refresh is in flight; keep polling. */
  revalidating?: boolean;
}> {
  const prepared = await prepareMoodStatusForUser(userId, options);
  const result = await runPreparedStatusCard(prepared);
  return result as {
    hasProvider: boolean;
    text: string | null;
    cached: boolean;
    updatedAt: string | null;
    preparing?: boolean;
    revalidating?: boolean;
  };
}

/**
 * v1.18.7 (HIGH-1) — everything up to (not including) the provider call.
 * Returns a finished `served` result for every path that never needed the
 * LLM, or a `pending` descriptor the single-card path and the batch path
 * both drive. See `status-card-generation.ts` for the contract.
 */
export async function prepareMoodStatusForUser(
  userId: string,
  options?: {
    locale?: string | null;
    force?: boolean;
    /** v1.8.3 — read-only navigation path; see weight-status for the rationale. */
    readOnly?: boolean;
  },
): Promise<PreparedStatusCard> {
  const locale = normalizeLocale(options?.locale);
  const force = options?.force === true;
  const readOnly = options?.readOnly === true;
  const cacheAction = statusCacheAction("mood", locale);
  // v1.30.3 (QA F5) — resolve the user's own tz BEFORE the day-key so the
  // cache rolls over at the user's local midnight, not Berlin's. Has to
  // happen ahead of the cache read below (the earliest possible return
  // path), not just the later day-bucketing reads.
  const userTz = await resolveUserTimezone(userId);
  const todayKey = userDayKey(new Date(), userTz);

  const cached = await readFreshStatusText({
    userId,
    cacheAction,
    todayKey,
    force,
  });
  if (cached) {
    return {
      phase: "served",
      result: {
        hasProvider: true,
        text: cached.text,
        cached: true,
        updatedAt: cached.updatedAt,
      },
    };
  }

  if (readOnly) {
    const outcome = await resolveReadOnlyStatusMiss({
      userId,
      metric: "mood",
      locale,
    });
    // Unavailable for any reason serves the deterministic line and enqueues
    // nothing. `hasProvider` is provider presence only.
    if (outcome.kind === "unavailable") {
      return {
        phase: "served",
        result: {
          hasProvider: outcome.hasProvider,
          text: getNoKeyMoodStatusText(locale),
          cached: true,
          updatedAt: null,
        },
      };
    }
    // v1.8.7 — stale-while-revalidate: serve the last good assessment
    // (if any) instantly while the worker re-warms; only fall to the empty
    // preparing skeleton when none was ever produced.
    return {
      phase: "served",
      result: {
        hasProvider: true,
        text: outcome.lastGood?.text ?? null,
        cached: outcome.lastGood !== null,
        updatedAt: outcome.lastGood?.updatedAt ?? null,
        preparing: outcome.lastGood === null,
        revalidating: outcome.revalidating,
      },
    };
  }

  // v1.4.28 FB-D2 — cap at 90 entries (~3 months) for the mood
  // surface. The downstream `applyPayloadBudget` slims further.
  // Order desc + reverse so the per-row consumers downstream (which
  // expect oldest-first) see the same shape.
  const entries = await prisma.moodEntry
    .findMany({
      where: {
        userId,
      },
      orderBy: { date: "desc" },
      take: 90,
      select: {
        date: true,
        score: true,
        tags: true,
        moodLoggedAt: true,
        // v1.9.0 — per-row tz anchors the part-of-day bucketing so the
        // snapshot's time-of-day signal matches the visible mood page.
        tz: true,
        // v1.8.6 — pull the structured-tag links so the snapshot feeds
        // `computeMoodNarratives` the same structured-tag pool the visible
        // mood page does (shown == sent for the tag→mood takeaways).
        // v1.14.0 — also pull the per-link `rating` + factor kind/scale/inverse
        // so RATED factors feed the factor crosstab in the snapshot.
        tagLinks: {
          select: {
            rating: true,
            moodTag: {
              select: {
                key: true,
                labelKey: true,
                // v1.16.11 — owner + ciphertext so a custom tag's decrypted
                // label reaches the snapshot beside its labelKey (which just
                // mirrors the raw `custom:<uuid>` key — the model would
                // otherwise reason over an opaque uuid). Decrypted once per
                // distinct tag, never per entry link.
                userId: true,
                labelEncrypted: true,
                icon: true,
                kind: true,
                scaleMin: true,
                scaleMax: true,
                inverse: true,
                category: { select: { key: true } },
              },
            },
          },
        },
      },
    })
    .then((rows) => {
      const resolveLabel = createCustomLabelResolver();
      return rows.reverse().map((row) => ({
        date: row.date,
        score: row.score,
        tags: row.tags,
        moodLoggedAt: row.moodLoggedAt,
        tz: row.tz,
        structuredTags: (row.tagLinks ?? [])
          .filter((link) => link.moodTag.kind !== "RATED")
          .map((link) => ({
            key: link.moodTag.key,
            categoryKey: link.moodTag.category.key,
            labelKey: link.moodTag.labelKey,
            label: resolveLabel(link.moodTag),
            icon: link.moodTag.icon,
          })),
        ratedFactors: (row.tagLinks ?? [])
          .filter(
            (link): link is typeof link & { rating: number } =>
              link.moodTag.kind === "RATED" && link.rating != null,
          )
          .map((link) => ({
            key: link.moodTag.key,
            categoryKey: link.moodTag.category.key,
            labelKey: link.moodTag.labelKey,
            icon: link.moodTag.icon,
            rating: link.rating,
            scaleMin: link.moodTag.scaleMin,
            scaleMax: link.moodTag.scaleMax,
            inverse: link.moodTag.inverse,
          })),
      }));
    });

  const now = new Date();

  // v1.2.5 (M-TZ3) — every day-bucketing pass below keys on the user's own
  // calendar day. `userTz` was already resolved above for the cache day-key.

  const moodPoints = entries.map((entry) => ({
    measuredAt: entry.moodLoggedAt,
    value: entry.score,
  }));
  // `applyPayloadBudget` daily buckets drive the in-target %, latest,
  // and correlations; the compact graded series reaches the prompt.
  const moodSeries = applyPayloadBudget(moodPoints, { now, tz: userTz });
  const moodGraded = buildGradedSeriesFromPoints(moodPoints, now, userTz);
  const moodSummary = summarizeSeries(
    moodSeries.daily.map((bucket) => ({ value: bucket.value })),
  );

  const greenMin = MOOD_GREEN_MIN;
  const greenMax = MOOD_GREEN_MAX;
  const orangeMin = MOOD_ORANGE_MIN;
  const orangeMax = MOOD_ORANGE_MAX;

  // "Last 30 daily points" = the newest 30 daily buckets (offsets 0..29).
  const inTargetPctLast30DailyPoints = computeInTargetPct(moodSeries.daily);

  // daily[0] = newest bucket (lowest dayOffset).
  const latestMood = moodSeries.daily[0] ?? null;
  const previousMood = moodSeries.daily[1] ?? null;

  const oldestEntry = entries.length > 0 ? entries[0].moodLoggedAt : null;
  const newestEntry =
    entries.length > 0 ? entries[entries.length - 1].moodLoggedAt : null;
  const totalSpanDays =
    oldestEntry && newestEntry
      ? Math.round(
          (newestEntry.getTime() - oldestEntry.getTime()) /
            (24 * 60 * 60 * 1000),
        )
      : 0;
  const newestEntryDaysAgo = newestEntry
    ? Math.round((Date.now() - newestEntry.getTime()) / (24 * 60 * 60 * 1000))
    : null;

  // Fetch cross-metric context for enrichment. v1.4.28 FB-D2 — cap at
  // 1095 = 365 d × 3 channels so power users do not pull unbounded
  // rows. Order desc + reverse so the downstream filters see oldest-
  // first as before.
  // v1.14.0 — union the factor-crosstab vital channels (RHR / HRV / steps /
  // sleep, on top of weight / BP-sys) so the factor board the snapshot carries
  // has its measurements; cap lifted to 365 d × 8 channels. `source` /
  // `deviceType` ride along so the crosstab's per-day canonical-source pick
  // de-dups a cumulative metric reported by two sources on the same day.
  // The crosstab + correlations only pair against the ~365-day window, so
  // bound the read to that window: it lets Postgres use the (userId,
  // measuredAt) index, caps memory to rows that can actually pair, and stops a
  // data-rich Apple-Health account from spending the 50k cap on a recency-
  // biased all-recent slice. `deletedAt: null` keeps soft-deleted rows (common
  // on HRV/RHR/steps re-sync) out of the FDR-gated factor deltas the model
  // cites as fact — matching the visible `/api/mood/insights` board exactly.
  const crossMetricWindowStart = new Date(
    now.getTime() - 365 * 24 * 60 * 60 * 1000,
  );
  const CROSS_METRIC_ROW_CAP = 50_000;
  const measurements = await prisma.measurement
    .findMany({
      where: {
        userId,
        deletedAt: null,
        measuredAt: { gte: crossMetricWindowStart },
        type: {
          in: [
            "WEIGHT",
            "BLOOD_PRESSURE_SYS",
            "PULSE",
            "RESTING_HEART_RATE",
            "HEART_RATE_VARIABILITY",
            "ACTIVITY_STEPS",
            "SLEEP_DURATION",
          ],
        },
      },
      orderBy: { measuredAt: "desc" },
      take: CROSS_METRIC_ROW_CAP,
      select: {
        type: true,
        value: true,
        measuredAt: true,
        source: true,
        deviceType: true,
      },
    })
    .then((rows) => rows.reverse());
  if (measurements.length >= CROSS_METRIC_ROW_CAP) {
    annotate({ meta: { cross_metric_truncated: true } });
  }

  const weightSeries = crossMetricDailySeries(
    measurements,
    "WEIGHT",
    now,
    userTz,
  );
  const sysSeries = crossMetricDailySeries(
    measurements,
    "BLOOD_PRESSURE_SYS",
    now,
    userTz,
  );
  const pulseSeries = crossMetricDailySeries(
    measurements,
    "PULSE",
    now,
    userTz,
  );

  // Correlations between mood and other metrics — pair on dayOffset so
  // the bucketed daily window aligns across metrics.
  const moodVsWeightPairs = pairDailyBuckets(
    moodSeries.daily,
    weightSeries.daily,
    now,
    userTz,
  );
  const moodVsWeightCorrelation =
    significantPearsonCorrelation(moodVsWeightPairs);

  const moodVsSysPairs = pairDailyBuckets(
    moodSeries.daily,
    sysSeries.daily,
    now,
    userTz,
  );
  const moodVsSysCorrelation = significantPearsonCorrelation(moodVsSysPairs);

  const moodVsPulsePairs = pairDailyBuckets(
    moodSeries.daily,
    pulseSeries.daily,
    now,
    userTz,
  );
  const moodVsPulseCorrelation =
    significantPearsonCorrelation(moodVsPulsePairs);

  // Extract tag frequencies from recent entries — keep the v1.4.5
  // ~90-day window so the model still gets a recency-weighted view of
  // tag patterns. Shared with the `/api/mood/insights` tag breakdown
  // via `computeTagSummary` so the prose and the chart never drift.
  const tagSummary = computeTagSummary(entries, now);
  const structuredTagSummary = computeStructuredTagSummary(entries, now);

  // v1.11.5 (F1/F2) — tag "Influence on Mood" + the unified "better days"
  // board, computed from the same aggregates the visible mood page shows so
  // the model's prose never contradicts the on-screen relations. The
  // snapshot fetches only weight / systolic / pulse cross-metrics, so the
  // board's metric factors are limited to those three channels (sleep /
  // steps are absent here by design — the model sees only what it fetched).
  const tagInfluence = computeTagInfluence(entries, now);
  const emptyCorrelation = computeMoodMetricCorrelation([], [], now, userTz);
  const betterDays = computeBetterDays(tagInfluence, {
    sleep: emptyCorrelation,
    steps: emptyCorrelation,
    pulse: computeMoodMetricCorrelation(
      moodSeries.daily,
      pulseSeries.daily,
      now,
      userTz,
    ),
    weight: computeMoodMetricCorrelation(
      moodSeries.daily,
      weightSeries.daily,
      now,
      userTz,
    ),
    bloodPressureSystolic: computeMoodMetricCorrelation(
      moodSeries.daily,
      sysSeries.daily,
      now,
      userTz,
    ),
  });

  // v1.14.0 — RATED-factor × vital crosstab: "on days you rated <factor> low,
  // your <vital> ran X below baseline". Computed from the same entries +
  // measurements the snapshot already holds so the model's prose matches the
  // visible factor board (shown == sent). FDR-controlled + min-N-gated inside
  // `computeFactorMetricCrosstab` — never fabricated on thin data.
  // Thread the user's real source priority so the snapshot's per-day canonical
  // pick matches the visible factor board (a user who prefers WHOOP over Apple
  // for sleep collapses a SUM channel to the same source on screen + in prose).
  const userPriorityJson = await loadUserSourcePriority(userId);
  const factorCrosstab = computeFactorMetricCrosstab({
    entries,
    measurements,
    now,
    userPriorityJson,
    timeZone: userTz,
  });

  // v1.8.6 — the same threshold-gated narrative feed the user sees on
  // the mood page, computed from the same aggregates so the prose the
  // model writes never contradicts the takeaways on screen (shown ==
  // sent). Both the flat free-text tags and the structured taxonomy tags
  // feed the tag→mood pool, matching the visible feed exactly.
  // v1.9.0 — tz-aware part-of-day pattern + day-to-day stability. Computed
  // here so the snapshot carries the same signals the visible mood page
  // surfaces (shown == sent), and the narrative feed can cite the daypart.
  const timeOfDay = computeTimeOfDayAverages(entries);
  const stability = computeMoodStability(moodSeries.daily);

  const narratives = computeMoodNarratives({
    daily: moodSeries.daily,
    weekday: computeWeekdayAverages(moodSeries.daily, now, userTz),
    timeOfDay,
    tags: tagSummary,
    structuredTags: structuredTagSummary,
    inTargetPct: inTargetPctLast30DailyPoints,
    loggedDayKeys: Array.from(new Set(entries.map((entry) => entry.date))),
    now,
    tz: userTz,
  });

  // v1.18.10 (HIGH-4) — hand the model the finished recent-vs-baseline
  // comparison + normal-swing verdict instead of asking it to derive them.
  // Mood reads higher-better against the green band.
  const moodSignal = buildMetricSignal({
    metric: locale === "en" ? "your mood" : "deine Stimmung",
    unit: "/5",
    direction: "higher-better",
    graded: moodGraded,
    normalRange: { low: greenMin, high: greenMax },
    newestDaysAgo: newestEntryDaysAgo,
  });

  const snapshot = {
    locale,
    generatedForDay: todayKey,
    focus: "mood",
    dataCoverage: {
      totalEntries: entries.length,
      totalSpanDays,
      newestEntryDaysAgo,
    },
    mood: {
      ...(moodSignal ? { signal: moodSignal } : {}),
      summary: moodSummary,
      series: moodGraded,
      latestDayFocus: latestMood
        ? {
            dayOffset: latestMood.dayOffset,
            value: latestMood.value,
            deltaToPreviousDailyPoint:
              previousMood == null
                ? null
                : round(latestMood.value - previousMood.value, 2),
          }
        : null,
      target: {
        greenMin,
        greenMax,
        orangeMin,
        orangeMax,
        inTargetPctLast30DailyPoints,
      },
      tags: tagSummary.length > 0 ? tagSummary : null,
      // v1.11.5 (F1) — with-vs-without tag influence (only the populated
      // axes are emitted so the prompt stays compact).
      tagInfluence:
        tagInfluence.flat.length > 0 || tagInfluence.structured.length > 0
          ? {
              flat:
                tagInfluence.flat.length > 0
                  ? tagInfluence.flat.map(stripRankingOnly)
                  : null,
              structured:
                tagInfluence.structured.length > 0
                  ? tagInfluence.structured.map(stripRankingOnly)
                  : null,
            }
          : null,
      // v1.11.5 (F2) — the ranked "better days" board the user sees, so the
      // model's relations prose matches the on-screen list (shown == sent).
      betterDays: betterDays.length > 0 ? betterDays : null,
      // v1.14.0 — RATED-factor → vital deviation rows (low-vs-high-day Welch
      // delta, FDR-gated). Lets the model say "your data shows sleep runs ~X
      // shorter on days you rate work low (n=N, association not cause)". Only
      // the surviving rows reach the prompt; an empty board emits null.
      factorCrosstab:
        factorCrosstab.length > 0
          ? factorCrosstab.map(stripFactorCrosstab)
          : null,
      narratives: narratives.length > 0 ? narratives : null,
      // v1.9.0 — only emit the daypart pattern when it cleared its
      // spread/sample floors, so the model never reasons over a once-a-day
      // logger's single-bucket artefact.
      timeOfDay: timeOfDay.reliable
        ? {
            buckets: timeOfDay.buckets,
            best: timeOfDay.best,
            worst: timeOfDay.worst,
          }
        : null,
      stability,
    },
    crossMetricContext:
      weightSeries.daily.length >= 3 ||
      sysSeries.daily.length >= 3 ||
      pulseSeries.daily.length >= 3
        ? {
            weight:
              weightSeries.daily.length >= 3
                ? {
                    summary: summarizeSeries(
                      weightSeries.daily.map((bucket) => ({
                        value: bucket.value,
                      })),
                    ),
                    correlation: moodVsWeightCorrelation,
                  }
                : null,
            bloodPressureSystolic:
              sysSeries.daily.length >= 3
                ? {
                    summary: summarizeSeries(
                      sysSeries.daily.map((bucket) => ({
                        value: bucket.value,
                      })),
                    ),
                    correlation: moodVsSysCorrelation,
                  }
                : null,
            pulse:
              pulseSeries.daily.length >= 3
                ? {
                    summary: summarizeSeries(
                      pulseSeries.daily.map((bucket) => ({
                        value: bucket.value,
                      })),
                    ),
                    correlation: moodVsPulseCorrelation,
                  }
                : null,
          }
        : null,
  };

  const shed = degradeStatusSnapshotToBudget(
    snapshot as unknown as Record<string, unknown>,
  );
  const snapshotJson = JSON.stringify(snapshot, null, 2);

  annotate({
    action: { name: cacheAction },
    meta: {
      payload_size_bytes: snapshotJson.length,
      ...(shed.length > 0 ? { snapshot_shed: shed } : {}),
    },
  });

  // Content-hash gate (v1.16.8): when the snapshot is unchanged since the
  // last real assessment, refresh the cache timestamp and skip the LLM.
  const snapshotHash = hashInsightSnapshot(snapshot);
  const unchanged = await refreshUnchangedStatusInsight({
    userId,
    cacheAction,
    todayKey,
    snapshotHash,
  });
  if (unchanged) {
    return {
      phase: "served",
      result: {
        hasProvider: true,
        text: unchanged.text,
        cached: true,
        updatedAt: unchanged.updatedAt,
      },
    };
  }

  const previousContext = await getPreviousInsightContext(
    userId,
    "mood-status",
    locale,
    12,
  );
  const previousContextBlock = formatPreviousContextForPrompt(
    previousContext,
    locale,
  );

  // v1.12.7 — diversity / anti-repetition block (see blood-pressure-status).
  // MOOD is mood-entry backed (not a MeasurementType), so the cross-metric
  // RELATIONS sub-block is sourced from the snapshot's own crossMetricContext
  // rather than the measurement discovery engine; relations stays empty here
  // and the variety / data-strength / repetition signals carry the rotation.
  const varietyLead = pickVarietyLead(userId, "mood", todayKey);
  const steadyRun = computeSteadyRun(moodGraded.weekly, moodGraded.monthly);
  const assessmentContextBlock = buildAssessmentContextBlock(
    {
      varietyLead,
      dataStrength: {
        points: moodSeries.daily.length,
        newestDaysAgo: newestEntryDaysAgo,
      },
      repeatCount: steadyRun,
      relations: [],
    },
    locale,
  );

  // The provider call is deferred to the caller — the single-card path runs
  // ONE completion, the batch path folds this prompt into one shared call.
  // A timeout / error is a transient miss (fallback served, no assessment
  // persisted); `none` (no provider / no consent) serves the no-key text.
  return {
    phase: "pending",
    metric: "mood",
    userId,
    cacheAction,
    systemPrompt: getMoodSystemPrompt(locale),
    userPrompt: getMoodUserPrompt(
      snapshotJson,
      todayKey,
      locale,
      previousContextBlock,
      assessmentContextBlock,
      // v1.28.40 — rotating opener hint, per (user, metric, day).
      openerArchetypeHint(`${userId}:mood:${todayKey}`, locale as Locale),
    ),
    snapshotHash,
    // v1.12.7 — match the archetype cards' 0.45.
    temperature: 0.45,
    noProvider: {
      hasProvider: false,
      text: getNoKeyMoodStatusText(locale, moodSignal),
      cached: true,
      updatedAt: null,
    },
    timeout: (reason): StatusCardResult =>
      returnTimeoutFallback({
        cacheAction,
        reason,
        userId,
        todayKey,
        stubText: getNoKeyMoodStatusText(locale, moodSignal),
      }),
    finalize: async (outcome): Promise<StatusCardResult> => {
      // Outbound safety screen. The only transform here used to be
      // whitespace-normalisation, so a dose-change imperative or a fabricated
      // clinical risk score persisted as the day's cached assessment. Policy
      // for a background-generated card is WITHHOLD: serve the deterministic
      // stub and persist no model text (see `finalizeStatusSummary`).
      const screened = finalizeStatusSummary(outcome.content, locale);
      if (!screened.ok) {
        annotate({
          action: { name: "insights.status.outbound_blocked" },
          meta: { cacheAction, reason: screened.reason },
        });
        return returnTimeoutFallback({
          cacheAction,
          reason: "screened",
          userId: userId,
          todayKey: todayKey,
          stubText: getNoKeyMoodStatusText(locale, moodSignal),
        });
      }
      const summary = screened.text;
      if (!summary) {
        throw new Error("Mood-status summary was empty after normalization");
      }
      const updatedAt = await persistStatusInsight({
        userId,
        cacheAction,
        todayKey,
        text: summary,
        snapshotHash,
      });
      return {
        hasProvider: true,
        text: summary,
        cached: false,
        updatedAt,
      };
    },
  };
}

export function resolveMoodStatusLocale(
  locale: string | null | undefined,
): SupportedLocale {
  return normalizeLocale(locale);
}
