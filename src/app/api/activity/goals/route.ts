/**
 * GET / PATCH the caller's activity goals (D1036).
 *
 * Every goal is optional and set by the person; there is no default goal.
 * PATCH replaces the goals the body names (`null` clears one) and keeps the
 * rest; an unknown key or an out-of-bounds goal is refused with the
 * multi-issue 422. The goals live on their own `User` column
 * (`activity_goals_json`) and the activity calendar reads them.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { Prisma } from "@/generated/prisma/client";
import { prisma, toJson } from "@/lib/db";
import { withUserRowLock } from "@/lib/user-row-lock";
import { annotate } from "@/lib/logging/context";
import {
  ACTIVITY_GOAL_KEYS,
  activityGoalsSchema,
  hasNoActivityGoals,
  mergeActivityGoals,
  parseActivityGoals,
  type ActivityGoals,
} from "@/lib/validations/activity-goals";

export const dynamic = "force-dynamic";

async function readGoals(userId: string): Promise<ActivityGoals> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { activityGoalsJson: true },
  });
  return parseActivityGoals(row?.activityGoalsJson ?? null);
}

function setKeys(goals: ActivityGoals): string[] {
  return ACTIVITY_GOAL_KEYS.filter((key) => goals[key] !== null);
}

export const GET = apiHandler(async () => {
  // Owner-only, like the write: a delegate sees the goals where they matter,
  // inside the calendar, which carries them.
  const { user } = await requireAuth();
  const goals = await readGoals(user.id);
  annotate({
    action: { name: "activity.goals.read" },
    meta: { set: setKeys(goals) },
  });
  return apiSuccess(goals);
});

export const PATCH = apiHandler(async (request: Request) => {
  const { user } = await requireAuth();

  const parsed = await parseJsonBody(request, activityGoalsSchema, {
    maxBytes: 1024,
    action: "activity.goals.validation-failed",
  });
  if (!parsed.ok) return parsed.error;

  // Read-merge-write under a row lock: two PATCHes that overlap, each
  // setting another goal, would otherwise both merge into the same stored
  // goals and the later write would drop the earlier one's goal.
  const next = await withUserRowLock(user.id, async (tx) => {
    const row = await tx.user.findUnique({
      where: { id: user.id },
      select: { activityGoalsJson: true },
    });
    const merged = mergeActivityGoals(
      parseActivityGoals(row?.activityGoalsJson ?? null),
      parsed.data,
    );
    await tx.user.update({
      where: { id: user.id },
      data: {
        activityGoalsJson: hasNoActivityGoals(merged)
          ? Prisma.DbNull
          : toJson(merged),
      },
    });
    return merged;
  });

  await auditLog("activity.goals.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { set: setKeys(next) },
  });
  annotate({
    action: { name: "activity.goals.update" },
    meta: { set: setKeys(next) },
  });
  return apiSuccess(next);
});
