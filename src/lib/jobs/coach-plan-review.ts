/**
 * v1.22 (W9, C2) — n-of-1 experiment review worker.
 *
 * The genuinely-missing half of the n-of-1 loop. The review SURFACE already
 * exists: `coach-reminder-sweep` finds a CoachPlan whose `reviewDate` has passed
 * and mints a CoachReminder from the plan's own cue→action prose (the in-app
 * tile). What was missing is the READ-BACK — reading the experiment's result
 * back in the user's own before/after numbers and storing it.
 *
 * This worker consumes the sweep's output (it does NOT re-scan `reviewDate`, so
 * it never double-mints or races the sweep): for each minted plan-review
 * reminder whose plan is still `active` and has no outcome yet, it reads a
 * before/after window of the plan's target metric around the experiment's start,
 * builds a grounded, association-only outcome, writes `outcomeEncrypted`, and
 * flips the plan to `reviewed`. The user-visible read-back stays gated behind
 * `COACH_EXPERIMENT_VERDICT` (see `experiment-flag.ts`); this worker only
 * populates the substrate.
 *
 * Safety: association-only ("looks worth keeping", never "proven"/"works"),
 * honest-null on no measurable change, and NO cheerlead when a vital worsened —
 * a regression routes to the doctor, never a "great job". Every experiment is
 * behavioral (the plan extractor never records a clinical/dose trial); the
 * prompt + B0 cases enforce the refuse-clinical-experiment boundary.
 */
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { isCumulativeDaySumType } from "@/lib/measurements/cumulative-day-sum";
import {
  readDayAggregates,
  type DayAggregateRow,
} from "@/lib/measurements/day-aggregates";

export const COACH_PLAN_REVIEW_QUEUE = "coach-plan-review";
// Daily at 05:25 Europe/Berlin — just after the 05:20 reminder sweep, so the
// review reminders it mints are already on file when this worker reads them.
export const COACH_PLAN_REVIEW_CRON = "25 5 * * *";

/** Bound the read-back fan-out per tick. */
const REVIEW_BATCH = 100;
/** Days of measurements read BEFORE the experiment start for the baseline. */
const BEFORE_WINDOW_DAYS = 21;
/** Minimum day-means needed on each side to call a result. */
const MIN_DAYS_PER_SIDE = 3;
const MS_PER_DAY = 86_400_000;
const MAD_TO_SIGMA = 1.4826;
/** A change counts as material at ≥ this fraction of the metric's spread. */
const MATERIAL_SPREAD_FRACTION = 0.5;

export interface CoachPlanReviewSummary {
  reviewed: number;
  insufficient: number;
  errored: number;
}

type ReviewPrisma = Pick<
  PrismaClient,
  "coachReminder" | "coachPlan" | "$queryRaw"
>;

/** Metric valence — whether a higher reading is the better outcome. */
type Valence = "higher-better" | "lower-better" | "neutral";

interface ResolvedMetric {
  type: MeasurementType;
  valence: Valence;
  /** Short human label for the read-back prose. */
  label: string;
}

/**
 * Map a CoachPlan's free-text `metric` string to a measurement series + its
 * valence. Returns `null` for a metric we cannot read (the worker then writes
 * an honest "couldn't measure" outcome so the plan is not re-processed forever).
 */
export function resolvePlanMetric(metric: string): ResolvedMetric | null {
  const m = metric
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  switch (m) {
    case "WEIGHT":
      return { type: "WEIGHT", valence: "neutral", label: "weight" };
    case "SLEEP":
    case "SLEEP_DURATION":
      return {
        type: "SLEEP_DURATION",
        valence: "higher-better",
        label: "sleep",
      };
    case "BLOOD_PRESSURE":
    case "BLOOD_PRESSURE_SYS":
    case "SYSTOLIC":
      return {
        type: "BLOOD_PRESSURE_SYS",
        valence: "lower-better",
        label: "systolic",
      };
    case "STEPS":
    case "ACTIVITY_STEPS":
      return {
        type: "ACTIVITY_STEPS",
        valence: "higher-better",
        label: "steps",
      };
    case "GLUCOSE":
    case "BLOOD_GLUCOSE":
      return {
        type: "BLOOD_GLUCOSE",
        valence: "lower-better",
        label: "glucose",
      };
    case "PULSE":
    case "RESTING_HEART_RATE":
      return {
        type: "RESTING_HEART_RATE",
        valence: "lower-better",
        label: "resting heart rate",
      };
    case "HRV":
    case "HEART_RATE_VARIABILITY":
      return {
        type: "HEART_RATE_VARIABILITY",
        valence: "higher-better",
        label: "HRV",
      };
    default:
      return null;
  }
}

/**
 * One day's value of a plan's metric: the day's total for a cumulative type
 * (steps), the day's mean otherwise (the hourly-weighted mean for pulse).
 * The review read-back and the progress line in the Coach's memory block
 * (`memory/plan-progress.ts`) read a plan's series through this one rule, so
 * the two can never disagree about how the plan went. A step plan used to
 * average the samples of each day, which read a day of 9,000 steps as a few
 * hundred.
 */
export function planDayValue(
  type: MeasurementType,
  row: DayAggregateRow,
): number {
  if (isCumulativeDaySumType(type)) return row.sum;
  return row.dayMean ?? row.sum / row.n;
}

export type ExperimentVerdict =
  "improved" | "worsened" | "no_change" | "changed" | "insufficient";

export interface ExperimentOutcomeInput {
  label: string;
  valence: Valence;
  beforeMean: number;
  afterMean: number;
  beforeDays: number;
  afterDays: number;
  /** Robust spread (MAD·1.4826) of the metric over the window. */
  spread: number;
}

export interface ExperimentOutcome {
  verdict: ExperimentVerdict;
  /** Grounded, association-only read-back prose (stored encrypted). */
  prose: string;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Build the grounded read-back. PURE. Association-only, honest-null, and never a
 * cheerlead on an adverse trend. Returns `insufficient` when either side is too
 * thin to read.
 */
export function buildExperimentOutcome(
  input: ExperimentOutcomeInput,
): ExperimentOutcome {
  if (
    input.beforeDays < MIN_DAYS_PER_SIDE ||
    input.afterDays < MIN_DAYS_PER_SIDE
  ) {
    return {
      verdict: "insufficient",
      prose: `I don't have enough before-and-after readings to call your ${input.label} experiment yet.`,
    };
  }

  const delta = input.afterMean - input.beforeMean;
  const material = Math.max(input.spread * MATERIAL_SPREAD_FRACTION, 0);
  if (material <= 0 || Math.abs(delta) < material) {
    return {
      verdict: "no_change",
      prose: `No measurable change in your ${input.label} over the window — your call whether to keep it.`,
    };
  }

  const absDelta = round1(Math.abs(delta));
  const dir = delta >= 0 ? "up" : "down";

  if (input.valence === "neutral") {
    return {
      verdict: "changed",
      prose: `Your ${input.label} is ${dir} about ${absDelta} since you started — worth noting, not proven.`,
    };
  }

  const improved =
    (input.valence === "higher-better" && delta > 0) ||
    (input.valence === "lower-better" && delta < 0);

  if (improved) {
    return {
      verdict: "improved",
      prose: `Your ${input.label} is ${dir} about ${absDelta} since you started — that looks associated with the change and worth keeping, not proven.`,
    };
  }

  return {
    verdict: "worsened",
    prose: `Your ${input.label} went the other way over the window (${dir} about ${absDelta}) — that's worth raising with your doctor rather than pushing on.`,
  };
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function robustSpread(xs: readonly number[]): number {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m))) * MAD_TO_SIGMA;
}

/**
 * Run one review tick. Idempotent: a plan already flipped to `reviewed` (or one
 * with an outcome) is not re-processed. Fault-isolated per plan.
 */
export async function runCoachPlanReviewTick(
  prisma: ReviewPrisma,
  now: Date = new Date(),
): Promise<CoachPlanReviewSummary> {
  const summary: CoachPlanReviewSummary = {
    reviewed: 0,
    insufficient: 0,
    errored: 0,
  };

  // 1. The plan-review reminders the sweep minted (source "extractor",
  //    relatedPlanId set). Their existence is the "review fired" signal.
  const reminders = await prisma.coachReminder.findMany({
    where: {
      deletedAt: null,
      source: "extractor",
      relatedPlanId: { not: null },
      status: { in: ["due", "surfaced"] },
    },
    take: REVIEW_BATCH,
    select: { relatedPlanId: true },
  });
  const planIds = [
    ...new Set(
      reminders
        .map((r) => r.relatedPlanId)
        .filter((id): id is string => id !== null),
    ),
  ];
  if (planIds.length === 0) return summary;

  // 2. The still-active experiments without an outcome yet.
  const plans = await prisma.coachPlan.findMany({
    where: {
      id: { in: planIds },
      deletedAt: null,
      status: "active",
      outcomeEncrypted: null,
    },
    select: { id: true, userId: true, metric: true, createdAt: true },
  });

  for (const plan of plans) {
    try {
      const resolved = resolvePlanMetric(plan.metric);
      let outcome: ExperimentOutcome;

      if (!resolved) {
        // No readable series for this metric — write an honest, terminal
        // outcome so the plan is not scanned again every night.
        outcome = {
          verdict: "insufficient",
          prose: `I can't read a measurement series for this experiment, so I can't put numbers to how it went.`,
        };
      } else {
        const since = new Date(
          plan.createdAt.getTime() - BEFORE_WINDOW_DAYS * MS_PER_DAY,
        );
        // Day means folded in SQL (UTC days), one row per day however
        // densely the metric is sampled (#1023).
        const byDay = await readDayAggregates({
          userId: plan.userId,
          type: resolved.type,
          since,
          until: now,
          timeZone: "UTC",
          db: prisma,
        });
        // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: the day series above is read with timeZone UTC, so the plan start is cut on the same calendar
        const startKey = plan.createdAt.toISOString().slice(0, 10);
        const before: number[] = [];
        const after: number[] = [];
        const all: number[] = [];
        for (const row of byDay) {
          const dayValue = planDayValue(resolved.type, row);
          all.push(dayValue);
          if (row.day < startKey) before.push(dayValue);
          else after.push(dayValue);
        }
        outcome = buildExperimentOutcome({
          label: resolved.label,
          valence: resolved.valence,
          beforeMean: mean(before),
          afterMean: mean(after),
          beforeDays: before.length,
          afterDays: after.length,
          spread: robustSpread(all),
        });
      }

      await prisma.coachPlan.update({
        where: { id: plan.id },
        data: {
          outcomeEncrypted: encryptToBytes(outcome.prose),
          status: "reviewed",
        },
      });
      if (outcome.verdict === "insufficient") summary.insufficient += 1;
      summary.reviewed += 1;
    } catch {
      summary.errored += 1;
    }
  }

  return summary;
}
