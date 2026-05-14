import { NextRequest } from "next/server";
import { apiSuccess } from "@/lib/api-response";
import {
  generateGeneralStatusForUser,
  resolveGeneralStatusLocale,
} from "@/lib/insights/general-status";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { resolveServerLocale } from "@/lib/i18n/server-locale";

export const dynamic = "force-dynamic";

/**
 * @deprecated since v1.4.25 — the `/insights` page no longer mounts the
 *   `<InsightStatusCard>` that drove this endpoint; the polished
 *   `<InsightAdvisorCard>` block above the per-metric sections covers
 *   the same surface with severity-ordered recommendations + rationale.
 *
 *   The route + underlying `generateGeneralStatusForUser` lib remain
 *   live because the reminder worker (`src/lib/jobs/reminder-worker.ts`)
 *   still pre-warms the daily general-status cache for users opted in to
 *   the briefing notification. Removing the route would break the
 *   warm-cache job's HTTP-style coverage tests; removing the lib would
 *   break the worker. Both stay; this comment is for new callers.
 *
 *   New surfaces should consume `<InsightAdvisorCard>` via
 *   `useInsightsAdvisorQuery()` (`@/components/insights/use-insights-advisor`)
 *   instead of fetching this endpoint directly.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const localeParam = request.nextUrl.searchParams.get("locale");
  const resolved = await resolveServerLocale({
    request,
    userLocale: user.locale ?? null,
    override: localeParam,
  });
  const locale = resolveGeneralStatusLocale(resolved);

  const result = await generateGeneralStatusForUser(user.id, {
    locale,
    force: false,
  });

  annotate({ action: { name: "insights.general-status" } });

  return apiSuccess(result);
});
