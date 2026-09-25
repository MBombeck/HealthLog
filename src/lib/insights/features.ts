/**
 * Feature extraction for OpenAI insights.
 * Extracts aggregated health metrics from the database.
 * No raw timestamps or exact values are sent in aggregated mode.
 */
import { prisma } from "@/lib/db";
import { summarize } from "@/lib/analytics/trends";
import type { DataPoint } from "@/lib/analytics/trends";
import {
  buildComplianceMedicationContext,
  calculateCompliance,
  lastNonSkippedTakenAt,
  SCHEDULE_COMPLIANCE_SELECT,
} from "@/lib/analytics/compliance";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { userDayKey } from "@/lib/tz/format";
import { isCurrentForTodayClaim } from "@/lib/insights/measurement-freshness";
import { computeMoodDimensionSeries } from "@/lib/insights/mood-dimension-series";
import { computeContextMoodComparison } from "@/lib/insights/mood-context-crosstab";
import { readMoodPrognosis } from "@/lib/analytics/mood-prognosis/read";
import { MOOD_DIMENSIONS } from "@/lib/mood/dimensions";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import {
  reconstructSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { isBpReadingInTarget } from "@/lib/analytics/bp-in-target";
import {
  pairByTimestamp,
  pearsonCorrelation,
  type CorrelationResult,
} from "@/lib/analytics/correlations";
import { getMedicationCategories } from "@/lib/medication-category";
import { sanitizeForPrompt } from "@/lib/insights/sanitize";
import {
  ensureUserMoodRollupsFresh,
  readMoodDayRollups,
} from "@/lib/rollups/mood-rollups";
import {
  readAllTimeExtremes,
  readBucketedSeries,
  readEcgBriefingBlock,
  readLabsBriefingBlock,
  readPreventiveCareBlock,
  readWorkoutsBlock,
} from "@/lib/insights/feature-blocks";
import {
  computeHistoricalComparison,
  computeSignalsOfDay,
  type SignalOfDay,
} from "@/lib/insights/signals-of-day";
import type { RollupGranularity } from "@/generated/prisma/client";

import { resolveWeightTargetOverride } from "@/lib/analytics/effective-range";
import {
  buildWeightTargetFeature,
  type WeightTargetFeature,
} from "@/lib/targets/weight-trend";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";
// The briefing read blocks and the signals-of-day builder moved to
// sibling modules; re-exported so every existing call site keeps
// importing from here.
export * from "@/lib/insights/feature-blocks";
export * from "@/lib/insights/signals-of-day";

/** Max chars of the free-text medication name / dose that may enter the Coach prompt. */
const MED_NAME_MAX_CHARS = 60;
const MED_DOSE_MAX_CHARS = 40;

interface DataCoverage {
  count: number;
  spanDays: number;
  avgDaysBetween: number | null;
  oldestDaysAgo: number;
  newestDaysAgo: number;
}

/**
 * One level-A dimension as the model reads it.
 *
 * `latest` never travels without `newestDaysAgo` and `current` beside it. A
 * value with no age is exactly what produced a reading from last week stated
 * as this morning's, so the age is part of the shape rather than something a
 * caller is trusted to look up.
 */
export interface MoodDimensionFeature {
  key: string;
  /** The wording behind the numbers, so a 7 is not read as 7 out of 5. */
  scale: string;
  /** True when a higher number means a worse day — stress, and only stress. */
  inverse: boolean;
  avg7: number | null;
  avg30: number | null;
  latest: number | null;
  /** The local day the newest value belongs to. */
  latestDate: string | null;
  /** Whole days between that day and today. */
  newestDaysAgo: number | null;
  /**
   * Whether that value may back a present-tense claim. False for an absent
   * age too: a missing age is not a fresh one.
   */
  current: boolean;
  /**
   * Present only when `current` is false, and says in words what the flag
   * says in a boolean. The model reads prose more reliably than it reads a
   * field name, and a stale dimension narrated as today's is the one failure
   * this block exists to prevent.
   */
  staleNotice?: string;
  count: number;
}

/**
 * The level-A blocks for the model, read once over a bounded window.
 *
 * The rollup tier caches the mean of `score` and nothing else, so this is its
 * own read rather than a widened rollup: a cached tier for four columns that
 * may all be NULL would cost a migration to answer a question the live read
 * answers in one indexed range scan. If a surface measurably slows, the tier
 * grows then, as a read-swap with a fallback on a coverage miss — never as a
 * second engine running beside this one.
 *
 * Only dimensions somebody answered are returned. An empty block would invite
 * a sentence about a question that was never asked.
 *
 * A STALE dimension is still returned, carrying its age and an instruction,
 * rather than filtered out the way the health-status surfaces drop a reading
 * too old to describe. That is a deliberate difference and worth the sentence:
 * those surfaces write one line about one metric, so a value they cannot
 * narrate has nothing left to contribute and dropping it is the whole fix.
 * This block is context for an open conversation, where "your stress was 9 on
 * the third, and you have not answered it since" is a useful and true thing to
 * say — and where silence is worse than history, because the reader then has
 * no way to tell an unanswered dimension from one nobody has looked at in a
 * week. The safety therefore rides on `current` plus `staleNotice` rather than
 * on absence, and both are asserted at the shipped composition in
 * `tests/integration/mood-dimension-features.test.ts`.
 */
async function buildMoodDimensionFeatures(
  userId: string,
): Promise<MoodDimensionFeature[] | undefined> {
  const tz = await resolveUserTimezone(userId);
  const { t } = getServerTranslator("en");
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const rows = await prisma.moodEntry.findMany({
    where: { userId, deletedAt: null, moodLoggedAt: { gte: since } },
    orderBy: { moodLoggedAt: "desc" },
    take: 2000,
    select: {
      date: true,
      moodA1: true,
      stressA2: true,
      energyA3: true,
      connectionA4: true,
      stabilityA5: true,
    },
  });
  if (rows.length === 0) return undefined;

  // The same calculator the trend page uses, so the number in a Coach
  // sentence and the number on the chart cannot disagree.
  const summaries = computeMoodDimensionSeries(
    rows.map((row) => ({
      date: row.date,
      a1: row.moodA1,
      a2: row.stressA2,
      a3: row.energyA3,
      a4: row.connectionA4,
      a5: row.stabilityA5,
    })),
    userDayKey(new Date(), tz),
  );

  const blocks = summaries
    .filter((summary) => summary.present)
    .map((summary) => {
      const dimension = MOOD_DIMENSIONS.find((d) => d.key === summary.key)!;
      const current = isCurrentForTodayClaim(summary.newestDaysAgo);
      return {
        key: summary.key,
        // The anchors are resolved through the bundle rather than repeated
        // here: the model must read the same words the person read when they
        // moved the slider, and a second copy of that wording would drift
        // from the one on screen the first time either was edited. English,
        // like the legacy `scale` line beside it.
        scale: `${t(dimension.labelKey)}, 0-10: 0 = ${t(dimension.lowAnchorKey)}, 10 = ${t(dimension.highAnchorKey)}`,
        inverse: summary.inverse,
        avg7: summary.avg7,
        avg30: summary.avg30,
        latest: summary.latest,
        latestDate: summary.latestDate,
        newestDaysAgo: summary.newestDaysAgo,
        current,
        ...(current
          ? {}
          : {
              staleNotice: summary.latestDate
                ? `Last answered on ${summary.latestDate}. State it as history with that date; do not describe it as today.`
                : "No dated value. Do not describe this dimension as current.",
            }),
        count: summary.count,
      };
    });

  return blocks.length > 0 ? blocks : undefined;
}

/**
 * The day-context comparisons, as the model may state them.
 *
 * Every row has already cleared the day floors and a family-wide
 * Benjamini-Hochberg correction, so nothing here is a raw p < 0.05 finding.
 * The counts ride with each row and the block carries one sentence saying
 * what the rows are and are not — a model follows a stated constraint far
 * more reliably than it infers one from a field name, and the constraint here
 * is the difference between an observation and a claim about somebody's life.
 *
 * Bounded: the same 90-day window the dimensions use, and the comparison's own
 * cap on how many rows survive.
 */
async function buildMoodContextBlock(userId: string): Promise<{
  context?: {
    note: string;
    comparisons: Array<{
      field: string;
      value: string;
      withDays: number;
      withoutDays: number;
      withAvg: number;
      withoutAvg: number;
    }>;
  };
}> {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const rows = await prisma.moodEntry.findMany({
    where: {
      userId,
      deletedAt: null,
      moodLoggedAt: { gte: since },
      context: { isNot: null },
    },
    orderBy: { moodLoggedAt: "desc" },
    take: 2000,
    select: {
      date: true,
      moodA1: true,
      context: {
        select: {
          workStatus: true,
          contactCircles: true,
          contactForm: true,
          contactExtent: true,
          leisureCategories: true,
          eventType: true,
        },
      },
    },
  });
  if (rows.length === 0) return {};

  // Days WITHOUT a context belong on the "without" side of every comparison,
  // so the second read takes the whole window rather than only the rows above.
  const allDays = await prisma.moodEntry.findMany({
    where: { userId, deletedAt: null, moodLoggedAt: { gte: since } },
    orderBy: { moodLoggedAt: "desc" },
    take: 2000,
    select: { date: true, moodA1: true },
  });
  const contextByDay = new Map(rows.map((row) => [row.date, row.context]));

  const comparisons = computeContextMoodComparison(
    allDays.map((row) => {
      const context = contextByDay.get(row.date) ?? null;
      return {
        day: row.date,
        moodA1: row.moodA1,
        workStatus: context?.workStatus ?? null,
        contactCircles: context?.contactCircles ?? null,
        contactForm: context?.contactForm ?? null,
        contactExtent: context?.contactExtent ?? null,
        leisureCategories: context?.leisureCategories ?? null,
        eventType: context?.eventType ?? null,
      };
    }),
  );
  if (comparisons.length === 0) return {};

  return {
    context: {
      note:
        "Each row compares the average mood value on days that carried a " +
        "context entry against the days that did not, over the last 90 days. " +
        "These are associations and nothing more: state them with their day " +
        "counts, and never say that the context caused the mood.",
      comparisons: comparisons.map((row) => ({
        field: row.field,
        value: row.value,
        withDays: row.withDays,
        withoutDays: row.withoutDays,
        withAvg: row.withAvg,
        withoutAvg: row.withoutAvg,
      })),
    },
  };
}

/**
 * The dimensions block and the note that says how to read it beside the
 * block-level `asOf`. Absent entirely when nobody has answered a dimension,
 * so an account that only ever taps a face carries neither key.
 */
async function buildMoodDimensionBlock(userId: string): Promise<{
  dimensions?: MoodDimensionFeature[];
  dimensionsAsOfNote?: string;
}> {
  const dimensions = await buildMoodDimensionFeatures(userId);
  if (!dimensions) return {};
  return {
    dimensions,
    dimensionsAsOfNote:
      "The block-level asOf describes the newest mood ENTRY on the 1-5 axis. " +
      "For the five dimensions below, each carries its own newestDaysAgo and " +
      "current, and those are the ones that govern what may be said about " +
      "them today; they are often older than the entry itself.",
  };
}

/**
 * The day's two readings for the model, with the age of the second one.
 *
 * Absence is a present field rather than a missing one: `{ present: false }`
 * with the reason and the count, so the model says "not enough entries yet"
 * instead of inventing a number. That shape is a contract elsewhere in the
 * product already and it is the reason this block is built even when there is
 * nothing to report.
 *
 * The wording rule travels with the values. A model handed a number and no
 * instruction writes the sentence its training suggests, and the sentence its
 * training suggests about a forecast is a causal one.
 */
interface MoodPrognosisFeature {
  present: boolean;
  /** Why there is nothing, when there is nothing. */
  reason?: string;
  /** Days of the account's own history the ladder was read against. */
  entries: number;
  /** The day the forecast is about. */
  date?: string;
  /** The expected value, 0-10. Never to be stated without `n` and the band. */
  predicted?: number;
  ciLow?: number | null;
  ciHigh?: number | null;
  /** Complete days the fit used. State it in any sentence that uses the value. */
  n?: number;
  modelVersion?: string;
  /** The person's own rating for that day, unchanged. */
  selfAssessment?: number | null;
  /** Where that rating sat against the band: within, above or below. */
  deviation?: string | null;
  /** Whole days between the forecast's day and today. */
  daysAgo?: number | null;
  /** Whether it is fresh enough to back a present-tense sentence. */
  current?: boolean;
  /** Present only when it is not, and says in words what the flag says. */
  staleNotice?: string;
  /** The wording rule, stated rather than implied. */
  note: string;
}

/**
 * The forecast block, or an honest absence.
 *
 * One reader for every surface: this calls the same `readMoodPrognosis` the
 * route calls, so the Coach and the page cannot disagree about what today's
 * comparison is. The freshness rule is the shared one — `isCurrentForTodayClaim`
 * against the same `TODAY_CLAIM_MAX_AGE_DAYS` — because a second constant for
 * "how old may a value be before today stops being true about it" is how two
 * surfaces start narrating the same reading differently.
 */
async function buildMoodPrognosisBlock(userId: string): Promise<{
  prognosis?: MoodPrognosisFeature;
}> {
  const reading = await readMoodPrognosis(
    userId,
    new Date(),
    await resolveUserTimezone(userId),
  );

  if (!reading.present) {
    return {
      prognosis: {
        present: false,
        reason: reading.reason,
        entries: reading.entries,
        note:
          "There is no expected-value comparison for this account yet. Say so " +
          "plainly if it comes up; do not estimate one, and do not describe " +
          "the absence as a bad sign.",
      },
    };
  }

  return {
    prognosis: {
      present: true,
      entries: reading.entries,
      date: reading.date,
      predicted: reading.predicted,
      ciLow: reading.ciLow,
      ciHigh: reading.ciHigh,
      n: reading.n,
      modelVersion: reading.modelVersion,
      selfAssessment: reading.selfAssessment,
      deviation: reading.deviation,
      daysAgo: reading.ageDays,
      current: reading.current,
      ...(reading.current
        ? {}
        : {
            staleNotice: `This comparison is about ${reading.date}. State it as that day, with the date; do not describe it as today.`,
          }),
      note:
        "Two separate readings of one day: `selfAssessment` is what the person " +
        "recorded and leads; `predicted` is what a comparison with their own " +
        "past days would have expected, built from `n` days. Never merge them, " +
        "never present `predicted` as the person's mood, and never state it " +
        "without `n` and the band. Phrase it as a counterfactual — a value " +
        "around X would have been expected — and never say that anything " +
        "caused anything: the comparison is an association over the account's " +
        "own days and supports no cause.",
    },
  };
}

export interface AggregatedFeatures {
  weight?: {
    latest: number;
    avg7: number | null;
    avg30: number | null;
    avg90: number | null;
    allTimeAvg: number | null;
    allTimeMin: number | null;
    allTimeMax: number | null;
    slope30: number | null;
    outlierCount: number;
    bmi: number | null;
    coverage: DataCoverage;
    /**
     * v1.39 (#1006) — the person's own stored weight target and which way is
     * progress from where they are now. Absent when no target is stored, and
     * then nothing here says which way is better. Present so a narrative
     * never calls a gain a regression when gaining is exactly the goal.
     */
    target?: WeightTargetFeature;
  };
  bloodPressure?: {
    avgSys30: number | null;
    avgDia30: number | null;
    avgSys90: number | null;
    avgDia90: number | null;
    allTimeAvgSys: number | null;
    allTimeAvgDia: number | null;
    allTimeMinSys: number | null;
    allTimeMaxSys: number | null;
    allTimeMinDia: number | null;
    allTimeMaxDia: number | null;
    slopeSys30: number | null;
    slopeDia30: number | null;
    sdSys30: number | null;
    sdDia30: number | null;
    pulsePressure30: number | null;
    pctInTarget: number | null;
    coverage: DataCoverage;
  };
  pulse?: {
    avg7: number | null;
    avg30: number | null;
    avg90: number | null;
    allTimeAvg: number | null;
    allTimeMin: number | null;
    allTimeMax: number | null;
    slope30: number | null;
    anomalyCount: number;
    coverage: DataCoverage;
  };
  bodyFat?: {
    latest: number | null;
    avg30: number | null;
    slope30: number | null;
    coverage: DataCoverage;
  };
  /**
   * v1.25.1 — grip-strength aggregate (kg). A clinical-depth signal captured
   * and shown on its own detail page with EWGSOP2 sarcopenia bands; this is its
   * present-and-trend block so the daily briefing can narrate the trajectory.
   * The sex-aware floor stays at the display edge (`norms.ts`); the briefing
   * reads the trend. Omitted when no grip readings exist. PHQ-9/GAD-7 stay
   * excluded — only physical signals reach the narrative.
   */
  gripStrength?: {
    latest: number | null;
    avg30: number | null;
    slope30: number | null;
    coverage: DataCoverage;
  };
  /**
   * v1.25.1 — waist aggregate. `latest`/`avg30` are the circumference (cm);
   * `whtrLatest` is the waist-to-height ratio (NICE keeps it < 0.5), computed
   * from the freshest circumference and the user's height. Omitted when no
   * waist readings exist.
   */
  waist?: {
    latest: number | null;
    avg30: number | null;
    slope30: number | null;
    whtrLatest: number | null;
    coverage: DataCoverage;
  };
  /**
   * v1.25.1 — pain aggregate (0–10 NRS, lower-better). Present-and-trend block
   * so the briefing can flag a sustained or rising pain burden. Omitted when no
   * pain readings exist.
   */
  pain?: {
    latest: number | null;
    avg7: number | null;
    avg30: number | null;
    slope30: number | null;
    coverage: DataCoverage;
  };
  mood?: {
    scale: string;
    avg7: number | null;
    avg30: number | null;
    latest: number | null;
    trend30: "improving" | "declining" | "stable" | null;
    totalEntries: number;
    coverage: DataCoverage;
    /**
     * v1.37 — the five level-A self-state values, one block each, and only for
     * the dimensions somebody actually answered. `scale` above describes the
     * legacy 1-5 axis and is handed to the model verbatim, so it is left
     * exactly as it was; these carry their own scale line beside it.
     *
     * Every block states its own age, because the ages differ: stress can be
     * six days old while pleasantness was answered this morning, and a model
     * given one age for the pair narrates the stale one as today's.
     */
    dimensions?: MoodDimensionFeature[];
    /**
     * Says which age governs which claim, because two of them ride in the
     * same block and they disagree by design.
     *
     * `annotateSnapshotFreshness` stamps every metric block with an `asOf`
     * built from `coverage.newestDaysAgo`, which for mood is the age of the
     * newest ENTRY — the 1-5 axis. Somebody who taps a face each morning and
     * opens the sliders once a week has `asOf.daysAgo` of 0 and a stress
     * reading six days old, so a reader taking the block-level stamp as
     * covering the dimensions would state last week's answer as today's.
     * That is the exact sentence this milestone exists to prevent, and it is
     * cheaper to name the precedence than to leave two true numbers looking
     * like a contradiction.
     *
     * Present only alongside `dimensions`.
     */
    dimensionsAsOfNote?: string;
    /**
     * v1.38 — how the average mood value sat on days carrying each day-context
     * entry against the days that did not, over the last 90 days.
     *
     * Present only when at least one comparison cleared the day floors and the
     * family-wide correction. The `note` beside the rows states what they are:
     * a model that is told in a sentence that these are associations states
     * them as associations, and one that is left to infer it from a field name
     * does not.
     */
    context?: {
      note: string;
      comparisons: Array<{
        field: string;
        value: string;
        withDays: number;
        withoutDays: number;
        withAvg: number;
        withoutAvg: number;
      }>;
    };
    /**
     * v1.38 — the day's two readings and the distance between them.
     *
     * Always present once the mood module is on, because an honest absence is
     * information: `present: false` with a reason and a count keeps the model
     * from filling the gap with an estimate. The block carries its own age, so
     * a comparison about the day before yesterday cannot back a sentence about
     * today.
     */
    prognosis?: MoodPrognosisFeature;
  };
  sleep?: {
    avg7: number | null;
    avg30: number | null;
    latest: number | null;
    coverage: DataCoverage;
  };
  activity?: {
    avg7: number | null;
    avg30: number | null;
    latest: number | null;
    coverage: DataCoverage;
  };
  ratePressureProduct?: {
    rpp7: number | null;
    rpp30: number | null;
    risk: "normal" | "elevated" | null;
  };
  bodyCompositionDivergence?: {
    weightStable: boolean;
    bodyFatRising: boolean;
    flag: boolean;
  };
  moodAdherenceRisk?: boolean;
  seasonalVariation?: {
    winterAvgSys: number | null;
    summerAvgSys: number | null;
    delta: number | null;
    significance: "normal" | "elevated" | null;
  };
  correlations?: {
    weightVsSystolic: CorrelationResult | null;
    weightVsDiastolic: CorrelationResult | null;
    pulseVsSystolic: CorrelationResult | null;
    moodVsPulse: CorrelationResult | null;
    moodVsSystolic: CorrelationResult | null;
    moodVsWeight: CorrelationResult | null;
    sleepVsPulse: CorrelationResult | null;
    sleepVsSystolic: CorrelationResult | null;
  };
  historicalComparison?: {
    weight?: {
      current7dAvg: number | null;
      previous30dAvg: number | null;
      change: number | null;
    };
    systolic?: {
      current7dAvg: number | null;
      previous30dAvg: number | null;
      change: number | null;
    };
    diastolic?: {
      current7dAvg: number | null;
      previous30dAvg: number | null;
      change: number | null;
    };
    pulse?: {
      current7dAvg: number | null;
      previous30dAvg: number | null;
      change: number | null;
    };
  };
  medications?: Array<{
    name: string;
    dose: string;
    category: string;
    compliance7: number;
    compliance30: number;
    compliance90: number;
    streak: number;
    missedLast7: number;
  }>;
  context: {
    heightCm: number | null;
    hasBpTargets: boolean;
    totalMeasurements: number;
    dataSpanDays: number;
    oldestMeasurementDaysAgo: number | null;
    newestMeasurementDaysAgo: number | null;
    ageYears: number | null;
    gender: string | null;
  };
  /**
   * v1.18.7 — "Signals of the day": the present-focused read the daily
   * briefing leads with. Each entry compares the freshest reading against
   * the user's own trailing-7d / 30d windows, flags an emerging slope, and
   * surfaces a recent anomaly — ranked by clinical priority, ≤3 entries.
   *
   * Recomputed every day: the freshest reading, the 7/30d windows, and the
   * recency move daily, so a flat 30/90d mean no longer pins the briefing.
   * The block lands inside the compacted features payload, so it also seeds
   * the content-hash gate (`hashInsightSnapshot`) — a fresh daily signal
   * forces the briefing to regenerate. See `computeSignalsOfDay`.
   */
  signalsOfDay?: SignalOfDay[];
  /**
   * v1.22 — glucose aggregate block. Glucose previously reached the briefing
   * only as a single `signalOfDay` row; this is the present-and-trend block the
   * other vitals already carry (7 / 30 / 90-day means + a 30-day slope), from
   * the canonical stored value. Omitted when the user has no glucose readings.
   */
  glucose?: {
    avg7: number | null;
    avg30: number | null;
    avg90: number | null;
    latest: number | null;
    latestDaysAgo: number | null;
    slope30: number | null;
    coverage: DataCoverage;
  };
  /**
   * v1.22 — recent FLAGGED biomarkers (abnormal or trending). Closes the
   * biggest siloed domain: labs reached the Coach snapshot but never the
   * briefing. Hidden biomarkers (the W3 catalog `hidden` flag) are excluded;
   * qualitative rows carry a neutral `unknown` status (no fabricated verdict).
   * Only abnormal / trending markers surface (the briefing-relevant ones) and
   * the list is bounded. Omitted when nothing is flagged.
   */
  labs?: {
    flagged: Array<{
      analyte: string;
      value: number | null;
      valueText: string | null;
      unit: string;
      rangeStatus: "in-range" | "below" | "above" | "unknown";
      /** Direction vs the immediately prior reading; null without a prior. */
      trend: "rising" | "falling" | "flat" | null;
      takenAt: string;
      daysAgo: number;
    }>;
    /** Count of flagged markers (may exceed the bounded `flagged` length). */
    flaggedCount: number;
  };
  /**
   * v1.22 — preventive-care (Vorsorge) read-side: due + overdue items. The
   * early-nudge use case ("your screening is overdue"). Previously fully siloed
   * — captured + scheduled but read by no AI surface. Labels are sanitised
   * (user free-text). Omitted when nothing is due or overdue.
   */
  preventiveCare?: {
    overdue: Array<{ label: string; daysOverdue: number }>;
    due: Array<{ label: string; daysUntil: number }>;
  };
  /**
   * v1.22 — workout aggregate. The briefing previously saw activity only as
   * ACTIVITY_STEPS; the `Workout` table never reached it. Provider-agnostic
   * counts + load over the trailing windows. Omitted when no workouts logged.
   */
  workouts?: {
    last7: {
      count: number;
      totalDurationMin: number;
      totalDistanceKm: number | null;
    };
    last30: {
      count: number;
      totalDurationMin: number;
      totalDistanceKm: number | null;
    };
    latest: {
      sportType: string;
      daysAgo: number;
      durationMin: number;
      distanceKm: number | null;
    } | null;
  };
  /**
   * S10 — ECG recording descriptor (device-verdict only, NON-DIAGNOSTIC). A
   * bounded, existence-and-count read of the user's on-device ECG recordings so
   * the nightly narrative can reference them FACTUALLY and attributed to the
   * device. `deviceVerdicts` / `latestDeviceVerdict` are the RECORDING DEVICE's
   * OWN classifications — HealthLog never re-classifies, never reads the
   * waveform (it never enters this payload), and never emits a verdict of its
   * own. The prompt constrains any mention to the device's attribution; the
   * grounding gate constrains any restated count. Omitted when no recordings
   * fall in the window.
   */
  ecg?: {
    /** Number of ECG recordings in the trailing window. */
    recordingCount: number;
    /** Distribution of the DEVICE's own verdicts across the window. */
    deviceVerdicts: {
      irregular: number;
      notDetected: number;
      inconclusive: number;
    };
    /** The latest recording's DEVICE verdict, or null when unclassified. */
    latestDeviceVerdict: "IRREGULAR" | "NOT_DETECTED" | "INCONCLUSIVE" | null;
    /** Days since the latest recording. */
    latestRecordedDaysAgo: number;
    /** The latest recording's device-reported average HR, or null. */
    latestAverageHeartRate: number | null;
  };
}

/**
 * One bucketed series. `granularity` decides the bucket width (DAY for
 * the trailing 90-day window, WEEK for 90→365 days, MONTH for the
 * 365→1825-day deep history). `bucketStart` is an ISO-8601 UTC
 * timestamp anchored to the start of the bucket — Postgres
 * `date_trunc()` semantics, same as the rollup populator.
 *
 * Replaces v1.4.35.x `rawMeasurements` (which appended every
 * measurement row and blew the 10 MB Codex prompt ceiling on power
 * users with multi-year imports — 25.9 MB observed on the maintainer's account
 * with 311 775 rows). Reading from `measurement_rollups` instead caps
 * the payload at O(types × buckets) regardless of underlying row
 * count.
 */
export interface BucketedSeries {
  type: string;
  granularity: RollupGranularity;
  buckets: Array<{
    bucketStart: string;
    mean: number;
    count: number;
  }>;
}

export interface RawFeatures extends AggregatedFeatures {
  bucketedMeasurements: BucketedSeries[];
}

/**
 * v1.4.36 W3 T1 — payload size ceiling. The Codex provider rejects
 * any prompt-string above 10 MB; the features payload is roughly half
 * the eventual prompt (the JSON dump plus the system + comparison
 * blocks), so a 5 MB feature payload sits comfortably below the
 * ceiling even after locale-prefix expansion. Throwing here lets the
 * route handler downgrade to the non-raw payload + annotate so we
 * catch the regression instead of blowing the upstream call.
 */
export const FEATURES_MAX_BYTES = 5 * 1024 * 1024;

/**
 * v1.18.11 P1 — default bounded read window for the comprehensive briefing.
 *
 * The briefing's prose only ever cites 7 / 30 / 90-day windows plus all-time
 * extremes; the unbounded `measurement.findMany` it used to run materialised
 * the entire history (tens to hundreds of thousands of rows for multi-year
 * Withings / Apple imports) into JS on every generation, only to trim the
 * payload after the fact through the 5 MB downgrade ladder. 400 days captures
 * full history for the overwhelming majority of accounts while keeping the
 * seasonal-BP contrast (winter vs summer, needs >180 d) intact; the genuinely
 * long-horizon all-time min/max/avg figures are sourced separately from a
 * single grouped aggregation over the whole history (see
 * `readAllTimeExtremes`), so bounding the bulk read does not silently relabel a
 * 400-day extreme as "all-time". Mirrors the Coach's 90-day bound
 * (`coach/snapshot.ts`), just wider because the briefing narrates longer trends.
 */
export const BRIEFING_FEATURE_WINDOW_DAYS = 400;

/** Round an all-time mean to 1 decimal, matching the windowed `summarize` mean. */
function roundMean(v: number | null): number | null {
  return v === null ? null : Math.round(v * 10) / 10;
}

export class FeaturesPayloadTooLargeError extends Error {
  readonly code = "FEATURES_PAYLOAD_TOO_LARGE";
  readonly sizeBytes: number;
  readonly limitBytes: number;

  constructor(sizeBytes: number, limitBytes: number) {
    super(
      `Features payload too large: ${sizeBytes} bytes exceeds ${limitBytes} byte cap`,
    );
    this.name = "FeaturesPayloadTooLargeError";
    this.sizeBytes = sizeBytes;
    this.limitBytes = limitBytes;
  }
}

export function stdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.round(Math.sqrt(variance) * 10) / 10;
}

export function toDataPoints(
  records: Array<{ value: number; measuredAt: Date }>,
): DataPoint[] {
  return records.map((r) => ({ date: r.measuredAt, value: r.value }));
}

function computeCoverage(
  records: Array<{ measuredAt: Date }>,
  now: number,
): DataCoverage {
  if (records.length === 0) {
    return {
      count: 0,
      spanDays: 0,
      avgDaysBetween: null,
      oldestDaysAgo: 0,
      newestDaysAgo: 0,
    };
  }
  const oldest = records[0].measuredAt.getTime();
  const newest = records[records.length - 1].measuredAt.getTime();
  const spanDays = Math.round((newest - oldest) / (24 * 60 * 60 * 1000));
  const avgDaysBetween =
    records.length > 1
      ? Math.round((spanDays / (records.length - 1)) * 10) / 10
      : null;
  return {
    count: records.length,
    spanDays,
    avgDaysBetween,
    oldestDaysAgo: Math.round((now - oldest) / (24 * 60 * 60 * 1000)),
    newestDaysAgo: Math.round((now - newest) / (24 * 60 * 60 * 1000)),
  };
}

/** Compute average of values within a time window (days ago from now). */
export function avgInWindow(
  records: Array<{ value: number; measuredAt: Date }>,
  now: number,
  fromDaysAgo: number,
  toDaysAgo: number = 0,
): number | null {
  const fromMs = now - fromDaysAgo * 24 * 60 * 60 * 1000;
  const toMs = now - toDaysAgo * 24 * 60 * 60 * 1000;
  const filtered = records.filter((r) => {
    const t = r.measuredAt.getTime();
    return t >= fromMs && t <= toMs;
  });
  if (filtered.length === 0) return null;
  const sum = filtered.reduce((s, r) => s + r.value, 0);
  return Math.round((sum / filtered.length) * 100) / 100;
}

// ─── v1.22 — cross-signal integration blocks (briefing-scoped) ────────────

/**
 * v1.22 — the integration blocks (labs / preventive-care / workouts) carry
 * extra DB reads. They are BRIEFING-scoped: the daily briefing reads a wide
 * window (`BRIEFING_FEATURE_WINDOW_DAYS`) and narrates long trends, while the
 * Coach snapshot path calls `extractFeatures` with a tight ~90-day window and
 * already carries its own labs / illness / workout context. Gating on the read
 * window keeps these extra reads off every Coach turn without a new caller flag:
 * the briefing window (400) clears it, the Coach window (90) does not.
 */
const INTEGRATION_BLOCK_MIN_WINDOW_DAYS = 180;

/**
 * v1.25 — newest-first row cap on the bulk measurement read in
 * `extractFeatures`. Mirrors the Coach snapshot's `SNAPSHOT_MEASUREMENT_ROW_CAP`
 * (6000): the prompt / insights aggregates only ever fold this read into a
 * bounded set of summaries, so a year of dense PULSE / glucose rows is wasted
 * I/O on the shared pool for a heavy-data tenant. Full-history extremes come
 * from `readAllTimeExtremes`, not this read, so the cap stays correct.
 */
const FEATURE_MEASUREMENT_ROW_CAP = 6000;

export async function extractFeatures(
  userId: string,
  includeRaw: boolean,
  options: { sinceDays?: number } = {},
): Promise<AggregatedFeatures | RawFeatures> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      heightCm: true,
      dateOfBirth: true,
      gender: true,
      thresholdsJson: true,
    },
  });

  const now = Date.now();

  // Fetch measurements. Default = ALL (full temporal context for the
  // dashboard / insights generator). Callers that only consume the
  // ≤90-day windows (Coach snapshot per turn) pass `sinceDays: 90` so
  // the per-turn I/O stays bounded — `findMany({ where: { userId } })`
  // is unbounded by user-history size and gets paid once per Coach turn
  // for power users with multi-year Withings imports.
  const sinceDays = options.sinceDays;
  const sinceCutoff =
    typeof sinceDays === "number" && sinceDays > 0
      ? new Date(now - sinceDays * 24 * 60 * 60 * 1000)
      : null;
  // v1.25 — newest-first cap on the bulk feature read, mirroring the Coach
  // snapshot (`SNAPSHOT_MEASUREMENT_ROW_CAP`). Callers pass windows of 365-400
  // days, and PULSE / glucose are 200k-row-class types, so an uncapped read
  // pulled hundreds of thousands of rows per Coach turn and nightly briefing
  // only to fold them into a handful of summaries. Read newest-first, cap, then
  // reverse so every downstream consumer (`byType`, `summarize`, BP pairing,
  // sleep reconstruction, oldest/newest span) still sees ascending order. The
  // cap is safe even unbounded: the genuine all-time extremes are sourced
  // separately via `readAllTimeExtremes` on the bounded branch, so capping only
  // sheds the deepest rows of the bulk read and never relabels an extreme.
  const measurements = await prisma.measurement
    .findMany({
      where: sinceCutoff
        ? { userId, measuredAt: { gte: sinceCutoff }, deletedAt: null }
        : { userId, deletedAt: null },
      orderBy: { measuredAt: "desc" },
      take: FEATURE_MEASUREMENT_ROW_CAP,
      // Project only the columns every downstream consumer reads (`byType`,
      // `summarize`, BP pairing, and `reconstructSleepNights`'s `SleepStageRow`).
      // The PULSE / glucose windows are 200k-row-class; pulling every column
      // (notes, externalId, …) is pure wasted I/O on the shared Prisma pool.
      select: {
        type: true,
        value: true,
        measuredAt: true,
        sleepStage: true,
        source: true,
        deviceType: true,
      },
    })
    // Restore ascending order so order-sensitive consumers (oldest/newest span,
    // BP pairing, sleep reconstruction) see the same shape as before the cap.
    .then((rows) => rows.reverse());

  // v1.18.11 P1 — when the bulk read is bounded to a recent window, the
  // windowed `summarize()` no longer covers the full history, so the `allTime*`
  // fields would silently become "last `sinceDays` days" extremes. Source the
  // genuine full-history min / max / mean from one grouped aggregation (no row
  // materialisation) so the labels stay honest. Unbounded reads (sinceCutoff
  // null) already see the whole history and skip the extra query.
  const allTimeExtremes = sinceCutoff
    ? await readAllTimeExtremes(userId, [
        "WEIGHT",
        "BLOOD_PRESSURE_SYS",
        "BLOOD_PRESSURE_DIA",
        "PULSE",
      ])
    : null;

  const byType = (type: string) => measurements.filter((m) => m.type === type);

  const bpTargets = getBpTargets(user?.dateOfBirth ?? null);

  // Compute overall data span
  const oldestMeasurement =
    measurements.length > 0 ? measurements[0].measuredAt : null;
  const newestMeasurement =
    measurements.length > 0
      ? measurements[measurements.length - 1].measuredAt
      : null;
  const overallSpanDays =
    oldestMeasurement && newestMeasurement
      ? Math.round(
          (newestMeasurement.getTime() - oldestMeasurement.getTime()) /
            (24 * 60 * 60 * 1000),
        )
      : 0;

  // Compute age
  let ageYears: number | null = null;
  if (user?.dateOfBirth) {
    const dob = user.dateOfBirth;
    const today = new Date();
    ageYears = today.getFullYear() - dob.getFullYear();
    const monthDiff = today.getMonth() - dob.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
      ageYears--;
    }
  }

  const features: AggregatedFeatures = {
    context: {
      heightCm: user?.heightCm ?? null,
      hasBpTargets: !!bpTargets,
      totalMeasurements: measurements.length,
      dataSpanDays: overallSpanDays,
      oldestMeasurementDaysAgo: oldestMeasurement
        ? Math.round(
            (now - oldestMeasurement.getTime()) / (24 * 60 * 60 * 1000),
          )
        : null,
      newestMeasurementDaysAgo: newestMeasurement
        ? Math.round(
            (now - newestMeasurement.getTime()) / (24 * 60 * 60 * 1000),
          )
        : null,
      ageYears,
      gender: user?.gender ?? null,
    },
  };

  // Weight
  const weightData = byType("WEIGHT");
  if (weightData.length > 0) {
    const summary = summarize(toDataPoints(weightData));
    const bmi =
      user?.heightCm && summary.latest
        ? parseFloat((summary.latest / (user.heightCm / 100) ** 2).toFixed(1))
        : null;

    features.weight = {
      latest: summary.latest!,
      avg7: summary.avg7,
      avg30: summary.avg30,
      avg90: avgInWindow(weightData, now, 90),
      // v1.18.11 P1 — full-history extremes from the grouped aggregation when
      // the bulk read is windowed; the in-window summary otherwise.
      allTimeAvg: allTimeExtremes
        ? roundMean(allTimeExtremes.get("WEIGHT")?.mean ?? null)
        : summary.count > 0
          ? summary.mean
          : null,
      allTimeMin: allTimeExtremes
        ? (allTimeExtremes.get("WEIGHT")?.min ?? null)
        : summary.count > 0
          ? summary.min
          : null,
      allTimeMax: allTimeExtremes
        ? (allTimeExtremes.get("WEIGHT")?.max ?? null)
        : summary.count > 0
          ? summary.max
          : null,
      slope30: summary.slope30?.slope ?? null,
      outlierCount: summary.anomalyCount ?? 0,
      bmi,
      coverage: computeCoverage(weightData, now),
    };
    const weightTarget = buildWeightTargetFeature(
      resolveWeightTargetOverride(user?.thresholdsJson),
      { avg7: summary.avg7, latest: summary.latest },
    );
    if (weightTarget) features.weight.target = weightTarget;
  }

  // Blood Pressure
  const sysData = byType("BLOOD_PRESSURE_SYS");
  const diaData = byType("BLOOD_PRESSURE_DIA");
  if (sysData.length > 0 || diaData.length > 0) {
    const sysSummary =
      sysData.length > 0 ? summarize(toDataPoints(sysData)) : null;
    const diaSummary =
      diaData.length > 0 ? summarize(toDataPoints(diaData)) : null;

    let pctInTarget: number | null = null;
    if (bpTargets) {
      const sysByTime = new Map(
        sysData.map((m) => [m.measuredAt.getTime(), m.value]),
      );
      let inTargetCount = 0;
      let pairedCount = 0;
      for (const dia of diaData) {
        const sysVal = sysByTime.get(dia.measuredAt.getTime());
        if (sysVal === undefined) continue;
        pairedCount++;
        // v1.4.16 A2 — one-sided ceiling semantics with hypotension
        // floor. See lib/analytics/bp-in-target.ts.
        if (isBpReadingInTarget(sysVal, dia.value, bpTargets)) {
          inTargetCount++;
        }
      }
      pctInTarget =
        pairedCount > 0
          ? Math.round((inTargetCount / pairedCount) * 100)
          : null;
    }

    features.bloodPressure = {
      avgSys30: sysSummary?.avg30 ?? null,
      avgDia30: diaSummary?.avg30 ?? null,
      avgSys90: sysData.length > 0 ? avgInWindow(sysData, now, 90) : null,
      avgDia90: diaData.length > 0 ? avgInWindow(diaData, now, 90) : null,
      // v1.18.11 P1 — full-history extremes when the bulk read is windowed.
      allTimeAvgSys: allTimeExtremes
        ? roundMean(allTimeExtremes.get("BLOOD_PRESSURE_SYS")?.mean ?? null)
        : sysSummary?.count
          ? sysSummary.mean
          : null,
      allTimeAvgDia: allTimeExtremes
        ? roundMean(allTimeExtremes.get("BLOOD_PRESSURE_DIA")?.mean ?? null)
        : diaSummary?.count
          ? diaSummary.mean
          : null,
      allTimeMinSys: allTimeExtremes
        ? (allTimeExtremes.get("BLOOD_PRESSURE_SYS")?.min ?? null)
        : sysSummary?.count
          ? sysSummary.min
          : null,
      allTimeMaxSys: allTimeExtremes
        ? (allTimeExtremes.get("BLOOD_PRESSURE_SYS")?.max ?? null)
        : sysSummary?.count
          ? sysSummary.max
          : null,
      allTimeMinDia: allTimeExtremes
        ? (allTimeExtremes.get("BLOOD_PRESSURE_DIA")?.min ?? null)
        : diaSummary?.count
          ? diaSummary.min
          : null,
      allTimeMaxDia: allTimeExtremes
        ? (allTimeExtremes.get("BLOOD_PRESSURE_DIA")?.max ?? null)
        : diaSummary?.count
          ? diaSummary.max
          : null,
      slopeSys30: sysSummary?.slope30?.slope ?? null,
      slopeDia30: diaSummary?.slope30?.slope ?? null,
      sdSys30: (() => {
        const fromMs = now - 30 * 24 * 60 * 60 * 1000;
        const vals = sysData
          .filter((m) => m.measuredAt.getTime() >= fromMs)
          .map((m) => m.value);
        return stdDev(vals);
      })(),
      sdDia30: (() => {
        const fromMs = now - 30 * 24 * 60 * 60 * 1000;
        const vals = diaData
          .filter((m) => m.measuredAt.getTime() >= fromMs)
          .map((m) => m.value);
        return stdDev(vals);
      })(),
      pulsePressure30: (() => {
        const avgSys = sysSummary?.avg30 ?? null;
        const avgDia = diaSummary?.avg30 ?? null;
        if (avgSys === null || avgDia === null) return null;
        return Math.round((avgSys - avgDia) * 10) / 10;
      })(),
      pctInTarget,
      coverage: computeCoverage(
        [...sysData, ...diaData].sort(
          (a, b) => a.measuredAt.getTime() - b.measuredAt.getTime(),
        ),
        now,
      ),
    };
  }

  // Pulse
  const pulseData = byType("PULSE");
  if (pulseData.length > 0) {
    const summary = summarize(toDataPoints(pulseData));
    features.pulse = {
      avg7: summary.avg7,
      avg30: summary.avg30,
      avg90: avgInWindow(pulseData, now, 90),
      // v1.18.11 P1 — full-history extremes when the bulk read is windowed.
      allTimeAvg: allTimeExtremes
        ? roundMean(allTimeExtremes.get("PULSE")?.mean ?? null)
        : summary.count > 0
          ? summary.mean
          : null,
      allTimeMin: allTimeExtremes
        ? (allTimeExtremes.get("PULSE")?.min ?? null)
        : summary.count > 0
          ? summary.min
          : null,
      allTimeMax: allTimeExtremes
        ? (allTimeExtremes.get("PULSE")?.max ?? null)
        : summary.count > 0
          ? summary.max
          : null,
      slope30: summary.slope30?.slope ?? null,
      anomalyCount: summary.anomalyCount ?? 0,
      coverage: computeCoverage(pulseData, now),
    };
  }

  // Body Fat
  const fatData = byType("BODY_FAT");
  if (fatData.length > 0) {
    const summary = summarize(toDataPoints(fatData));
    features.bodyFat = {
      latest: summary.latest,
      avg30: summary.avg30,
      slope30: summary.slope30?.slope ?? null,
      coverage: computeCoverage(fatData, now),
    };
  }

  // Grip strength (kg) — clinical-depth signal; the briefing narrates the
  // trajectory, the sex-aware EWGSOP2 floor stays at the display edge.
  const gripData = byType("GRIP_STRENGTH");
  if (gripData.length > 0) {
    const summary = summarize(toDataPoints(gripData));
    features.gripStrength = {
      latest: summary.latest,
      avg30: summary.avg30,
      slope30: summary.slope30?.slope ?? null,
      coverage: computeCoverage(gripData, now),
    };
  }

  // Waist circumference (cm) + waist-to-height ratio. WHtR is computed from the
  // freshest circumference and the user's height (the same canonical derivation
  // the detail page uses); omitted when height is unknown.
  const waistData = byType("WAIST_CIRCUMFERENCE");
  if (waistData.length > 0) {
    const summary = summarize(toDataPoints(waistData));
    const whtrLatest =
      user?.heightCm && summary.latest
        ? Math.round((summary.latest / user.heightCm) * 100) / 100
        : null;
    features.waist = {
      latest: summary.latest,
      avg30: summary.avg30,
      slope30: summary.slope30?.slope ?? null,
      whtrLatest,
      coverage: computeCoverage(waistData, now),
    };
  }

  // Pain (0–10 NRS, lower-better) — surface a sustained or rising pain burden.
  const painData = byType("PAIN_NRS");
  if (painData.length > 0) {
    const summary = summarize(toDataPoints(painData));
    features.pain = {
      latest: summary.latest,
      avg7: summary.avg7,
      avg30: summary.avg30,
      slope30: summary.slope30?.slope ?? null,
      coverage: computeCoverage(painData, now),
    };
  }

  // Sleep Duration
  //
  // SLEEP_DURATION is stored ONE ROW PER STAGE per night, so summarising the
  // raw stage rows would average individual stages (and double-count a bare
  // ASLEEP aggregate against its granular CORE/DEEP/REM twin). Route the
  // feature block through the per-night dedup reconstruction — the same helper
  // the dashboard / series / status path use — so `avg7` / `avg30` / `latest`
  // are per-night TIME-ASLEEP totals in minutes, never stage averages.
  const sleepData = byType("SLEEP_DURATION");
  if (sleepData.length > 0) {
    const [sleepTz, sleepPriority] = await Promise.all([
      resolveUserTimezone(userId),
      loadUserSourcePriority(userId),
    ]);
    const sleepNights = reconstructSleepNights(
      sleepData as unknown as SleepStageRow[],
      sleepTz,
      sleepPriority,
    ).filter((n) => n.asleepMinutes > 0);
    const summary = summarize(
      sleepNights.map((n) => ({ date: n.measuredAt, value: n.asleepMinutes })),
    );
    features.sleep = {
      avg7: summary.avg7,
      avg30: summary.avg30,
      latest: summary.latest,
      coverage: computeCoverage(
        sleepNights.map((n) => ({ measuredAt: n.measuredAt })),
        now,
      ),
    };
  }

  // Activity Steps
  const activityData = byType("ACTIVITY_STEPS");
  if (activityData.length > 0) {
    const summary = summarize(toDataPoints(activityData));
    features.activity = {
      avg7: summary.avg7,
      avg30: summary.avg30,
      latest: summary.latest,
      coverage: computeCoverage(activityData, now),
    };
  }

  // Mood
  //
  // v1.4.40 — swap the unbounded `prisma.moodEntry.findMany` for the
  // persistent mood-rollup DAY tier (audit Critical Finding #2). The
  // feature block downstream consumes:
  //   - `avg7` / `avg30` over recent rollup means
  //   - `trend30` from first-half vs second-half of last 30 days
  //   - `latest` = newest individual entry score (one bounded row)
  //   - `totalEntries` = sum of rollup `count` across all DAY rows
  //   - `oldest` / `newest` = first and last rollup `bucketStart`
  //   - `moodPoints` for cross-metric correlations (one per-day mean
  //     DataPoint — same resolution as the legacy raw-score series for
  //     single-entry-per-day power users, slightly different on
  //     multi-entry days, which is the rollup-tier semantic the
  //     v1.4.39 `/api/mood/analytics` already shipped)
  //
  // Coverage-fallback: when raw entries exist but the rollup tier is
  // still empty (legacy account before boot-time backfill caught up),
  // we fall back to a bounded 1-year raw walk and fire the warm-up so
  // the next request lands on the rollup tier. Same posture as
  // `/api/mood/analytics`.
  void ensureUserMoodRollupsFresh(userId);
  // Five-year window mirrors the mood-rollup writer default; covers
  // every realistic user history span without an unbounded scan.
  const moodSince = new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000);
  const moodRollupDayRows = await readMoodDayRollups(userId, moodSince);

  type MoodDayPoint = {
    measuredAt: Date;
    value: number;
    count: number;
  };
  let moodDailyPoints: MoodDayPoint[] = [];
  let moodLatestScore: number | null = null;
  let moodTotalEntries = 0;

  if (moodRollupDayRows.length > 0) {
    moodDailyPoints = moodRollupDayRows.map((r) => ({
      measuredAt: r.bucketStart,
      value: r.mean,
      count: r.count,
    }));
    moodTotalEntries = moodRollupDayRows.reduce((s, r) => s + r.count, 0);
    // Latest score = newest individual entry (one bounded row).
    const latestEntry = await prisma.moodEntry.findFirst({
      // v1.7.0 sync — exclude tombstoned rows.
      where: { userId, deletedAt: null },
      orderBy: { moodLoggedAt: "desc" },
      select: { score: true },
    });
    moodLatestScore = latestEntry?.score ?? null;
  } else {
    // Coverage-fallback. Bounded 1-year walk (instead of the legacy
    // unbounded `findMany`) so even a cache miss is capped.
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const moodEntriesRaw = await prisma.moodEntry.findMany({
      // v1.7.0 sync — exclude tombstoned rows.
      where: { userId, deletedAt: null, moodLoggedAt: { gte: oneYearAgo } },
      orderBy: { moodLoggedAt: "asc" },
      select: { score: true, moodLoggedAt: true, date: true },
    });
    if (moodEntriesRaw.length > 0) {
      // Bucket per `date` (TZ-anchored YYYY-MM-DD label, same key the
      // rollup tier would emit for Berlin-anchored single-entry days)
      // so the fallback shape matches the rollup-tier shape.
      const byDay = new Map<string, { sum: number; count: number; ts: Date }>();
      for (const e of moodEntriesRaw) {
        const k = e.date;
        const cur = byDay.get(k) ?? { sum: 0, count: 0, ts: e.moodLoggedAt };
        cur.sum += e.score;
        cur.count += 1;
        // Pin the bucket's measuredAt to the latest entry's timestamp
        // — close enough for the trailing-window filters below.
        if (e.moodLoggedAt > cur.ts) cur.ts = e.moodLoggedAt;
        byDay.set(k, cur);
      }
      moodDailyPoints = Array.from(byDay.values())
        .map((b) => ({
          measuredAt: b.ts,
          value: b.sum / b.count,
          count: b.count,
        }))
        .sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
      moodTotalEntries = moodEntriesRaw.length;
      moodLatestScore = moodEntriesRaw[moodEntriesRaw.length - 1].score;
    }
  }

  if (moodDailyPoints.length > 0) {
    const moodNow = Date.now();
    const last7 = moodDailyPoints.filter(
      (e) => moodNow - e.measuredAt.getTime() < 7 * 24 * 60 * 60 * 1000,
    );
    const last30 = moodDailyPoints.filter(
      (e) => moodNow - e.measuredAt.getTime() < 30 * 24 * 60 * 60 * 1000,
    );

    const avg = (points: MoodDayPoint[]) =>
      points.length > 0
        ? Math.round(
            (points.reduce((s, e) => s + e.value, 0) / points.length) * 100,
          ) / 100
        : null;

    // Compute 30-day trend: compare first half vs second half of last 30 days
    let trend30: "improving" | "declining" | "stable" | null = null;
    if (last30.length >= 4) {
      const firstHalf = last30.filter(
        (e) => moodNow - e.measuredAt.getTime() >= 15 * 24 * 60 * 60 * 1000,
      );
      const secondHalf = last30.filter(
        (e) => moodNow - e.measuredAt.getTime() < 15 * 24 * 60 * 60 * 1000,
      );
      if (firstHalf.length >= 2 && secondHalf.length >= 2) {
        const avgFirst = avg(firstHalf)!;
        const avgSecond = avg(secondHalf)!;
        const diff = avgSecond - avgFirst;
        if (diff > 0.3) trend30 = "improving";
        else if (diff < -0.3) trend30 = "declining";
        else trend30 = "stable";
      }
    }

    const oldest = moodDailyPoints[0].measuredAt;
    const newest = moodDailyPoints[moodDailyPoints.length - 1].measuredAt;
    const spanDays = Math.round(
      (newest.getTime() - oldest.getTime()) / (24 * 60 * 60 * 1000),
    );
    const avgDaysBetween =
      moodTotalEntries > 1
        ? Math.round((spanDays / (moodTotalEntries - 1)) * 10) / 10
        : null;

    features.mood = {
      scale: "1=LAUSIG, 2=SCHLECHT, 3=OKAY, 4=GUT, 5=SUPER_GUT",
      avg7: avg(last7),
      avg30: avg(last30),
      latest: moodLatestScore,
      trend30,
      totalEntries: moodTotalEntries,
      ...(await buildMoodDimensionBlock(userId)),
      ...(await buildMoodContextBlock(userId)),
      ...(await buildMoodPrognosisBlock(userId)),
      coverage: {
        count: moodTotalEntries,
        spanDays,
        avgDaysBetween,
        oldestDaysAgo: Math.round(
          (moodNow - oldest.getTime()) / (24 * 60 * 60 * 1000),
        ),
        newestDaysAgo: Math.round(
          (moodNow - newest.getTime()) / (24 * 60 * 60 * 1000),
        ),
      },
    };
  }

  // Cross-metric correlations
  const weightPoints = toDataPoints(weightData);
  const sysPoints = toDataPoints(sysData);
  const diaPoints = toDataPoints(diaData);
  const pulsePoints = toDataPoints(pulseData);
  const moodPoints: DataPoint[] = moodDailyPoints.map((e) => ({
    date: e.measuredAt,
    value: e.value,
  }));

  const computeCorr = (a: DataPoint[], b: DataPoint[]) =>
    pearsonCorrelation(pairByTimestamp(a, b));

  const sleepPoints = toDataPoints(sleepData);

  features.correlations = {
    weightVsSystolic: computeCorr(weightPoints, sysPoints),
    weightVsDiastolic: computeCorr(weightPoints, diaPoints),
    pulseVsSystolic: computeCorr(pulsePoints, sysPoints),
    moodVsPulse: computeCorr(moodPoints, pulsePoints),
    moodVsSystolic: computeCorr(moodPoints, sysPoints),
    moodVsWeight: computeCorr(moodPoints, weightPoints),
    sleepVsPulse:
      sleepData.length > 0 ? computeCorr(sleepPoints, pulsePoints) : null,
    sleepVsSystolic:
      sleepData.length > 0 ? computeCorr(sleepPoints, sysPoints) : null,
  };

  // Rate-Pressure Product (RPP) — myocardial oxygen demand indicator
  if (features.pulse && features.bloodPressure) {
    const rpp7 =
      features.pulse.avg7 !== null && features.bloodPressure.avgSys30 !== null
        ? Math.round(
            features.pulse.avg7 *
              (avgInWindow(sysData, now, 7) ?? features.bloodPressure.avgSys30),
          )
        : null;
    const rpp30 =
      features.pulse.avg30 !== null && features.bloodPressure.avgSys30 !== null
        ? Math.round(features.pulse.avg30 * features.bloodPressure.avgSys30)
        : null;
    const rppRef = rpp30 ?? rpp7;
    features.ratePressureProduct = {
      rpp7,
      rpp30,
      risk: rppRef !== null ? (rppRef > 12000 ? "elevated" : "normal") : null,
    };
  }

  // Body Composition Divergence
  if (features.weight && features.bodyFat) {
    const weightStable =
      features.weight.slope30 !== null &&
      Math.abs(features.weight.slope30) < 0.01;
    const bodyFatRising =
      features.bodyFat.slope30 !== null && features.bodyFat.slope30 > 0;
    features.bodyCompositionDivergence = {
      weightStable,
      bodyFatRising,
      flag: weightStable && bodyFatRising,
    };
  }

  // Mood-Adherence Risk Flag
  if (
    features.mood &&
    features.medications &&
    features.medications.length > 0
  ) {
    features.moodAdherenceRisk =
      features.mood.avg7 !== null &&
      features.mood.avg7 <= 2.5 &&
      features.mood.trend30 === "declining";
  }

  // Seasonal BP Variation (only if > 180 days of data)
  if (features.context.dataSpanDays > 180 && sysData.length > 0) {
    const winterMonths = [11, 0, 1]; // Dec, Jan, Feb (0-indexed)
    const summerMonths = [5, 6, 7]; // Jun, Jul, Aug
    const winterVals = sysData
      .filter((m) => winterMonths.includes(m.measuredAt.getMonth()))
      .map((m) => m.value);
    const summerVals = sysData
      .filter((m) => summerMonths.includes(m.measuredAt.getMonth()))
      .map((m) => m.value);
    const winterAvg =
      winterVals.length > 0
        ? Math.round(
            (winterVals.reduce((s, v) => s + v, 0) / winterVals.length) * 10,
          ) / 10
        : null;
    const summerAvg =
      summerVals.length > 0
        ? Math.round(
            (summerVals.reduce((s, v) => s + v, 0) / summerVals.length) * 10,
          ) / 10
        : null;
    const delta =
      winterAvg !== null && summerAvg !== null
        ? Math.round((winterAvg - summerAvg) * 10) / 10
        : null;
    features.seasonalVariation = {
      winterAvgSys: winterAvg,
      summerAvgSys: summerAvg,
      delta,
      significance:
        delta !== null ? (Math.abs(delta) > 5 ? "elevated" : "normal") : null,
    };
  }

  // Historical comparison: current 7d avg vs previous 30d avg (days 7-37)
  features.historicalComparison = {};
  if (weightData.length > 0) {
    features.historicalComparison.weight = computeHistoricalComparison(
      weightData,
      now,
    );
  }
  if (sysData.length > 0) {
    features.historicalComparison.systolic = computeHistoricalComparison(
      sysData,
      now,
    );
  }
  if (diaData.length > 0) {
    features.historicalComparison.diastolic = computeHistoricalComparison(
      diaData,
      now,
    );
  }
  if (pulseData.length > 0) {
    features.historicalComparison.pulse = computeHistoricalComparison(
      pulseData,
      now,
    );
  }

  // Medications
  const medications = await prisma.medication.findMany({
    // v1.16.11 — as-needed (PRN) medications never surface a compliance
    // rate (no expected doses), so the insight features exclude them.
    where: { userId, active: true, asNeeded: false, ...TRACKED_INTAKE_WHERE },
    // v1.15.20 — schedules through the shared compliance select so the
    // configured per-dose windows reach this surface like every other.
    include: {
      schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
      // v1.16.3 — archived schedule eras for era-aware compliance.
      scheduleRevisions: { orderBy: { validFrom: "asc" } },
      // v1.25 H-MED1 — pause eras so paused days drop out of the denominator.
      pauseEras: { select: { pausedAt: true, resumedAt: true } },
    },
  });

  if (medications.length > 0) {
    const categoryMap = await getMedicationCategories(
      medications.map((med) => med.id),
    );

    // Single batched fetch + in-memory grouping replaces the per-medication
    // findMany loop. Same shape as the v1.3.0 fix to /api/insights/comprehensive
    // (the previous N+1 the v3 audit closed). 90 days is the longest window
    // calculateCompliance uses below, so we don't need the full intake history.
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000);
    const allEvents = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId,
        // v1.7.0 sync — exclude tombstoned rows.
        deletedAt: null,
        medicationId: { in: medications.map((med) => med.id) },
        scheduledFor: { gte: ninetyDaysAgo },
      },
      orderBy: { scheduledFor: "desc" },
      select: {
        medicationId: true,
        takenAt: true,
        skipped: true,
        scheduledFor: true,
      },
    });

    const eventsByMed = new Map<
      string,
      { takenAt: Date | null; skipped: boolean; scheduledFor: Date }[]
    >();
    for (const e of allEvents) {
      const list = eventsByMed.get(e.medicationId) ?? [];
      list.push({
        takenAt: e.takenAt,
        skipped: e.skipped,
        scheduledFor: e.scheduledFor,
      });
      eventsByMed.set(e.medicationId, list);
    }

    // v1.7.0 SB-SCHED-2 — resolve the user timezone once so every
    // per-med compliance call can route its denominator through the
    // canonical engine (RRULE / rolling / one-shot / PRN / cyclic).
    const userTz = await resolveUserTimezone(userId);

    features.medications = medications.map((med) => {
      const mapped = eventsByMed.get(med.id) ?? [];
      const medicationContext = buildComplianceMedicationContext(
        med,
        lastNonSkippedTakenAt(mapped),
        userTz,
      );
      const c7 = calculateCompliance(mapped, med.schedules, 7, med.createdAt, {
        medicationContext,
      });
      const c30 = calculateCompliance(
        mapped,
        med.schedules,
        30,
        med.createdAt,
        {
          medicationContext,
        },
      );
      const c90 = calculateCompliance(
        mapped,
        med.schedules,
        90,
        med.createdAt,
        {
          medicationContext,
        },
      );

      return {
        // v1.30.25 — `name` / `dose` are free text and this struct lands in
        // the Coach SNAPSHOT as `medications`. The category is resolved from
        // `med.id` above, so sanitising the label cannot change any
        // classification. Found by the snapshot free-text guard once its file
        // list was derived from the import graph instead of hardcoded.
        name: sanitizeForPrompt(med.name, MED_NAME_MAX_CHARS),
        dose: sanitizeForPrompt(med.dose, MED_DOSE_MAX_CHARS),
        category: categoryMap[med.id] ?? "OTHER",
        compliance7: c7.rate,
        compliance30: c30.rate,
        compliance90: c90.rate,
        streak: c30.streak,
        missedLast7: c7.missed,
      };
    });
  }

  // v1.18.7 — present-focused "Signals of the day". Computed from the
  // in-memory measurement set (no extra DB round-trip). Lands inside the
  // compacted features payload, so it feeds both the briefing prompt AND the
  // content-hash gate — a fresh daily signal forces the briefing to refresh.
  const signalsOfDay = computeSignalsOfDay(byType, now);
  if (signalsOfDay.length > 0) {
    features.signalsOfDay = signalsOfDay;
  }

  // v1.22 — glucose aggregate block. Computed from the already-fetched
  // measurement set (no extra DB read), so it is always cheap to emit. Glucose
  // previously reached the briefing only as one `signalOfDay` row.
  const glucoseData = byType("BLOOD_GLUCOSE");
  if (glucoseData.length > 0) {
    const summary = summarize(toDataPoints(glucoseData));
    const newest = glucoseData[glucoseData.length - 1];
    features.glucose = {
      avg7: summary.avg7,
      avg30: summary.avg30,
      avg90: avgInWindow(glucoseData, now, 90),
      latest: summary.latest,
      latestDaysAgo: Math.round(
        (now - newest.measuredAt.getTime()) / (24 * 60 * 60 * 1000),
      ),
      slope30: summary.slope30?.slope ?? null,
      coverage: computeCoverage(glucoseData, now),
    };
  }

  // v1.22 — cross-signal integration blocks (labs / preventive-care /
  // workouts). Briefing-scoped: only the wide briefing window pays the extra
  // reads; the tight Coach-snapshot window (which carries its own labs / illness
  // / workout context) skips them. Each block is omitted when its domain is
  // empty (no fabricated zeros). Fetched in parallel — independent reads.
  const includeIntegrations =
    sinceCutoff === null ||
    (typeof sinceDays === "number" &&
      sinceDays >= INTEGRATION_BLOCK_MIN_WINDOW_DAYS);
  if (includeIntegrations) {
    // The preventive-care block states a distance in whole days, so it needs
    // to know whose calendar it is counting on. Resolved here rather than
    // inside the block because the resolver reads the database and this is
    // the layer that already talks to it; the resolver's own 60 s cache makes
    // the second call in this function free.
    const preventiveTz = await resolveUserTimezone(userId);
    const [labs, preventiveCare, workouts, ecg] = await Promise.all([
      readLabsBriefingBlock(userId, now),
      readPreventiveCareBlock(userId, now, preventiveTz),
      readWorkoutsBlock(userId, now),
      // S10 — ECG device-verdict descriptor (never the waveform). Weaves the
      // ECG silo into the narrative; the model may reference it, attributed to
      // the device, but never interprets the trace (it never sees one).
      readEcgBriefingBlock(userId, now),
    ]);
    if (labs) features.labs = labs;
    if (preventiveCare) features.preventiveCare = preventiveCare;
    if (workouts) features.workouts = workouts;
    if (ecg) features.ecg = ecg;
  }

  // v1.4.36 W3 T1 — "raw" mode no longer dumps every measurement row
  // into the prompt. Instead we attach DAY / WEEK / MONTH bucket means
  // from `measurement_rollups` so the model gets the same temporal
  // shape (granular near-term, coarser deep history) at O(buckets)
  // instead of O(rows). The v1.4.35 shape blew past Codex's 10 MB
  // string limit on power users (~25.9 MB observed); the bucketed
  // shape lands at ~50–500 KB per account.
  if (includeRaw) {
    const bucketedMeasurements = await readBucketedSeries(userId, now);
    const rawFeatures: RawFeatures = {
      ...features,
      bucketedMeasurements,
    };
    enforceSizeGuard(rawFeatures);
    return rawFeatures;
  }

  enforceSizeGuard(features);
  return features;
}

/**
 * Hard ceiling on the serialised payload. Throws
 * `FeaturesPayloadTooLargeError` (tagged with `code` so the route
 * handler can pattern-match) when the JSON dump crosses
 * `FEATURES_MAX_BYTES`. The route handler downgrades to the non-raw
 * shape and annotates so the regression is observable; the model
 * call still succeeds.
 */
function enforceSizeGuard(payload: AggregatedFeatures | RawFeatures): void {
  const sizeBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (sizeBytes > FEATURES_MAX_BYTES) {
    throw new FeaturesPayloadTooLargeError(sizeBytes, FEATURES_MAX_BYTES);
  }
}
