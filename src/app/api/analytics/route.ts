import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { analyticsQuerySchema } from "@/lib/validations/analytics";
import { NO_STORE_BUT_BFCACHE } from "@/lib/http/cache-headers";
import { cachedSwr, caches, type ServerCache } from "@/lib/cache/server-cache";
import { readSummariesSlice } from "@/lib/analytics/summaries-slice";
import { loadRecoveryEmpty } from "@/lib/insights/recovery-empty-read";
import { resolveModuleMap } from "@/lib/modules/gate";
import { gateSummariesByModules } from "@/lib/dashboard/widget-modules";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import {
  buildAnalyticsResponse,
  type AnalyticsBody,
} from "@/lib/analytics/response/default-body";
import { enrichLastSeenDaysAgo } from "@/lib/analytics/response/last-seen";

export const dynamic = "force-dynamic";

/**
 * v1.4.33 — pull `?slice=…` from either a NextRequest (the
 * route's production wrapper) or a plain `Request` (the integration
 * tests instantiate `new Request("http://localhost/api/analytics")`
 * and cast through). Falls back to the raw `URL(request.url)` parse
 * so the slim slice branch is reachable from both call shapes.
 *
 * Returns the object the query schema parses: an absent parameter is an
 * absent KEY, not an empty string, so `slice` stays optional rather than
 * failing the enum on every unparameterised call.
 */
function readQueryParams(request: Request | undefined): Record<string, string> {
  if (!request) return {};
  try {
    return Object.fromEntries(new URL(request.url).searchParams);
  } catch {
    return {};
  }
}

export const GET = apiHandler(async (request?: Request) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "analytics.get" } });

  // A `slice` outside the closed set is refused rather than served the
  // default body. Falling through was the expensive failure: `?slice=summary`
  // ran the full 30-query chain and answered 200, so a client could sit on a
  // typo indefinitely while paying for the heaviest read on the surface.
  const parsedQuery = analyticsQuerySchema.safeParse(readQueryParams(request));
  if (!parsedQuery.success) {
    annotate({
      action: { name: "analytics.get" },
      meta: { outcome: "invalid_query" },
    });
    return returnAllZodIssues(parsedQuery.error, 422, {
      errorCode: "analytics.invalid_query",
    });
  }

  // v1.4.33 — slim summaries slice for the dashboard tile strip.
  // The default path runs 30+ chunked findMany reads to feed
  // `summarize()` per type; under `?slice=summaries` the route
  // resolves the same per-type DataSummary shape from 2 SQL passes
  // (a `groupBy` for count/min/max/mean plus a single `$queryRaw`
  // carrying the windowed averages and Postgres `regr_slope` /
  // `regr_r2` for the slope tuples). The slim slice drops the thick
  // `correlations` / `healthScore` / `bpInTargetPct` / `glucoseByContext`
  // / `sleepStages` / `bmi` blocks — those stay on the default path
  // behind a hover-prefetch from the Coach drawer + the correlation
  // tile's `<InView>` boundary. Consumers that need only the headline
  // tile values land on this branch and skip the heavy chain.
  if (parsedQuery.data.slice === "summaries") {
    // v1.4.34 — read-through the analytics cache keyed on
    // (userId, slice). The slim slice is the dashboard tile strip's hot
    // path; multiple dashboard mounts inside a 60-second TTL all hit a
    // warm cache.
    // v1.16.7 — SWR read: a sync-write marks the cell stale, and the
    // tile strip's next mount should repaint from the prior summaries
    // instantly while one background recompute refreshes them, instead
    // of paying the 2-SQL-pass rebuild inline.
    const slim = await readSummariesSlice(user.id, { serveStale: true });
    // Drop the types whose module the user turned off, from the SAME map
    // the snapshot builder gates on (`SUMMARY_TYPE_MODULE`, via
    // `gateSummariesByModules`). With `NEXT_PUBLIC_DASHBOARD_SNAPSHOT=false`
    // this slice — not the snapshot — feeds the dashboard tile strip, and
    // it used to hand back every type regardless: recovery off plus an
    // RMSSD-only account still painted the HRV tile, because nothing on
    // this path had ever filtered.
    //
    // Gated AFTER the cache read on purpose. The cached cell stays
    // module-independent, so toggling a module takes effect on the next
    // request instead of waiting out the TTL, and two users' module states
    // can never share a cached answer.
    const slimModules = await resolveModuleMap(user.id);
    const slimGated = gateSummariesByModules(
      slim.summaries,
      slim.lastSeenByType,
      slimModules,
    );
    // v1.4.34 — bfcache-friendly directive on the slim slice too
    // so a back-forward navigation that landed on the dashboard tile
    // strip can restore from memory instead of paying a full reload.
    const slimRes = apiSuccess({
      ...slim,
      summaries: slimGated.summaries,
      lastSeenByType: slimGated.lastSeenByType,
      // Resolved here, from the gated summaries and the Oura connection, so
      // a client renders the recovery page's empty note without deciding it.
      recoveryEmpty: await loadRecoveryEmpty(user.id, slimGated.summaries),
    });
    slimRes.headers.set("Cache-Control", NO_STORE_BUT_BFCACHE);
    return slimRes;
  }

  // v1.4.34 — wrap the heavy default-slice body in the analytics
  // cache keyed on (userId, "default"). The dashboard, the checklist
  // mount, and the Coach drawer all hit this endpoint within seconds
  // of each other; the 60s TTL converts the 7.99s combined dashboard
  // wait to a Map lookup on every subsequent caller.
  // v1.16.7 — SWR read, same rationale as the slim slice above: the
  // thick body is the 30-query chain feeding the dashboard + insights
  // hero score; after a measurement sync the next mount serves the
  // prior body instantly while one background recompute refreshes it.
  // v1.30.10 — the `correlations` block carries user-facing narration that is
  // localised per reader, so the cache key MUST include the locale; otherwise a
  // language switch would serve another locale's cached interpretation for up to
  // the TTL. Every other block is locale-independent, so per-locale entries only
  // cost a little duplication (most users have one locale).
  const locale = await resolveServerLocale({ userLocale: user.locale ?? null });
  const cachedBody = await cachedSwr(
    caches.analytics as ServerCache<AnalyticsBody>,
    `${user.id}|default|${locale}`,
    () => buildAnalyticsResponse(user, locale),
    annotate,
  );

  // v1.4.38 — `lastSeenByType` lives inside the cached envelope as
  // `{ lastSeenAt }` only; derive the `daysAgo` caption per call so
  // the staleness label updates correctly across day boundaries.
  // The cache TTL is 60s, but the day boundary it can straddle would
  // otherwise leave the cached `daysAgo` off by one until the next
  // refresh. Re-deriving on read is a single Date subtraction per
  // type and stays on the hot path's Map-lookup side of the cache.
  const body = enrichLastSeenDaysAgo(cachedBody);

  const response = apiSuccess(body);
  // v1.4.34 — bfcache-friendly directive so back-forward navigation
  // restores the dashboard from memory. Per `src/lib/http/cache-headers.ts`:
  // `private` keeps shared caches out of personal data, `max-age=0` forces
  // revalidation on every navigation so session swaps detect on the wire,
  // and `must-revalidate` holds the staleness contract. Replaces the
  // framework's stock `no-store` which Chromium treats as a hard
  // bfcache breaker.
  response.headers.set("Cache-Control", NO_STORE_BUT_BFCACHE);
  return response;
});
