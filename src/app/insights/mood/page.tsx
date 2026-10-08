import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query";

import { getUnswitchedSession } from "@/lib/auth/acting-carrier";
import { buildMoodDailySeries } from "@/lib/analytics/mood-series";
import {
  cached,
  cachedSwr,
  caches,
  type ServerCache,
} from "@/lib/cache/server-cache";
import {
  fetchMoodAggregates,
  moodInsightsWire,
  type MoodAggregates,
} from "@/lib/insights/mood-aggregates";
import type { MoodDailySeries } from "@/lib/analytics/mood-series";
import { resolveModuleMap } from "@/lib/modules/gate";
import { queryKeys } from "@/lib/query-keys";

import InsightsMoodPageClient from "./page-client";

/**
 * How long the first HTML waits for the two reads. Both are cached per user
 * (the aggregate stale-while-revalidate), so a warm visit answers in a few
 * milliseconds; a cold aggregate can take longer than a reader should wait
 * for a blank page, and then the client's own fetch takes over.
 */
const PREFETCH_BUDGET_MS = 1_500;

function withinBudget<T>(work: Promise<T>): Promise<T | null> {
  return Promise.race([
    work,
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), PREFETCH_BUDGET_MS),
    ),
  ]).catch(() => null);
}

/**
 * Thin RSC wrapper around the (client) mood insights page.
 *
 * The page's first paint is the mood calendar over the line chart. Both read
 * their own endpoint after hydrate, and the calendar's aggregate is the
 * slower of the two, so the chart used to paint first and the calendar pushed
 * it down when it landed. This wrapper runs the SAME two reads the routes run
 * (`moodInsightsWire` over the cached aggregate, `buildMoodDailySeries` over
 * its cache) in parallel during SSR and hands both to TanStack, so the two
 * appear together in the first client frame. The client page still gates the
 * pair on each other, which is what keeps them together when this wrapper
 * steps aside.
 *
 * Contract notes (the `/mood` wrapper's, unchanged):
 *  - the seeded keys are exactly the client's (`moodInsights()`,
 *    `moodAnalytics()`), and each value is JSON-round-tripped into the wire
 *    shape the client `queryFn` reads — never a Date-carrying sibling;
 *  - module-gate parity: nothing is prefetched when `modules.mood` is off;
 *  - record identity: `getUnswitchedSession()` answers null while the browser
 *    acts on somebody else's record, so a delegate's own mood never seeds a
 *    page opened on the owner's record;
 *  - fail-soft and time-boxed: no session, a lookup hiccup or a slow cold
 *    aggregate renders the page exactly as the client path would.
 */
export default async function InsightsMoodPage() {
  // The e2e server turns every SSR prefetch off so its route mocks, which
  // only see CLIENT fetches, keep governing what the page paints.
  if (process.env.DASHBOARD_SSR_PREFETCH === "false") {
    return <InsightsMoodPageClient />;
  }

  let dehydratedState = null;
  try {
    const session = await getUnswitchedSession();
    if (session) {
      const { user } = session;
      const modules = await resolveModuleMap(user.id);
      if (modules.mood !== false) {
        const [aggregates, series] = await Promise.all([
          withinBudget(
            cachedSwr(
              caches.moodInsights as ServerCache<MoodAggregates>,
              user.id,
              () => fetchMoodAggregates(user.id),
            ),
          ),
          withinBudget(
            cached(
              caches.moodAnalytics as ServerCache<MoodDailySeries>,
              user.id,
              () => buildMoodDailySeries(user.id),
            ),
          ),
        ]);
        const queryClient = new QueryClient();
        if (aggregates) {
          queryClient.setQueryData(
            queryKeys.moodInsights(),
            JSON.parse(JSON.stringify(moodInsightsWire(aggregates, 365))),
          );
        }
        if (series) {
          queryClient.setQueryData(
            queryKeys.moodAnalytics(),
            JSON.parse(
              JSON.stringify({
                entries: series.entries,
                summary: series.summary,
              }),
            ),
          );
        }
        if (aggregates || series) dehydratedState = dehydrate(queryClient);
      }
    }
  } catch {
    // Prefetch is an accelerator, never a gate — the client path stands.
  }

  if (dehydratedState === null) {
    return <InsightsMoodPageClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <InsightsMoodPageClient />
    </HydrationBoundary>
  );
}
