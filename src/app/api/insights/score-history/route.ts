/**
 * `GET /api/insights/score-history?score=<id>&days=<n>` — one score's daily
 * course over the trailing `days`, for the history chart on its page.
 *
 * Serves the three scores that have no stored measurement series of their
 * own to chart: the health score (its `HealthScoreRecord` rows), readiness
 * (the nightly blend the recovery job persists) and the sleep score
 * (computed per night). The nightly recovery, stress and strain scores are
 * stored readings and chart through the measurement series route like any
 * other metric. What each point means, and why the health score's line can
 * break, is written at `readScoreHistory`.
 *
 * `days` is the chart's range tab: 7, 30, 90, or the "All" tab's ten years.
 * Any whole number in between is accepted, so a client is not tied to these
 * tabs; out of range is a 422, never a silent clamp.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiError, apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";
import { loadBaselineProfile } from "@/lib/insights/derived";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { resolveStoredTimezone } from "@/lib/tz/resolver";
import { readScoreHistory } from "@/lib/insights/score-history";
import {
  SCORE_HISTORY_IDS,
  SCORE_HISTORY_MAX_DAYS,
} from "@/lib/insights/score-history-ids";
import { DERIVED_MODULE } from "../derived/route";

export const dynamic = "force-dynamic";

const scoreHistoryQuerySchema = z.object({
  score: z.enum(SCORE_HISTORY_IDS),
  days: z.coerce.number().int().min(1).max(SCORE_HISTORY_MAX_DAYS),
});

export const GET = apiHandler(async (request: NextRequest) => {
  // The same standing as the score itself: the derived scores and the other
  // insight reads are a MANAGE-level read over the whole record.
  const { user } = await requireRecordAuth("manage", "record");

  const rl = await checkAnalyticsReadRateLimit(user.id);
  if (!rl.allowed) {
    return apiError("Too many analytics requests. Please retry later.", 429);
  }

  const parsed = scoreHistoryQuerySchema.safeParse({
    score: request.nextUrl.searchParams.get("score"),
    days: request.nextUrl.searchParams.get("days"),
  });
  if (!parsed.success) {
    annotate({
      action: { name: "insights.score-history.invalid-query" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422);
  }
  const { score, days } = parsed.data;

  // Readiness is the recovery module's, the sleep score the sleep module's,
  // through the same map the derived routes gate on. The health score is
  // core and carries no gate.
  const moduleKey =
    score === "HEALTH_SCORE" ? undefined : DERIVED_MODULE[score];
  if (moduleKey) {
    const gate = await requireModuleEnabled(user.id, moduleKey);
    if (!gate.enabled) return gate.response;
  }

  const history = await readScoreHistory({
    userId: user.id,
    score,
    days,
    now: new Date(),
    tz: await resolveStoredTimezone(user.timezone),
    profile: () => loadBaselineProfile(prisma, user.id),
    priorityJson: () => loadUserSourcePriority(user.id),
  });

  annotate({
    action: { name: "insights.score-history" },
    meta: {
      score,
      days,
      points: history.points.length,
      seams: history.points.filter((p) => p.seamBreak).length,
      has_band: history.band !== null,
    },
  });

  return apiSuccess(history);
});
