"use client";

/**
 * v1.7.0 — unified dashboard first-paint snapshot hook.
 *
 * One client cell against `GET /api/dashboard/snapshot` that hydrates
 * every above-the-fold tile, replacing the legacy four-cell waterfall
 * (slim analytics + thick analytics + mood + widget layout). Three
 * properties matter:
 *
 *   - It is NOT gated on `isAuthenticated`. The server `requireAuth()`
 *     is the real gate (401 on a missing cookie); on the dashboard
 *     route the cookie is always present because `src/proxy.ts` has
 *     already passed the auth / onboarding redirect. Firing un-gated
 *     removes the `/api/auth/me` round-trip from the cold critical path
 *     (R-firstpaint §1a — the single biggest first-byte win).
 *   - `staleTime: 60_000` + `refetchOnMount: false` keep a
 *     return-to-dashboard within a minute a free cache hit.
 *   - `refetchOnWindowFocus: "always"` (v1.31.0) closes the background-sync
 *     freshness gap and keeps the tile snapshot aligned with the Today digest.
 *     Arrival markers are written out-of-band, so neither query has a client
 *     mutation that could invalidate it; both therefore refetch on every real
 *     focus transition, even inside the one-minute freshness window.
 *   - `refetchInterval: 120_000` + `refetchIntervalInBackground: false`
 *     keep an open dashboard live: an idle tab polls the snapshot every
 *     two minutes so freshly-synced Withings / HealthKit readings appear
 *     without a manual reload. The poll hits the warm ~180 s server cache
 *     cheaply and only triggers a sub-second rollup rebuild when the
 *     underlying data actually changed — never the LLM surfaces, which
 *     stay daily / pre-generated. The interval pauses while the tab is
 *     backgrounded.
 *   - The queryKey is the centralised factory entry
 *     `queryKeys.dashboardSnapshot()`.
 */
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { getRecordScope } from "@/lib/query-keys/record-scope";
import { DASHBOARD_REFETCH_INTERVAL_MS } from "@/lib/queries/refetch-interval";
import { retryOnceOnTransientError } from "@/lib/queries/retry-transient";
import type { DashboardSnapshot } from "@/lib/dashboard/snapshot";

async function fetchDashboardSnapshot(
  signal?: AbortSignal,
): Promise<DashboardSnapshot> {
  // Routed through the typed wrapper so a failure carries its HTTP
  // status (`ApiError`) for the transient-retry predicate, and the
  // default 15 s timeout keeps a stalled response from pinning the
  // whole dashboard on its skeleton.
  return apiGet<DashboardSnapshot>("/api/dashboard/snapshot", { signal });
}

/** Handoff freshness window — mirrors the hook's `staleTime`. */
const PRELOAD_MAX_AGE_MS = 60_000;

/**
 * Module-level promise handoff between the preloader and the mounted
 * hook. Deliberately OUTSIDE the query cache: writing the response into
 * the cache before the dashboard page hydrates (what `prefetchQuery`
 * did) makes the page's first client render paint tiles where the
 * server HTML painted the skeleton — a React #418 hydration mismatch
 * whenever the response beats the page chunk (fast LAN, e2e route
 * mocks). The handoff keeps the request in flight while hydration runs
 * and lets the mounted cell commit the data itself, post-hydration.
 */
let preloadedSnapshot: {
  promise: Promise<DashboardSnapshot>;
  startedAt: number;
  recordScope: string | null;
} | null = null;

export function _resetDashboardSnapshotPreloadForTests(): void {
  preloadedSnapshot = null;
}

/** Drop a handoff when a tab begins or receives a record-session switch. */
export function discardDashboardSnapshotPreload(): void {
  preloadedSnapshot = null;
}

/**
 * Kick the snapshot fetch off ahead of the dashboard page chunk.
 *
 * v1.16.6 first-load waterfall fix: under a realistic RTT the
 * `useDashboardSnapshot` cell only fires once the dashboard page chunk
 * has downloaded, parsed, and mounted — measured at ~450 ms after the
 * navigation commits (4G / 4x-CPU profile). The route-level preloader in
 * `providers.tsx` and the login submit handler call this the moment the
 * destination is known, so the request rides in parallel with the chunk
 * download instead of behind it. The response parks in the module-level
 * handoff (NOT the query cache — see above) until the mounted cell's
 * `queryFn` consumes it; preload errors are swallowed by design — the
 * mounted cell owns error surfacing with its own fresh attempt.
 */
export function prefetchDashboardSnapshot(
  queryClient: QueryClient,
  signal?: AbortSignal,
) {
  // Expired handoff from a previous visit — drop it so a long-idle slot
  // can never serve stale data.
  if (
    preloadedSnapshot &&
    Date.now() - preloadedSnapshot.startedAt >= PRELOAD_MAX_AGE_MS
  ) {
    preloadedSnapshot = null;
  }
  // A fresh handoff is already in flight / parked.
  if (preloadedSnapshot) return;
  // The handoff exists to cut the COLD first-load waterfall, so it is only
  // ever warranted when no snapshot cell has produced data yet. Once a cell
  // carries data the page paints from it immediately and there is no waterfall
  // left to cut — but the parked response would still sit in the slot, because
  // `refetchOnMount: false` means a remount never calls `queryFn` to consume
  // it. The next `queryFn` run is then whatever comes along: the 120 s poll, a
  // focus refetch, or the invalidation that follows the user's own write. All
  // three exist to fetch data that is NEWER than what the cell holds, and all
  // three would instead be handed a response whose request was issued BEFORE
  // the write. That is how a just-recorded dose kept reading as still due
  // until the following poll cleared it.
  //
  // v1.21.3 (b) — the live cell is locale-keyed (`["dashboard","snapshot",
  // locale]`), but the preloader runs before the locale context is in scope.
  // Probe ALL `["dashboard","snapshot"]` cells (prefix): if ANY locale's cell
  // has data, skip the preload; otherwise warm the request through the handoff
  // and let the mounted cell commit it under whichever locale the user lands
  // on. A cell that exists but never resolved (an error slot) reports
  // `dataUpdatedAt === 0` and correctly still warms.
  const states = queryClient
    .getQueriesData({ queryKey: queryKeys.dashboardSnapshot() })
    .map(([key]) => queryClient.getQueryState(key));
  const freshest = states.reduce<number>(
    (max, s) => (s ? Math.max(max, s.dataUpdatedAt) : max),
    0,
  );
  if (freshest > 0) {
    return;
  }
  const recordScope = getRecordScope();
  const promise = fetchDashboardSnapshot(signal);
  promise.catch(() => {
    // Swallow + clear so an unconsumed failed preload (racing 401 on
    // login, transient network) never becomes an unhandled rejection and
    // never gets handed to a later mount.
    if (preloadedSnapshot?.promise === promise) preloadedSnapshot = null;
  });
  preloadedSnapshot = { promise, startedAt: Date.now(), recordScope };
}

/** Single-use consume of the preload handoff; `null` when absent/expired. */
function takePreloadedSnapshot(): Promise<DashboardSnapshot> | null {
  if (!preloadedSnapshot) return null;
  const { promise, startedAt, recordScope } = preloadedSnapshot;
  preloadedSnapshot = null;
  // A handoff is not query-cached, so it needs the same record boundary as a
  // query cache entry. A scope move while it is in flight must make the next
  // mounted dashboard fetch afresh instead of adopting a response from the
  // record that just ended.
  return Date.now() - startedAt < PRELOAD_MAX_AGE_MS &&
    recordScope === getRecordScope()
    ? promise
    : null;
}

function makeSnapshotQueryFn(queryClient: QueryClient) {
  return async () => {
    const preloaded = takePreloadedSnapshot();
    let snap: DashboardSnapshot;
    if (preloaded) {
      try {
        snap = await preloaded;
      } catch {
        // Preload failed — this cell still owns a fresh attempt so a
        // transient prefetch error never surfaces as the query error.
        snap = await fetchDashboardSnapshot();
      }
    } else {
      snap = await fetchDashboardSnapshot();
    }
    // Cold-start de-waterfall: the snapshot already carries the
    // resolved widget layout, and the per-chart overlay-prefs hook
    // (`use-chart-overlay-prefs.ts`) fetches the SAME payload from
    // `/api/dashboard/widgets` under `queryKeys.dashboardWidgets()`
    // before the chart cells issue their measurement queries. Seeding
    // that cache here removes one full request stage from the
    // dashboard waterfall (snapshot → widgets → measurements becomes
    // snapshot → measurements). Seed ONLY when the slot is empty so a
    // later interval refetch never clobbers an optimistic overlay /
    // compare-toggle mutation that wrote the key in the meantime.
    if (!queryClient.getQueryData(queryKeys.dashboardWidgets())) {
      queryClient.setQueryData(queryKeys.dashboardWidgets(), snap.layout);
    }
    return snap;
  };
}

export function useDashboardSnapshot(enabled = true) {
  const queryClient = useQueryClient();
  // v1.21.3 (b) — key the live snapshot cell by the active locale so a locale
  // switch reads the freshly-localised prose on its own cache cell rather than
  // serving the prior locale's tile copy / narrative until the 60 s staleTime
  // elapses. The module-level preloader stays locale-agnostic: it warms the
  // request through the promise handoff (NOT the query cache), and the mounted
  // cell commits it under the locale key here, so the preload still rides in
  // parallel with the page chunk and warms exactly the locale the user lands
  // on. Every zero-arg `dashboardSnapshot()` invalidation still prefix-matches
  // this locale-keyed cell, so cache eviction is unchanged.
  const { locale } = useTranslations();
  return useQuery({
    queryKey: queryKeys.dashboardSnapshot(locale),
    queryFn: makeSnapshotQueryFn(queryClient),
    enabled,
    staleTime: 60_000,
    // A remount of a cell that holds live data reads it as it is, but a cell
    // restored from the offline copy (`restorePersistedQueryCache`) arrives
    // invalidated and must fetch on its first mount. Plain `false` kept the
    // restored copy on screen: a page reloaded right after a write, before
    // the persister had flushed the newer snapshot, painted the pre-write
    // dashboard until the two-minute poll.
    refetchOnMount: (query) => query.state.isInvalidated,
    // Keep the snapshot and Today digest in lockstep after a background sync.
    // Both are out-of-band reads, so staleTime cannot signal that a worker
    // landed a new arrival while the browser was hidden.
    refetchOnWindowFocus: "always",
    refetchInterval: DASHBOARD_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    // v1.16.8 — one retry on network errors / 5xx (never 401/403). A
    // single transient failure used to flash the full-dashboard empty
    // state under the former `retry: false`.
    retry: retryOnceOnTransientError,
  });
}
