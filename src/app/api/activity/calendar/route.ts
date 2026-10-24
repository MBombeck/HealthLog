/**
 * `GET /api/activity/calendar` — a week or a month of activity against the
 * person's own normal, with their weekly and monthly goals (D1036).
 *
 * Computed server-side, without AI, from the stored readings: steps (the
 * canonical-source day totals the steps chart draws), exercise minutes,
 * workouts after the cross-source collapse, and a training-load score when a
 * device or HealthLog provides one. What "usual" means is in
 * `src/lib/activity/calendar-math.ts`; it is always the person's own history,
 * never a population norm.
 *
 * Owned by the Workouts module, like the page that shows it: a switched-off
 * module answers 403 here as `/api/workouts` does.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import {
  buildActivityCalendar,
  periodBounds,
} from "@/lib/activity/calendar-math";
import { readActivityDays } from "@/lib/activity/calendar-read";
import { daysBetweenDateKeys, userDayKey } from "@/lib/tz/format";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { activityCalendarQuerySchema } from "@/lib/validations/activity-calendar";
import { parseActivityGoals } from "@/lib/validations/activity-goals";

export const dynamic = "force-dynamic";

/** How far back the calendar pages: ten years, the series route's ceiling. */
const MAX_DAYS_BACK = 3650 - 200;

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "measurements");
  annotate({ action: { name: "activity.calendar.read" } });

  const gate = await requireModuleEnabled(user.id, "workouts");
  if (!gate.enabled) return gate.response;

  const params = new URL(request.url).searchParams;
  const parsed = activityCalendarQuerySchema.safeParse({
    period: params.get("period") ?? undefined,
    date: params.get("date") ?? undefined,
  });
  if (!parsed.success) return returnAllZodIssues(parsed.error, 422);

  const tz = await resolveUserTimezone(user.id);
  const now = new Date();
  const today = userDayKey(now, tz);
  const anchor = parsed.data.date ?? today;
  if (anchor > today) {
    return apiError("The calendar cannot show a day after today", 422, {
      errorCode: "activity.calendar.future_date",
    });
  }
  if (daysBetweenDateKeys(anchor, today) > MAX_DAYS_BACK) {
    return apiError("The calendar reaches back ten years", 422, {
      errorCode: "activity.calendar.too_old",
    });
  }

  const bounds = periodBounds(parsed.data.period, anchor);
  const lastRead = bounds.gridEnd < today ? bounds.gridEnd : today;
  const [{ days, loadType }, goalRow] = await Promise.all([
    readActivityDays({
      userId: user.id,
      tz,
      fromKey: bounds.readStart,
      toKey: lastRead,
      includeWorkouts: true,
    }),
    prisma.user.findUnique({
      where: { id: user.id },
      select: { activityGoalsJson: true },
    }),
  ]);

  const calendar = buildActivityCalendar({
    bounds,
    today,
    input: days,
    goals: parseActivityGoals(goalRow?.activityGoalsJson ?? null),
  });

  annotate({
    meta: {
      activity_calendar_period: bounds.period,
      activity_calendar_days_read: days.length,
      activity_calendar_load_type: loadType ?? "none",
    },
  });
  return apiSuccess({ ...calendar, timezone: tz, loadType });
});
