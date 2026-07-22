import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query";

import { getSession } from "@/lib/auth/session";
import { readWorkoutsListCached } from "@/lib/workouts/list-read";
import { resolveModuleMap } from "@/lib/modules/gate";
import { queryKeys } from "@/lib/query-keys";

import InsightsWorkoutsPageClient from "./page-client";

/**
 * Thin RSC wrapper around the (client) workouts list page.
 *
 * `/insights/workouts` is the workouts surface. Its above-the-fold content —
 * the workout rows — waited for the client `useInfiniteWorkouts({ limit: 100 })`
 * to fetch `/api/workouts?limit=100` after hydrate, so the first paint flashed
 * the loading skeleton before the list filled in. This wrapper runs the SAME
 * cached read the API route uses (`readWorkoutsListCached`, the shared
 * `caches.workouts` projection cell) during SSR and hands it to TanStack
 * through `HydrationBoundary`, so the mounted list cell starts warm instead of
 * skeleton-first.
 *
 * Contract notes (the v1.30.9 dashboard / v1.30.13 medications template):
 *  - The query key comes ONLY from the central factory. The client infinite
 *    cell keys on `queryKeys.workoutsRecentList({ limit: 100, offset:
 *    undefined, since, sportType })`; offsets are page parameters, never cache
 *    key segments, so this seeded key equals the client's by construction.
 *  - The projection filter matches the route's too: all-null filter params hash
 *    to the same `userId|||` projection cache slot a `?limit=100` request
 *    builds, so the prefetch and the API path share one dedup pass.
 *  - The dehydrated first page is JSON-round-tripped and wrapped in TanStack's
 *    `{ pages, pageParams }` infinite-data shape. Prisma `Date`s therefore
 *    hydrate as the same ISO strings produced by the client wire response.
 *  - Module-gate parity: the client page bounces a workouts-off account
 *    (`useModulePageGuard`), and the API route refuses it server-side; skip the
 *    prefetch when the module is off so a disabled page never seeds a cache it
 *    will not read.
 *  - The client cell keeps its own fetch (`staleTime: 60s`): the prefetch seeds
 *    fresh data, so the mounted cell paints immediately and only refetches once
 *    the TTL lapses — the "empty then fills" flash is gone without dropping the
 *    freshness path.
 *  - Fail-soft: no session, a module lookup hiccup, or a DB blip renders the
 *    page exactly as before this wrapper existed — the client cell owns the
 *    fetch. The prefetch is an accelerator, never a gate.
 */
export default async function InsightsWorkoutsPage() {
  // Global SSR-prefetch kill-switch shared with the dashboard wrapper. The e2e
  // server sets `DASHBOARD_SSR_PREFETCH=false` so Playwright route mocks —
  // which only see CLIENT fetches — keep governing what every prefetched page
  // paints.
  if (process.env.DASHBOARD_SSR_PREFETCH === "false") {
    return <InsightsWorkoutsPageClient />;
  }

  let dehydratedState = null;
  try {
    const session = await getSession();
    if (session) {
      const { user } = session;
      const modules = await resolveModuleMap(user.id);
      // Mirror the client guard (`user?.modules?.workouts !== false`): an
      // absent key reads as enabled; only an explicit `false` disables.
      if (modules.workouts !== false) {
        const list = await readWorkoutsListCached(user.id, {
          limit: 100,
          offset: 0,
          since: null,
          until: null,
          sportType: null,
        });
        const queryClient = new QueryClient();
        // Match the client cell's key + wire shape exactly (JSON semantics, ISO
        // date strings) — same-key-different-shape is silent cache poison.
        const firstPage = JSON.parse(JSON.stringify(list));
        queryClient.setQueryData(
          queryKeys.workoutsRecentList({
            limit: 100,
            offset: undefined,
            since: undefined,
            sportType: undefined,
          }),
          { pages: [firstPage], pageParams: [0] },
        );
        dehydratedState = dehydrate(queryClient);
      }
    }
  } catch {
    // Prefetch is an accelerator, never a gate — the client path stands.
  }

  if (dehydratedState === null) {
    return <InsightsWorkoutsPageClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <InsightsWorkoutsPageClient />
    </HydrationBoundary>
  );
}
