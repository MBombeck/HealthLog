/**
 * `POST /api/environment/backfill` — fetch + store past days on demand.
 *
 * Enqueues a per-user fetch over the requested [startDate, endDate] so the user
 * can populate history rather than waiting for the rolling nightly lookback.
 * The span is capped (the worker re-checks the cap too). Requires a home
 * location (otherwise there is nothing to resolve). Module-gated + rate-limited;
 * `userId` is narrowed from auth.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { environmentBackfillSchema } from "@/lib/validations/environment";
import {
  ENVIRONMENT_MAX_BACKFILL_DAYS,
  defaultBackfillRange,
  utcDayKey,
} from "@/lib/environment/service";
import { enqueueEnvironmentFetch } from "@/lib/jobs/environment-fetch";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const gate = await requireModuleEnabled(user.id, "environment");
  if (!gate.enabled) return gate.response;

  const rl = await checkAnalyticsReadRateLimit(user.id);
  if (!rl.allowed) {
    return apiError("Too many requests. Please retry shortly.", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 4 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = environmentBackfillSchema.safeParse(rawBody);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "environment.invalid",
    });
  }

  const profile = await prisma.user.findUnique({
    where: { id: user.id },
    select: { homeLat: true, homeLocationEncrypted: true, homeSince: true },
  });
  // The sealed home (v1.42), or the readable one the encryption backfill has
  // not cleared yet.
  if (profile?.homeLocationEncrypted == null && profile?.homeLat == null) {
    return apiError("Set a home location before backfilling.", 409, {
      errorCode: "environment.no_home",
    });
  }

  // Resolve the effective span. An omitted bound defaults to the conservative
  // [homeSince .. today] range — never a fixed reach into the past onto the
  // current home. Days before homeSince still resolve to SKIP in the worker, so
  // even an explicit wider start cannot fabricate weather for the pre-home past.
  const today = utcDayKey(new Date());
  const fallback = defaultBackfillRange(profile.homeSince) ?? {
    startDate: today,
    endDate: today,
  };
  const startDate = parsed.data.startDate ?? fallback.startDate;
  const endDate = parsed.data.endDate ?? fallback.endDate;
  if (startDate > endDate) {
    return apiError("startDate must be on or before endDate", 422, {
      errorCode: "environment.invalid",
    });
  }

  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  const spanDays =
    Math.round(
      (Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / MS_PER_DAY,
    ) + 1;
  if (spanDays > ENVIRONMENT_MAX_BACKFILL_DAYS) {
    return apiError(
      `Backfill range too large (max ${ENVIRONMENT_MAX_BACKFILL_DAYS} days)`,
      422,
      { errorCode: "environment.range_too_large" },
    );
  }

  const enqueued = await enqueueEnvironmentFetch({
    userId: user.id,
    startDate,
    endDate,
  });

  annotate({
    action: { name: "environment.backfill.enqueue" },
    meta: { span_days: spanDays, enqueued },
  });

  return apiSuccess({ enqueued, startDate, endDate, spanDays }, 202);
});
