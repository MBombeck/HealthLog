/**
 * `Milestone`, the durable-states reward primitive.
 *
 * A milestone is "a state REACHED" — a durable achievement the record now
 * carries: a metric that settled back inside the user's own range, a run of
 * weeks in range, a fresh personal best. It is deliberately NOT a streak.
 *
 * The distinction is written into the type on purpose: a milestone carries a
 * `sinceDate` (the day the durable state was reached) and NOTHING that counts
 * days still being maintained — no `currentRun`, no `daysHeld`, no counter a
 * future tuning pass could quietly turn into a flame. A missed day is invisible
 * here; there is no "you broke it" state to reach, and none is representable.
 *
 * This module is a THIN wrapper over the engines that already exist — it adds
 * no second detection framework:
 *   - `return_to_baseline` + `sustained_in_range` fold a `StreakResult` from
 *     the pure `detectStreak` engine (`@/lib/insights/streak-detector`).
 *   - `record_first` folds a `PersonalRecord` row (the `pr-detection` infra).
 *
 * Reached-once WITHOUT new storage: a milestone's `sinceDate` is a stable
 * historical fact. `selectFreshMilestone` admits it only on the day it was
 * reached (`sinceDate === todayKey`); the next day it is no longer fresh and
 * never resurfaces. No "which milestones were shown" table is needed — the
 * reached-date IS the once-guarantee.
 *
 * Pure: no DB, no clock, no network. Day keys are UTC-ISO (`YYYY-MM-DD`), the
 * SAME space `readDayMeanSeries` and the rollup tier already emit, so a
 * milestone's reach-day and "today" compare in one consistent space.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import type { ServerTranslator } from "@/lib/i18n/server-translator";
import { metricHref, pageHref } from "@/lib/links/hrefs";
import { MIN_IN_RUN, type StreakResult } from "@/lib/insights/streak-detector";
import { shiftDateKey } from "@/lib/tz/format";

/** Closed set of durable-state kinds. Grows by PR, never with a counter field. */
export const MILESTONE_KINDS = [
  "record_first",
  "return_to_baseline",
  "sustained_in_range",
] as const;

export type MilestoneKind = (typeof MILESTONE_KINDS)[number];

/**
 * One durable state reached. `sinceDate` is the UTC-ISO day the state was
 * reached; `copyKey` is the BASE i18n key under `daily.milestone.*` (the card
 * appends `.title` / `.body`). There is intentionally no numeric run field.
 */
export interface Milestone {
  kind: MilestoneKind;
  metricType: MeasurementType;
  /** UTC-ISO (`YYYY-MM-DD`) day the durable state was REACHED. */
  sinceDate: string;
  /** Base i18n key under `daily.milestone.*`; copy celebrates arrival. */
  copyKey: string;
}

/**
 * The vitals a milestone can celebrate — mirrors `score-narrative`'s
 * `RETURN_SALIENT_TYPES`. All four are core vitals with no toggleable module,
 * so a milestone here never leaks a disabled-module surface.
 */
export const MILESTONE_SALIENT_TYPES: readonly MeasurementType[] = [
  "RESTING_HEART_RATE",
  "HEART_RATE_VARIABILITY",
  "RESPIRATORY_RATE",
  "WEIGHT",
] as const;

/**
 * Durable sustained-in-range states, in WEEKS. A CLOSED, bounded set: reaching
 * week 4 is the last one. There is deliberately no escalation beyond it and no
 * running day count — each threshold is a one-time state, so nothing here can
 * be tuned into an ever-climbing streak.
 */
export const SUSTAINED_WEEK_THRESHOLDS = [1, 2, 3, 4] as const;

/** Per-metric localised-name key + its insight deep-link. */
const METRIC_NAME_KEY: Partial<Record<MeasurementType, string>> = {
  RESTING_HEART_RATE: "daily.milestone.metric.restingHeartRate",
  HEART_RATE_VARIABILITY: "daily.milestone.metric.heartRateVariability",
  RESPIRATORY_RATE: "daily.milestone.metric.respiratoryRate",
  WEIGHT: "daily.milestone.metric.weight",
};

/** The insight surface a milestone's action deep-links to: its metric's page. */
export function milestoneHref(milestone: Milestone): string {
  return metricHref(milestone.metricType) ?? pageHref("insights");
}

/**
 * Fold a `StreakResult` into the durable milestones it represents. Reuses the
 * `detectStreak` engine's output verbatim — this adds no detection logic.
 *
 * `return_to_baseline`: the metric settled BACK inside its own range. The
 * return is reached the moment the in-band run first holds `MIN_IN_RUN` days,
 * so the reach-day is that many days back from the latest reading. This only
 * ever narrates the calm ARRIVAL back inside the range — there is no message
 * for leaving it.
 *
 * `sustained_in_range`: one durable state per week boundary the in-band run has
 * passed, each stamped with the day it was reached. Emitted only while the
 * metric IS currently in-band; a lapse simply stops producing NEW milestones —
 * it is never marked, never mourned.
 */
export function milestonesFromStreak(
  metricType: MeasurementType,
  result: StreakResult,
  latestDayKey: string,
): Milestone[] {
  const out: Milestone[] = [];

  if (result.returnEvent) {
    const reachedDay = shiftDateKey(
      latestDayKey,
      -(result.returnEvent.daysInside - MIN_IN_RUN),
    );
    out.push({
      kind: "return_to_baseline",
      metricType,
      sinceDate: reachedDay,
      copyKey: "daily.milestone.returnToBaseline",
    });
  }

  if (result.inBand && result.latestPlacement === "in") {
    for (const weeks of SUSTAINED_WEEK_THRESHOLDS) {
      const days = weeks * 7;
      if (result.streakDays < days) continue;
      const reachedDay = shiftDateKey(
        latestDayKey,
        -(result.streakDays - days),
      );
      out.push({
        kind: "sustained_in_range",
        metricType,
        sinceDate: reachedDay,
        copyKey: `daily.milestone.sustainedInRange.week${weeks}`,
      });
    }
  }

  return out;
}

/** Fold a personal-record row (its achieved day) into a `record_first` milestone. */
export function milestoneFromRecord(
  metricType: MeasurementType,
  achievedDayKey: string,
): Milestone {
  return {
    kind: "record_first",
    metricType,
    sinceDate: achievedDayKey,
    copyKey: "daily.milestone.record",
  };
}

/**
 * Priority when several milestones land on the same day: a new personal best
 * first (the brightest arrival), then a return to range (closes a worry), then
 * a sustained state. The one/day cap picks the top of this order.
 */
const KIND_PRIORITY: Record<MilestoneKind, number> = {
  record_first: 0,
  return_to_baseline: 1,
  sustained_in_range: 2,
};

/**
 * The reached-once gate: admit only milestones REACHED today, and only ONE —
 * the most meaningful. A milestone reached on an earlier day is a settled fact,
 * not fresh news, so it never resurfaces; a day with no reached state yields
 * `null` (an empty rail entry, never an invented one).
 */
export function selectFreshMilestone(
  candidates: Milestone[],
  todayKey: string,
): Milestone | null {
  const fresh = candidates.filter((m) => m.sinceDate === todayKey);
  if (fresh.length === 0) return null;
  fresh.sort(
    (a, b) =>
      KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] ||
      (a.metricType < b.metricType ? -1 : a.metricType > b.metricType ? 1 : 0),
  );
  return fresh[0];
}

type Translate = ServerTranslator["t"];

/**
 * Resolve a milestone's already-localised card copy. The metric name is
 * interpolated so one copy key serves every salient vital. Copy celebrates the
 * arrival at a durable state — never a maintained count, never a loss.
 */
export function milestoneCopy(
  milestone: Milestone,
  t: Translate,
): { title: string; body: string } {
  const metric = t(
    METRIC_NAME_KEY[milestone.metricType] ?? "daily.milestone.metric.generic",
  );
  return {
    title: t(`${milestone.copyKey}.title`, { metric }),
    body: t(`${milestone.copyKey}.body`, { metric }),
  };
}
