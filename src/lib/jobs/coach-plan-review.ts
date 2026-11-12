/**
 * The Coach plan review worker.
 *
 * `coach-reminder-sweep` finds a CoachPlan whose `reviewDate` has passed and
 * mints a review reminder from the plan's own cue and action (the in-app
 * tile). This worker reads the sweep's output (it does not re-scan
 * `reviewDate`, so it never double-mints or races the sweep) and moves every
 * still-active plan behind such a reminder to `reviewed`, which takes it out
 * of the standing group on the plans page.
 *
 * It computes no verdict. How a plan went is read live from its series by the
 * Coach's memory block (`memory/plan-progress.ts`), through `planDayValue`.
 */
import { OWNED_BY_ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import { isCumulativeDaySumType } from "@/lib/measurements/cumulative-day-sum";
import type { DayAggregateRow } from "@/lib/measurements/day-aggregates";

export const COACH_PLAN_REVIEW_QUEUE = "coach-plan-review";
// Daily at 05:25 Europe/Berlin — just after the 05:20 reminder sweep, so the
// review reminders it mints are already on file when this worker reads them.
export const COACH_PLAN_REVIEW_CRON = "25 5 * * *";

/** Bound the fan-out per tick. */
const REVIEW_BATCH = 100;

export interface CoachPlanReviewSummary {
  reviewed: number;
}

type ReviewPrisma = Pick<PrismaClient, "coachReminder" | "coachPlan">;

/**
 * One day's value of a plan's metric: the day's total for a cumulative type
 * (steps), the day's mean otherwise (the hourly-weighted mean for pulse).
 * The progress line in the Coach's memory block (`memory/plan-progress.ts`)
 * reads a plan's series through this rule. A step plan used to average the
 * samples of each day, which read a day of 9,000 steps as a few hundred.
 */
export function planDayValue(
  type: MeasurementType,
  row: DayAggregateRow,
): number {
  if (isCumulativeDaySumType(type)) return row.sum;
  return row.dayMean ?? row.sum / row.n;
}

/**
 * Run one review tick. Idempotent: a plan already past `active` is left
 * alone.
 */
export async function runCoachPlanReviewTick(
  prisma: ReviewPrisma,
): Promise<CoachPlanReviewSummary> {
  // The plan-review reminders the sweep minted (source "extractor",
  // relatedPlanId set). Their existence is the "review fired" signal.
  const reminders = await prisma.coachReminder.findMany({
    where: {
      deletedAt: null,
      source: "extractor",
      relatedPlanId: { not: null },
      status: { in: ["due", "surfaced"] },
      ...OWNED_BY_ACTIVE_ACCOUNT,
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
  if (planIds.length === 0) return { reviewed: 0 };

  const { count } = await prisma.coachPlan.updateMany({
    where: { id: { in: planIds }, deletedAt: null, status: "active" },
    data: { status: "reviewed" },
  });
  return { reviewed: count };
}
