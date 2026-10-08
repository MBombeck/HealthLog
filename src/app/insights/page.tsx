import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query";

import { redirect } from "next/navigation";

import { getUnswitchedSession } from "@/lib/auth/acting-carrier";
import { insightsHrefForMetric } from "@/lib/insights/metric-deep-link";
import { readDashboardSnapshotCached } from "@/lib/dashboard/snapshot-read";
import { queryKeys } from "@/lib/query-keys";

import InsightsPageClient from "./page-client";

/**
 * Thin RSC wrapper around the (client) Insights overview page.
 *
 * The Insights root fans out into ~6 mount queries after hydrate; the highest-
 * value, cheapest, and safest to lift onto the server is the dashboard snapshot
 * — the SAME `queryKeys.dashboardSnapshot(locale)` cell the dashboard warms
 * (the hero's Tension Verdict + return-to-baseline ride it). Reading it through
 * the shared `caches.analytics` SWR cell during SSR and handing it to TanStack
 * via `HydrationBoundary` means an Insights visit no longer re-pays the snapshot
 * round-trip on the client, and the hero's snapshot-derived band paints from the
 * first HTML instead of after a client fetch.
 *
 * Contract notes (the v1.30.9 dashboard template):
 *  - THE CRUX — the snapshot cell is locale-keyed
 *    (`queryKeys.dashboardSnapshot(locale)`). The locale is resolved ONCE
 *    server-side by `readDashboardSnapshotCached` (via `resolveServerLocale`)
 *    and the client's `useDashboardSnapshot` keys on the SAME resolved locale
 *    from the i18n context — the identical mechanism the dashboard already
 *    relies on, so the server-seeded key equals the client key by construction.
 *  - The dehydrated VALUE is JSON-round-tripped so the hydrated shape is exactly
 *    what the client `queryFn` produces from the wire (ISO date strings), never
 *    a Date-carrying sibling that poisons the cell.
 *  - The client snapshot cell reads `refetchOnMount: false`, so the seeded
 *    fresh value lands and is used without an immediate refetch.
 *  - The `["user","dashboardWidgets"]` layout the snapshot carries is seeded too
 *    (mirroring the client `queryFn`'s own seed), removing the widgets stage
 *    from the chart-overlay-prefs waterfall exactly as on the dashboard.
 *  - Left CLIENT-LAZY on purpose: the AI daily briefing (`GET /api/insights/
 *    generate`) — prefetching it must never trigger provider generation
 *    (generation stays cron + explicit-button only), so it keeps its own lazy
 *    read; and the heavy thick-analytics / comprehensive aggregations, whose
 *    COLD SWR cell is a multi-query scan — prefetching them synchronously would
 *    trade FCP for TTFB. Both stay on the client cells that own them.
 *  - Record identity: the session comes from `getUnswitchedSession()`, which
 *    answers null while the browser is acting on somebody else's record. Every
 *    read below scopes to the CALLER, so under a switch the prefetch would
 *    serialise the delegate's own rows into a page opened on the owner's
 *    record. The accessor's docblock carries the argument.
 *  - Fail-soft: no session or a builder hiccup renders the page exactly as
 *    before this wrapper existed — the client cells own the fetch.
 */
export default async function InsightsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  // MCP deep links (`/insights?metric=<id>`) go to the metric's own page. An
  // id that names no metric leaves the overview as it was.
  const { metric } = (await searchParams) ?? {};
  const target = insightsHrefForMetric(
    typeof metric === "string" ? metric : null,
  );
  if (target) redirect(target);

  // Global SSR-prefetch kill-switch shared with the dashboard wrapper. The e2e
  // server sets `DASHBOARD_SSR_PREFETCH=false` so Playwright route mocks — which
  // only see CLIENT fetches — keep governing what every prefetched page paints.
  if (process.env.DASHBOARD_SSR_PREFETCH === "false") {
    return <InsightsPageClient />;
  }

  let dehydratedState = null;
  try {
    const session = await getUnswitchedSession();
    if (session) {
      const { user } = session;
      const { body, locale } = await readDashboardSnapshotCached(user);
      // Match the client cell's wire shape exactly (JSON semantics, ISO date
      // strings) — same-key-different-shape is silent cache poison.
      const wireBody = JSON.parse(JSON.stringify(body)) as unknown as Record<
        string,
        unknown
      >;
      const queryClient = new QueryClient();
      queryClient.setQueryData(queryKeys.dashboardSnapshot(locale), wireBody);
      queryClient.setQueryData(queryKeys.dashboardWidgets(), wireBody.layout);
      dehydratedState = dehydrate(queryClient);
    }
  } catch {
    // Prefetch is an accelerator, never a gate — the client path stands.
  }

  if (dehydratedState === null) {
    return <InsightsPageClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <InsightsPageClient />
    </HydrationBoundary>
  );
}
