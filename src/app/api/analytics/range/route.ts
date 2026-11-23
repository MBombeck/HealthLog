/**
 * v1.9.0 — single-metric period-over-period range read.
 *
 * `GET /api/analytics/range?type=<MeasurementType>&range=7d|30d|90d|1y`
 * returns the current-window aggregate, the previous comparable window, and
 * the composed delta. Single metric type by construction — the Insights
 * metric page is single-metric — so the read is one
 * `readBestGranularityRollups` covering the trailing `2N` days, sliced into
 * the two halves. No per-type fan-out, no Prisma-pool burst (the opposite of
 * the deleted 15-way live walk).
 *
 * The cached `/api/analytics?slice=summaries` slice is deliberately left
 * untouched: adding a range dimension to its single shared cache key would
 * fragment the hottest cache on the dashboard. This dedicated route carries
 * its own per-(type, range) cache slot on the client (`queryKeys.analyticsRange`).
 *
 * iOS-safe: additive new route, no change to the `/api/analytics` envelope.
 * Every number is in the account's display unit, named by `unit`
 * (`src/lib/analytics/range-display.ts`).
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import {
  ANALYTICS_RANGES,
  computeRangeDelta,
  type AnalyticsRange,
} from "@/lib/analytics/range-delta";
import type { MeasurementType } from "@/generated/prisma/client";
import { rangeDeltaInUnit } from "@/lib/analytics/range-display";
import { prisma } from "@/lib/db";
import { resolveUnitPreferences } from "@/lib/measurements/display-transform";

export const dynamic = "force-dynamic";

const rangeQuerySchema = z.object({
  type: measurementTypeEnum,
  range: z.enum(ANALYTICS_RANGES),
});

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  // v1.15.20 — shared analytics-read budget (generous; caps runaway loops).
  const rl = await checkAnalyticsReadRateLimit(user.id);
  if (!rl.allowed) {
    return apiError("Too many analytics requests. Please retry later.", 429);
  }

  const parsed = rangeQuerySchema.safeParse({
    type: request.nextUrl.searchParams.get("type"),
    range: request.nextUrl.searchParams.get("range"),
  });
  if (!parsed.success) {
    annotate({
      action: { name: "analytics.range.invalid-params" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const type = parsed.data.type as MeasurementType;
  const range = parsed.data.range as AnalyticsRange;

  const [stored, prefs] = await Promise.all([
    computeRangeDelta(user.id, type, range),
    prisma.user.findUnique({
      where: { id: user.id },
      select: { unitPreference: true, glucoseUnit: true },
    }),
  ]);
  // The answer is in the account's unit, and says which: glucose follows
  // the glucose unit, the metric/imperial types the unit system.
  const result = rangeDeltaInUnit(
    stored,
    type,
    resolveUnitPreferences(prefs ?? {}),
  );

  annotate({
    action: { name: "analytics.range.read" },
    meta: {
      type,
      range,
      granularity: result.granularity,
      current_count: result.current.count,
      previous_count: result.previous.count,
      unit: result.unit,
    },
  });

  return apiSuccess(result);
});
