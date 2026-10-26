import { prisma } from "@/lib/db";
import { getMoodSystemPrompt, getMoodUserPrompt } from "@/lib/ai/prompts/mood";
import { getNoKeyMoodStatusText } from "@/lib/insights/no-key-fallbacks";
import { computeSteadyRun } from "@/lib/insights/assessment-context";
import { significantPearsonCorrelation } from "@/lib/analytics/correlations";
import {
  applyPayloadBudget,
  type DailyBucket,
} from "@/lib/insights/bucket-series";
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
import { buildGradedSeriesFromPoints } from "@/lib/insights/graded-series";
import { buildMetricSignal } from "@/lib/insights/metric-signal";
import { round, summarizeSeries } from "@/lib/insights/status-shared";
import {
  runPreparedStatusCard,
  type PreparedStatusCard,
} from "@/lib/insights/status-card-generation";
import {
  coverageSpan,
  prepareStatusCard,
  textStatusCodec,
  type StatusCardBuild,
  type StatusCardContext,
  type StatusCardOptions,
  type StatusCardPlugin,
  type StatusTextResult,
} from "@/lib/insights/status-pipeline";
import { annotate } from "@/lib/logging/context";
import { createCustomLabelResolver } from "@/lib/mood/custom-tags";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";

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
  options?: StatusCardOptions,
): Promise<StatusTextResult> {
  const prepared = await prepareMoodStatusForUser(userId, options);
  return (await runPreparedStatusCard(prepared)) as StatusTextResult;
}

/**
 * Everything up to (not including) the provider call, through the shared
 * status pipeline (`status-pipeline.ts`); this card supplies its snapshot.
 */
export function prepareMoodStatusForUser(
  userId: string,
  options?: StatusCardOptions,
): Promise<PreparedStatusCard> {
  return prepareStatusCard(MOOD_STATUS_CARD, userId, options);
}

type MoodStatusEntry = Awaited<
  ReturnType<typeof readMoodEntriesForStatus>
>[number];
type CrossMetricMeasurement = Awaited<
  ReturnType<typeof readCrossMetricMeasurements>
>[number];

/**
 * The mood snapshot: the mood series against its band, the tag and factor
 * boards the mood page shows, the narrative feed, and the cross-metric
 * context.
 */
async function buildMoodSnapshot(
  ctx: StatusCardContext,
): Promise<StatusCardBuild<undefined>> {
  const { userId, locale, userTz, todayKey } = ctx;
  const entries = await readMoodEntriesForStatus(userId);

  const now = new Date();

  // v1.2.5 — every day-bucketing pass below keys on the user's own
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

  const { totalSpanDays, newestDaysAgo: newestEntryDaysAgo } = coverageSpan(
    entries.length > 0 ? entries[0].moodLoggedAt : null,
    entries.length > 0 ? entries[entries.length - 1].moodLoggedAt : null,
  );

  const measurements = await readCrossMetricMeasurements(userId, now);
  const relations = await computeMoodRelations({
    userId,
    entries,
    measurements,
    moodDaily: moodSeries.daily,
    inTargetPctLast30DailyPoints,
    now,
    userTz,
  });

  // v1.18.10 — hand the model the finished recent-vs-baseline
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
      tags: relations.tagSummary.length > 0 ? relations.tagSummary : null,
      // v1.11.5 — with-vs-without tag influence (only the populated
      // axes are emitted so the prompt stays compact).
      tagInfluence:
        relations.tagInfluence.flat.length > 0 ||
        relations.tagInfluence.structured.length > 0
          ? {
              flat:
                relations.tagInfluence.flat.length > 0
                  ? relations.tagInfluence.flat.map(stripRankingOnly)
                  : null,
              structured:
                relations.tagInfluence.structured.length > 0
                  ? relations.tagInfluence.structured.map(stripRankingOnly)
                  : null,
            }
          : null,
      // v1.11.5 — the ranked "better days" board the user sees, so the
      // model's relations prose matches the on-screen list (shown == sent).
      betterDays: relations.betterDays.length > 0 ? relations.betterDays : null,
      // v1.14.0 — RATED-factor → vital deviation rows (low-vs-high-day Welch
      // delta, FDR-gated). Lets the model say "your data shows sleep runs ~X
      // shorter on days you rate work low (n=N, association not cause)". Only
      // the surviving rows reach the prompt; an empty board emits null.
      factorCrosstab:
        relations.factorCrosstab.length > 0
          ? relations.factorCrosstab.map(stripFactorCrosstab)
          : null,
      narratives: relations.narratives.length > 0 ? relations.narratives : null,
      // v1.9.0 — only emit the daypart pattern when it cleared its
      // spread/sample floors, so the model never reasons over a once-a-day
      // logger's single-bucket artefact.
      timeOfDay: relations.timeOfDay.reliable
        ? {
            buckets: relations.timeOfDay.buckets,
            best: relations.timeOfDay.best,
            worst: relations.timeOfDay.worst,
          }
        : null,
      stability: relations.stability,
    },
    crossMetricContext: moodCrossMetricContext(relations),
  };

  // MOOD is mood-entry backed (not a MeasurementType), so the cross-metric
  // RELATIONS sub-block is sourced from the snapshot's own crossMetricContext
  // rather than the measurement discovery engine; relations stays empty here
  // and the variety / data-strength / repetition signals carry the rotation.
  return {
    snapshot,
    finish: () => ({
      context: {
        repeatCount: computeSteadyRun(moodGraded.weekly, moodGraded.monthly),
        points: moodSeries.daily.length,
        newestDaysAgo: newestEntryDaysAgo,
        relationsFor: null,
      },
      fallbackText: getNoKeyMoodStatusText(locale, moodSignal),
      prompts: (snapshotJson, context) => ({
        systemPrompt: getMoodSystemPrompt(locale),
        userPrompt: getMoodUserPrompt(
          snapshotJson,
          todayKey,
          locale,
          context.previousContextBlock,
          context.assessmentContextBlock,
          context.openerHint,
        ),
      }),
      detail: undefined,
    }),
  };
}

/**
 * The latest 90 mood entries, oldest first, with their structured tags and
 * their rated factors.
 */
function readMoodEntriesForStatus(userId: string) {
  // v1.4.28 — cap at 90 entries (~3 months) for the mood
  // surface. The downstream `applyPayloadBudget` slims further.
  // Order desc + reverse so the per-row consumers downstream (which
  // expect oldest-first) see the same shape.
  return prisma.moodEntry
    .findMany({
      where: {
        userId,
        deletedAt: null,
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
}

/**
 * The cross-metric measurements the correlations and the factor crosstab
 * pair against, bounded to the ~365-day window they can pair in.
 */
async function readCrossMetricMeasurements(userId: string, now: Date) {
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

  return measurements;
}

/**
 * Mood against the other metrics and its own tags: the correlations, the
 * tag summaries and influence, the "better days" board, the factor
 * crosstab, the time-of-day pattern, stability and the narrative feed — the
 * same aggregates the visible mood page shows.
 */
async function computeMoodRelations(args: {
  userId: string;
  entries: MoodStatusEntry[];
  measurements: CrossMetricMeasurement[];
  moodDaily: DailyBucket[];
  inTargetPctLast30DailyPoints: number | null;
  now: Date;
  userTz: string;
}) {
  const {
    userId,
    entries,
    measurements,
    inTargetPctLast30DailyPoints,
    now,
    userTz,
  } = args;
  const moodSeries = { daily: args.moodDaily };
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

  // v1.11.5 — tag "Influence on Mood" + the unified "better days"
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

  return {
    weightSeries,
    sysSeries,
    pulseSeries,
    moodVsWeightCorrelation,
    moodVsSysCorrelation,
    moodVsPulseCorrelation,
    tagSummary,
    tagInfluence,
    betterDays,
    factorCrosstab,
    timeOfDay,
    stability,
    narratives,
  };
}

/**
 * The cross-metric block: each of weight, systolic and pulse with at least
 * three daily points, summarised with its mood correlation.
 */
function moodCrossMetricContext(
  r: Awaited<ReturnType<typeof computeMoodRelations>>,
) {
  return r.weightSeries.daily.length >= 3 ||
    r.sysSeries.daily.length >= 3 ||
    r.pulseSeries.daily.length >= 3
    ? {
        weight:
          r.weightSeries.daily.length >= 3
            ? {
                summary: summarizeSeries(
                  r.weightSeries.daily.map((bucket) => ({
                    value: bucket.value,
                  })),
                ),
                correlation: r.moodVsWeightCorrelation,
              }
            : null,
        bloodPressureSystolic:
          r.sysSeries.daily.length >= 3
            ? {
                summary: summarizeSeries(
                  r.sysSeries.daily.map((bucket) => ({
                    value: bucket.value,
                  })),
                ),
                correlation: r.moodVsSysCorrelation,
              }
            : null,
        pulse:
          r.pulseSeries.daily.length >= 3
            ? {
                summary: summarizeSeries(
                  r.pulseSeries.daily.map((bucket) => ({
                    value: bucket.value,
                  })),
                ),
                correlation: r.moodVsPulseCorrelation,
              }
            : null,
      }
    : null;
}

const MOOD_STATUS_CARD: StatusCardPlugin<StatusTextResult, undefined> = {
  scope: "mood",
  codec: textStatusCodec,
  unavailableText: (locale) => getNoKeyMoodStatusText(locale),
  emptyMessage: "Mood-status summary was empty after normalization",
  build: buildMoodSnapshot,
};
