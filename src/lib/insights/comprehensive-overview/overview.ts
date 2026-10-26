/**
 * The Insights overview read: the computed body through the analytics
 * cache. The route resolves the per-request AI state beside it, which is
 * never cached with the body.
 */
import { annotate } from "@/lib/logging/context";
import {
  cachedSwrWithMeta,
  caches,
  type ServerCache,
} from "@/lib/cache/server-cache";

import {
  buildComprehensiveResponse,
  type ComprehensiveOverviewBody,
  type OverviewRecord,
} from "./build";

export async function readComprehensiveOverview(
  user: OverviewRecord,
): Promise<{ body: ComprehensiveOverviewBody; revalidating: boolean }> {
  // Read-through the analytics cache keyed on (userId, "comprehensive"). The
  // /insights page mount routinely fans out to this endpoint alongside the
  // Coach drawer + the recommendations grid; the 60s TTL converts every
  // duplicate mount within the window to a Map lookup. Invalidation is
  // handled by `invalidateUserMeasurements`, which marks every key under the
  // `${userId}|` prefix stale (see `lib/cache/invalidate.ts`).
  //
  // Stale-while-revalidate: this is the single heaviest SQL-side aggregation
  // on the /insights mount; serving the prior body instantly while ONE
  // background recompute refreshes it keeps the page interactive across the
  // bucket's 10-minute stale window (a measurement sync used to bust the
  // entry into a blocking cold rebuild on the very next mount, all day). The
  // truly-cold first read of the day still computes inline — there is no
  // prior body to serve — but it no longer recurs per visit.
  //
  // The `revalidating` flag marks a stale-served body honestly so the client
  // can poll (bounded) until the background rebuild lands — mirroring the
  // `/api/insights/generate` GET contract. It rides on the response, never
  // inside the cached body, so a warmed entry doesn't freeze the flag.
  const { value: body, outcome } = await cachedSwrWithMeta(
    caches.analytics as ServerCache<ComprehensiveOverviewBody>,
    `${user.id}|comprehensive`,
    () => buildComprehensiveResponse(user),
    annotate,
  );

  return { body, revalidating: outcome === "stale" };
}
