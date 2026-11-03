/**
 * GET /api/measurements/blood-pressure/time-of-day?days=
 *
 * Blood pressure by part of the day (#1331): morning, midday and evening
 * means of the paired readings in the window, each with its count, and the
 * morning-minus-evening difference. Every figure is resolved here, in the
 * record's own time zone, so the web and the iOS app show the same numbers
 * without bucketing anything themselves. The rule is in
 * `src/lib/analytics/bp-time-of-day.ts`.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { readBpTimeOfDay } from "@/lib/measurements/series/read-bp-time-of-day";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { bpTimeOfDayQuerySchema } from "@/lib/validations/bp-time-of-day";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "measurements");

  const parsed = bpTimeOfDayQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    annotate({
      action: { name: "measurements.bp-time-of-day.validation-failed" },
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const summary = await readBpTimeOfDay({
    userId: user.id,
    days: parsed.data.days,
    timeZone: await resolveUserTimezone(user.id),
  });
  annotate({
    action: { name: "measurements.bp-time-of-day.read" },
    meta: {
      days: summary.days,
      reading_count: summary.readingCount,
      has_difference: summary.morningEveningDifference !== null,
    },
  });
  return apiSuccess(summary);
});
