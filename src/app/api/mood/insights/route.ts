import { z } from "zod/v4";

import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { cachedSwr, caches, type ServerCache } from "@/lib/cache/server-cache";
import {
  fetchMoodAggregates,
  MOOD_STABILITY_WINDOWS,
  type MoodAggregates,
  type MoodStabilityWindow,
} from "@/lib/insights/mood-aggregates";
import { requireModuleEnabled } from "@/lib/modules/gate";

export const dynamic = "force-dynamic";

/**
 * v1.8.5 — pre-computed mood-insights aggregates for the Mood Insights
 * page (heatmap, distribution, weekday pattern, tag breakdown,
 * cross-metric correlations, summary headline).
 *
 * The page stays a client component for the interactive line chart but
 * reads the heavy aggregates from here: the compute runs server-side
 * once per 60-s cache window, the browser only ever receives pre-shaped
 * data (no raw mood rows). This follows the v1.8.3 anti-freeze posture
 * — a cheap cached read, never a synchronous LLM call.
 *
 * v1.12.1 — stale-while-revalidate. On an expired or freshly-marked-
 * stale bucket (a mood write marks rather than evicts) the prior
 * aggregate is served immediately and a single background recompute
 * warms a fresh one, so an active logger never re-pays the cold compute.
 */
/**
 * `?days=N` cuts `stability` to the trailing N days, so a period picker shows
 * the steadiness of the period it shows. Without it the score covers the
 * whole year, as it always has; `stabilityWindowDays` names the window the
 * served score covers either way.
 */
const querySchema = z.object({
  days: z
    .enum(MOOD_STABILITY_WINDOWS.map(String) as [string, ...string[]])
    .transform((v) => Number(v) as MoodStabilityWindow)
    .optional(),
});

export const GET = apiHandler(async (request: Request) => {
  const { user } = await requireAuth();

  const query = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!query.success) return returnAllZodIssues(query.error, 422);
  const stabilityWindowDays: MoodStabilityWindow = query.data.days ?? 365;

  // Per-domain gate: the mood-insights aggregate surface only serves the
  // mood module's analysis page, so it must be gated on the mood module
  // (mirrors `/api/insights/mood-status`). Disabled ⇒ 403 module.disabled.
  const gate = await requireModuleEnabled(user.id, "mood");
  if (!gate.enabled) return gate.response;

  const result = await cachedSwr(
    caches.moodInsights as ServerCache<MoodAggregates>,
    user.id,
    () => fetchMoodAggregates(user.id),
    annotate,
  );

  annotate({
    action: { name: "mood.insights.read" },
    meta: {
      total_entries: result.summary.totalEntries,
      heatmap_window_days: result.heatmap.windowDays,
      tag_count: result.tags.length,
    },
  });

  // The per-window map is the cache's, not the wire's: the chosen window is
  // served as `stability`. An aggregate cached before the map existed has
  // only the year, so a shorter window reads as not yet computed (`null`)
  // until the next rebuild rather than as the year's score under a new name.
  const { stabilityByWindow, ...wire } = result;
  return apiSuccess({
    ...wire,
    stability:
      stabilityWindowDays === 365
        ? result.stability
        : (stabilityByWindow?.[stabilityWindowDays] ?? null),
    stabilityWindowDays,
  });
});
