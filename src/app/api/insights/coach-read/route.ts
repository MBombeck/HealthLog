/**
 * v1.21.2 (A1) — "Coach read" strip route.
 *
 * `GET /api/insights/coach-read?metric=<MeasurementType>` serves the two
 * server-authoritative lines a metric sub-page renders above its chart: the
 * own-baseline placement (median ± k·MAD, today's reading within / above /
 * below) and the single strongest lagged association whose outcome is the
 * metric. Pure compute over the baseline + correlation engines — no provider
 * call, no cache table — so web and iOS decode the SAME resolved DTO.
 *
 * Mirrors the `/api/insights/derived` precedent: `apiHandler` wrapper, Zod
 * `safeParse` on the query (unknown `metric` → 422 via `returnAllZodIssues`),
 * cookie OR Bearer auth, `userId` narrowed from the session (never a query
 * field), and the shared analytics-read budget. No AI gate and no module
 * gate: both lines are computed, and the `insights` module is the AI analysis
 * opt-out.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiError, apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import { buildCoachReadStrip } from "@/lib/insights/derived/coach-read";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { resolveStoredTimezone } from "@/lib/tz/resolver";
import type { MeasurementType } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

const coachReadQuerySchema = z.object({
  metric: measurementTypeEnum,
});

export const GET = apiHandler(async (request: NextRequest) => {
  // v1.37.0 — MANAGE-level read: computed over the whole record, with no
  // provider anywhere on the path.
  const { user } = await requireRecordAuth("manage", "record");

  // Pure compute over the baseline and correlation engines. The name is
  // historical: no model writes either line, so neither the Coach switch nor
  // the AI analysis opt-out refuses it.

  // Shared analytics-read budget — generous; caps a runaway navigation loop.
  const rl = await checkAnalyticsReadRateLimit(user.id);
  if (!rl.allowed) {
    return apiError("Too many analytics requests. Please retry later.", 429);
  }

  const parsed = coachReadQuerySchema.safeParse({
    metric: request.nextUrl.searchParams.get("metric"),
  });
  if (!parsed.success) {
    annotate({
      action: { name: "insights.coach-read.invalid-metric" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422);
  }
  const metric = parsed.data.metric as MeasurementType;

  // Line 2 of the strip is a finished sentence the clients print verbatim, so
  // the reader's language is decided here — same resolution the correlations
  // and analytics routes use (cookie, then the stored preference, then the
  // Accept-Language header). Without it the strip answered a German page in
  // English, one line under the other.
  const locale = await resolveServerLocale({ userLocale: user.locale ?? null });

  // The reader's zone decides which day is "today": a glucose day still in
  // progress is placed against the same hours of the earlier days.
  const strip = await buildCoachReadStrip(user.id, metric, locale, {
    tz: await resolveStoredTimezone(user.timezone),
  });

  annotate({
    action: { name: "insights.coach-read" },
    meta: {
      metric,
      locale,
      has_baseline: strip.baseline !== null,
      learning: strip.learning,
      has_driver: strip.driver !== null,
    },
  });

  return apiSuccess(strip);
});
