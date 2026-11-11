import { describe, it, expect, vi } from "vitest";
import {
  planDayValue,
  runCoachPlanReviewTick,
} from "@/lib/jobs/coach-plan-review";

type ReviewPrisma = Parameters<typeof runCoachPlanReviewTick>[0];

describe("runCoachPlanReviewTick", () => {
  function fakePrisma(relatedPlanIds: Array<string | null>, flipped = 0) {
    return {
      coachReminder: {
        findMany: vi.fn(async () =>
          relatedPlanIds.map((relatedPlanId) => ({ relatedPlanId })),
        ),
      },
      coachPlan: {
        updateMany: vi.fn(async () => ({ count: flipped })),
        update: vi.fn(),
      },
    };
  }

  it("moves the active plans behind fired reviews to reviewed, and stores no verdict", async () => {
    const prisma = fakePrisma(["p1", "p2", "p1", null], 2);
    const summary = await runCoachPlanReviewTick(
      prisma as unknown as ReviewPrisma,
    );

    expect(summary).toEqual({ reviewed: 2 });
    expect(prisma.coachPlan.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.coachPlan.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["p1", "p2"] }, deletedAt: null, status: "active" },
      data: { status: "reviewed" },
    });
    expect(prisma.coachPlan.update).not.toHaveBeenCalled();
  });

  it("writes nothing when no review fired", async () => {
    const prisma = fakePrisma([]);
    expect(
      await runCoachPlanReviewTick(prisma as unknown as ReviewPrisma),
    ).toEqual({
      reviewed: 0,
    });
    expect(prisma.coachPlan.updateMany).not.toHaveBeenCalled();
  });
});

describe("planDayValue", () => {
  const row = {
    day: "2026-10-01",
    segment: 0,
    n: 9,
    sum: 9000,
    min: 0,
    max: 0,
  };

  it("reads a step day as its total, not the mean of its samples", () => {
    expect(planDayValue("ACTIVITY_STEPS", row)).toBe(9000);
  });

  it("reads a level metric as the day's mean", () => {
    expect(planDayValue("WEIGHT", { ...row, sum: 157, n: 2 })).toBe(78.5);
  });

  it("prefers the hourly-weighted mean where the series has one", () => {
    expect(
      planDayValue("RESTING_HEART_RATE", {
        ...row,
        sum: 120,
        n: 2,
        dayMean: 61,
      }),
    ).toBe(61);
  });
});
