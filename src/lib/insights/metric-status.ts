/**
 * Generic per-HealthKit-metric assessment generator.
 *
 * The specialised cards (`pulse-status.ts`, …) each plug a metric-specific
 * snapshot + prompt into the status pipeline (`status-pipeline.ts`). This one
 * generator covers every registered HealthKit metric
 * (`metric-status-registry.ts`) through the archetype prompt templates
 * (`prompts/metric-archetypes.ts`), on the same pipeline stages:
 *   - the graded-series snapshot builder (`buildGradedSeriesWithRollups`),
 *   - the stale-while-revalidate cache (`readCachedStatus` /
 *     `resolveReadOnlyStatus`),
 *   - the snapshot seal and content-hash gate,
 *   - the previous-context and anti-repetition blocks,
 *   - the single-card provider run and the standard note persist.
 *
 * The return shape is byte-identical to the specialised generators so
 * `InsightStatusCard` consumes it unchanged.
 *
 * Empty-data guard (design §3): when the metric has no readings the
 * generator returns an `insufficient` marker WITHOUT touching the
 * provider chain — no LLM call, no cache write. The route maps that onto
 * the card's insufficient-data state.
 */
import { prisma } from "@/lib/db";
import { readRecentReadings } from "@/lib/insights/recent-readings";
import {
  getMetricArchetypeSystemPrompt,
  getMetricArchetypeUserPrompt,
} from "@/lib/ai/prompts/metric-archetypes";
import { buildInterpretationBlock } from "@/lib/ai/prompts/interpretation-block";
import {
  getMetricStatusMeta,
  metricStatusScope,
  type MetricStatusMeta,
  type MetricStatusMetricId,
} from "@/lib/insights/metric-status-registry";
import { computeSteadyRun } from "@/lib/insights/assessment-context";
import { getAgeFromDateOfBirth } from "@/lib/analytics/pulse-targets";
import { lookupNormalRange } from "@/lib/insights/derived/norms";
import { buildMetricSignal } from "@/lib/insights/metric-signal";
import { PROMPT_VERSION } from "@/lib/ai/prompts/base-system";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import {
  getNoKeyGeneralStatusText,
  getNoKeyMetricStatusText,
} from "@/lib/insights/no-key-fallbacks";
import { applyPayloadBudget } from "@/lib/insights/bucket-series";
import {
  buildGradedSeriesFromPoints,
  buildGradedSeriesWithRollups,
  convertGradedSeries,
  type GradedSeries,
} from "@/lib/insights/graded-series";
import { summarizeSeries } from "@/lib/insights/status-shared";
import {
  runPreparedStatusCard,
  type PreparedStatusCard,
} from "@/lib/insights/status-card-generation";
import {
  buildStatusPromptContext,
  coverageSpan,
  openStatusCard,
  pendingStatusCard,
  readCachedStatus,
  refreshUnchangedStatus,
  resolveReadOnlyStatus,
  sealStatusSnapshot,
  textStatusCodec,
  type StatusCardContext,
} from "@/lib/insights/status-pipeline";
import { readSleepNights } from "@/lib/measurements/list/sleep-nights";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { annotate } from "@/lib/logging/context";
import { binaryReferenceSex } from "@/lib/profile/sex";
import {
  applyDisplayTransform,
  getReadingTransform,
  invertDisplayTransform,
  isUnitSensitiveType,
  resolveUnitPreferences,
  transformRescales,
  type DisplayTransform,
  type UnitPreferences,
} from "@/lib/measurements/display-transform";

export interface MetricStatusResult {
  hasProvider: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
  preparing?: boolean;
  /**
   * v1.9.0 — true when last-good text is served while a fresh generation is
   * in flight. The card keeps polling (bounded) so the open page upgrades to
   * the warmed assessment without a remount.
   */
  revalidating?: boolean;
  /**
   * v1.8.7.1 — true when the metric has no data at all. The route maps
   * this onto the card's insufficient-data state; no LLM was called.
   */
  insufficient?: boolean;
}

/** Count this metric's live (non-deleted) readings — the empty-data gate. */
async function countMetricReadings(
  userId: string,
  meta: MetricStatusMeta,
): Promise<number> {
  return prisma.measurement.count({
    where: { userId, type: meta.measurementType, deletedAt: null },
  });
}

/**
 * Generate (or read from cache) the generic assessment for one metric.
 * Mirrors the specialised generators' contract:
 *   - cache hit (today, non-stub) → serve it,
 *   - `readOnly` miss → enqueue out-of-band + serve last-good
 *     (stale-while-revalidate),
 *   - empty data → `insufficient`, no LLM call,
 *   - otherwise → build snapshot, run completion, persist.
 */
export async function generateMetricStatus(args: {
  metric: MetricStatusMetricId;
  userId: string;
  locale?: string | null;
  force?: boolean;
  /** Read-only navigation path — never blocks on the provider. */
  readOnly?: boolean;
}): Promise<MetricStatusResult> {
  const meta = getMetricStatusMeta(args.metric);
  if (!meta) {
    // Defensive — the route Zod-validates against the registry, so an
    // unknown id never reaches here. Treat as insufficient rather than
    // throwing so a stale caller degrades gracefully.
    return {
      hasProvider: false,
      text: null,
      cached: false,
      updatedAt: null,
      insufficient: true,
    };
  }
  const prepared = await prepareMetricStatus(meta, args);
  return (await runPreparedStatusCard(prepared)) as MetricStatusResult;
}

/**
 * Everything up to (not including) the provider call, on the shared
 * pipeline stages, with the empty-data gate between the cache read and the
 * read-only path.
 */
async function prepareMetricStatus(
  meta: MetricStatusMeta,
  args: {
    userId: string;
    locale?: string | null;
    force?: boolean;
    readOnly?: boolean;
  },
): Promise<PreparedStatusCard> {
  const ctx = await openStatusCard(
    args.userId,
    metricStatusScope(meta.id),
    args,
  );

  const cached = await readCachedStatus(ctx, textStatusCodec);
  if (cached) return { phase: "served", result: cached };

  // Empty-data guard — no readings means no assessment to generate. Done
  // BEFORE the read-only enqueue so an empty metric never queues an LLM
  // job nor blocks on the provider. The nightly warm pass applies the same
  // gate so the cron never burns a call on an empty metric either.
  const readingCount = await countMetricReadings(args.userId, meta);
  if (readingCount === 0) {
    annotate({
      action: { name: "insights.metric-status.insufficient" },
      meta: { metric: meta.id },
    });
    return {
      phase: "served",
      result: {
        hasProvider: true,
        text: null,
        cached: false,
        updatedAt: null,
        insufficient: true,
      },
    };
  }

  if (ctx.readOnly) {
    // The read-only miss serves the general deterministic line when notes
    // are unavailable; it has no signal to ground a metric line in.
    return {
      phase: "served",
      result: await resolveReadOnlyStatus(
        ctx,
        textStatusCodec,
        getNoKeyGeneralStatusText(ctx.locale),
      ),
    };
  }

  const built = await buildMetricSnapshot(ctx, meta);
  const { snapshotJson, snapshotHash } = await sealStatusSnapshot(
    ctx,
    built.snapshot,
  );
  const unchanged = await refreshUnchangedStatus(
    ctx,
    textStatusCodec,
    snapshotHash,
  );
  if (unchanged) return { phase: "served", result: unchanged };

  const {
    graded,
    summary,
    series,
    newestDaysAgo,
    signal,
    latest,
    reading,
    sex,
  } = built;
  const { locale, todayKey } = ctx;

  // v1.12.1 — diversity / anti-repetition context, all from already-computed
  // data (no new statistics, no new persistence). Grounding is untouched:
  // these blocks add a rotating opening angle, an explicit data-strength
  // line, a steady-run repetition signal, and the FDR-surviving cross-metric
  // correlations that involve THIS metric. The correlation fetch is
  // best-effort and decorative — a failure resolves to no block, never a
  // generation failure. The opener hint is keyed per (user, metric, day)
  // exactly as `derived-assessment-ai.ts` does for the score cards, so the
  // per-metric card opens verdict-first and varies run-to-run.
  const context = await buildStatusPromptContext(ctx, {
    varietyKey: meta.id,
    repeatCount: computeSteadyRun(graded.weekly, graded.monthly),
    points: summary?.points ?? series.daily.length,
    newestDaysAgo,
    relationsFor: meta.measurementType,
  });

  // v1.27.13 — the guideline interpretation block for metrics the
  // knowledge base covers (visceral fat, resting HR, SpO₂, respiratory rate,
  // body temperature, sleep duration, waist, PWV). The band position is
  // computed from the signal's current value (or the latest day when no signal
  // window exists); absent for uncovered metrics (fail-soft to personal-
  // relative). Sex-split bands (waist) resolve only when the profile carries a
  // sex.
  // The guideline bands are canonical, so the band position is classified on
  // the canonical value; the block then prints in the reader's unit.
  const interpretationValue = signal?.current ?? latest?.value ?? null;
  const interpretationBlock =
    interpretationValue !== null
      ? buildInterpretationBlock({
          metricKey: meta.id,
          value: reading.toCanonical(interpretationValue),
          sex,
          locale,
          ...(reading.converts
            ? {
                display: {
                  unit: reading.unit,
                  convert: reading.toDisplay,
                },
              }
            : {}),
        })
      : undefined;

  const fallbackText = getNoKeyMetricStatusText(
    locale,
    signal,
    reading.decimals,
  );
  return pendingStatusCard(ctx, textStatusCodec, {
    systemPrompt: getMetricArchetypeSystemPrompt(built.shownMeta, locale),
    userPrompt: getMetricArchetypeUserPrompt(
      built.shownMeta,
      snapshotJson,
      todayKey,
      locale,
      context.previousContextBlock,
      context.assessmentContextBlock,
      interpretationBlock,
      context.openerHint,
    ),
    hashes: { snapshotHash },
    // v1.12.1 — the phrasing task benefits from a touch more sampling
    // entropy while the FACTS stay pinned by the snapshot + the
    // forbidden-phrase guards. 0.3 was conservative for a 2-4 sentence prose
    // task; 0.45 varies cadence without loosening grounding. The pair used to
    // sit inline here, bypassing the registry that documents every surface's
    // ceiling; it now reads from `AI_BUDGETS.statusArchetype`.
    temperature: AI_BUDGETS.statusArchetype.temperature,
    maxTokens: AI_BUDGETS.statusArchetype.maxTokens,
    fallbackText,
    emptyMessage: `Metric-status summary was empty for ${meta.id}`,
    detail: undefined,
  });
}

/**
 * The metric snapshot, in the reader's units: the series, the reference
 * band (sharpened by age and sex where the norms cover the metric), the
 * signal, and the data coverage.
 */
async function buildMetricSnapshot(
  ctx: StatusCardContext,
  meta: MetricStatusMeta,
) {
  const { userId, locale, userTz, todayKey } = ctx;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      dateOfBirth: true,
      gender: true,
      unitPreference: true,
      glucoseUnit: true,
    },
  });

  // The note is written in the reader's units. The series, the reference band
  // and the signal are converted once, here, before any of them reaches the
  // prompt or the deterministic floor; the registry entry, the rollups and
  // the guideline classification stay canonical. An untransformed metric (and
  // every metric on the default preferences that does not rescale) passes
  // through unchanged, so its snapshot hash does not move.
  const reading = readingDisplay(
    meta,
    resolveUnitPreferences({
      unitPreference: user?.unitPreference,
      glucoseUnit: user?.glucoseUnit,
    }),
  );
  const shownMeta: MetricStatusMeta = {
    ...meta,
    unit: reading.unit,
    ...(meta.normalRange
      ? {
          normalRange: {
            low: reading.toDisplay(meta.normalRange.low),
            high: reading.toDisplay(meta.normalRange.high),
          },
        }
      : {}),
  };

  const now = new Date();

  const { points, measurements } = await readMetricPoints(
    userId,
    meta,
    reading,
    userTz,
  );
  const series = applyPayloadBudget(points, { now, tz: userTz });
  const isSleep = meta.measurementType === "SLEEP_DURATION";
  // SLEEP_DURATION must never go through `buildGradedSeriesWithRollups`: that
  // path reads RAW per-stage rows (and the stage-summed `measurement_rollups`
  // tier) and folds IN_BED + AWAKE + bare ASLEEP + CORE/DEEP/REM into one
  // bucket, double-counting the bare aggregate against its granular partition —
  // it produces an impossible ~20 h "average sleep". Build the graded series
  // straight from the deduped per-night TIME-ASLEEP `points` instead, so every
  // recent/weekly/monthly/yearly bucket is a night total, not a stage sum.
  const graded = isSleep
    ? buildGradedSeriesFromPoints(points, now, userTz)
    : reading.convertGraded(
        await buildGradedSeriesWithRollups(
          userId,
          meta.measurementType,
          now,
          userTz,
        ),
      );
  const summary = summarizeSeries(
    series.daily.map((bucket) => ({ value: bucket.value })),
  );

  const latest = series.daily[0] ?? null;

  const { totalSpanDays, newestDaysAgo } = coverageSpan(
    measurements.length > 0 ? measurements[0].measuredAt : null,
    measurements.length > 0
      ? measurements[measurements.length - 1].measuredAt
      : null,
  );

  const { ageYears, sex, sharpenedRange, normalRange, signal } =
    metricRangeAndSignal({
      meta,
      shownUnit: shownMeta.unit,
      reading,
      graded,
      newestDaysAgo,
      dateOfBirth: user?.dateOfBirth ?? null,
      gender: user?.gender ?? null,
    });

  const snapshot = {
    locale,
    promptVersion: PROMPT_VERSION,
    generatedForDay: todayKey,
    focus: meta.id,
    metric: {
      id: meta.id,
      displayName: meta.displayName,
      unit: shownMeta.unit,
      direction: meta.direction,
      ...(normalRange ? { normalRange } : {}),
      ...(sharpenedRange ? { normalRangeSource: "age-sex-adjusted" } : {}),
    },
    // Profile context for placement only when stored — the medical note
    // limits population ranges to age + sex (NO ancestry/region). Omitted
    // when the profile leaves them blank, so the model leans on baseline.
    profile: {
      ageYears,
      sex,
    },
    dataCoverage: {
      totalMeasurements: measurements.length,
      totalSpanDays,
      newestMeasurementDaysAgo: newestDaysAgo,
    },
    [meta.id]: {
      ...(signal ? { signal } : {}),
      summary,
      series: graded,
      latestDayFocus: latest
        ? { dayOffset: latest.dayOffset, value: latest.value }
        : null,
    },
  };

  return {
    snapshot,
    shownMeta,
    reading,
    graded,
    summary,
    series,
    latest,
    signal,
    sex,
    newestDaysAgo,
  };
}

/**
 * The metric's points in the reader's units, and the readings they came
 * from. SLEEP_DURATION reads per-night totals, every other type its latest
 * readings.
 */
async function readMetricPoints(
  userId: string,
  meta: MetricStatusMeta,
  reading: ReadingDisplay,
  userTz: string,
) {
  // Bounded raw read for the derived recent stats; the monthly/yearly
  // tail comes from the rollup tier (full-history fallback on a miss),
  // exactly as the specialised cards do.
  //
  // SLEEP_DURATION is the one type stored ONE ROW PER STAGE per night
  // (IN_BED / AWAKE / CORE / DEEP / REM, minutes each), so a raw per-row
  // read would feed the status prose a single ~16 min stage as the
  // "current sleep" instead of the night total. Route it through
  // `reconstructSleepNights` (the same helper the dashboard / series /
  // targets use) so every derived value here — `series`, `summary`,
  // `latest` — is a per-night TIME-ASLEEP total in minutes (the registry
  // unit + normalRange are already minutes). The night reconstruction
  // clusters stages into sessions, dedups multi-source nights via the
  // user's `sleep` priority ladder, and handles the midnight split. Gated
  // to SLEEP_DURATION only so no other metric's status path changes.
  const isSleep = meta.measurementType === "SLEEP_DURATION";

  // v1.2.5 — the day bucketing below keys on the user's own
  // calendar regardless of branch. `userTz` was already resolved above for
  // the cache day-key.

  const points: Array<{ measuredAt: Date; value: number }> = [];
  let measurements: Array<{ measuredAt: Date }> = [];
  if (isSleep) {
    // The latest 365 nights, the sleep twin of the 365 latest readings the
    // other types read (`readRecentReadings`). A cut on stage rows instead (2190 of them) reached
    // back a few weeks on a stage-rich watch and began mid-night.
    const nights = (
      await readSleepNights(
        userId,
        userTz,
        await loadUserSourcePriority(userId),
        { maxNights: 365, newest: true },
      )
    ).filter((n) => n.asleepMinutes > 0);
    for (const n of nights) {
      points.push({ measuredAt: n.measuredAt, value: n.asleepMinutes });
    }
    measurements = nights.map((n) => ({ measuredAt: n.measuredAt }));
  } else {
    // The latest 365 readings, never less than the last 30 days.
    const rows = await readRecentReadings(userId, meta.measurementType);
    for (const m of rows) {
      points.push({
        measuredAt: m.measuredAt,
        value: reading.toDisplay(m.value),
      });
    }
    measurements = rows.map((m) => ({ measuredAt: m.measuredAt }));
  }
  return { points, measurements };
}

/**
 * The reference band for this profile and the finished signal.
 */
function metricRangeAndSignal(args: {
  meta: MetricStatusMeta;
  shownUnit: string;
  reading: ReadingDisplay;
  graded: GradedSeries;
  newestDaysAgo: number | null;
  dateOfBirth: Date | null;
  gender: string | null;
}) {
  const { meta, reading, graded, newestDaysAgo } = args;
  const ageYears = getAgeFromDateOfBirth(args.dateOfBirth);
  const sex = binaryReferenceSex(args.gender);

  // v1.10.0 — sharpen the coarse registry `normalRange` with the
  // age/sex reference-range enabler when one is available for this
  // metric + profile; otherwise keep the existing flat anchor (strictly
  // additive, never a regression). Age + sex only — no ancestry/region.
  const sharpenedRange = lookupNormalRange(meta.id, ageYears, sex);
  const canonicalRange = sharpenedRange ?? meta.normalRange;
  const normalRange = canonicalRange
    ? {
        ...canonicalRange,
        low: reading.toDisplay(canonicalRange.low),
        high: reading.toDisplay(canonicalRange.high),
      }
    : canonicalRange;

  // v1.13.x — the SIGNAL block: the recent-vs-baseline comparison + the
  // normal-swing verdict, computed server-side so the model states it rather
  // than re-deriving it from the raw buckets (research-ai-quality.md §4/§5C).
  // Built from the same graded series the snapshot already carries; null only
  // when the recent window is empty, in which case it is omitted.
  const signal = buildMetricSignal({
    metric: meta.displayName,
    unit: args.shownUnit,
    direction: meta.direction,
    graded,
    normalRange: normalRange ?? null,
    normalRangeSource: sharpenedRange ? "age-sex-adjusted" : undefined,
    newestDaysAgo,
  });

  return { ageYears, sex, sharpenedRange, normalRange, signal };
}

type ReadingDisplay = ReturnType<typeof readingDisplay>;

/**
 * How one metric's numbers are written for this reader: the unit symbol, the
 * conversions in both directions, and the decimals a value is read at.
 *
 * Only a unit-sensitive type (`isUnitSensitiveType`: glucose and the
 * metric/imperial set) converts; every other metric keeps its registry unit
 * and its stored numbers. A transform that does not rescale (`converts`
 * false) is the identity, so the default preferences leave a snapshot
 * byte-identical for the metrics whose registry unit already is the display
 * unit.
 */
function readingDisplay(
  meta: MetricStatusMeta,
  preferences: UnitPreferences,
): {
  unit: string;
  decimals: number | undefined;
  converts: boolean;
  toDisplay: (canonical: number) => number;
  toCanonical: (display: number) => number;
  convertGraded: (series: GradedSeries) => GradedSeries;
} {
  if (!isUnitSensitiveType(meta.measurementType)) {
    return {
      unit: meta.unit,
      decimals: undefined,
      converts: false,
      toDisplay: (v) => v,
      toCanonical: (v) => v,
      convertGraded: (series) => series,
    };
  }
  const transform: DisplayTransform = getReadingTransform(
    meta.measurementType,
    preferences,
  );
  const converts = transformRescales(transform);
  return {
    unit: transform.displayUnit,
    decimals: transform.decimals,
    converts,
    toDisplay: (v) => applyDisplayTransform(v, transform),
    toCanonical: (v) => invertDisplayTransform(v, transform),
    convertGraded: (series) =>
      converts ? convertGradedSeries(series, transform) : series,
  };
}
