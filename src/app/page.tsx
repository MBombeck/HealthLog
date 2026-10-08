import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query";

import { getUnswitchedSession } from "@/lib/auth/acting-carrier";
import { readDashboardSnapshotCached } from "@/lib/dashboard/snapshot-read";
import { isDashboardSnapshotEnabled } from "@/lib/dashboard/snapshot-flag";
import {
  computeBatchWindow,
  deriveBatchChartTypes,
  type BatchWindow,
} from "@/lib/dashboard/batch-chart-types";
import { resolveDashboardLayout } from "@/lib/dashboard-layout";
import { settleWithin } from "@/lib/async/settle-within";
import { loadDailyDigest } from "@/lib/daily/load-digest";
import { readSeriesBatch } from "@/lib/measurements/series-batch-read";
import { queryKeys } from "@/lib/query-keys";
import type { MeasurementType } from "@/generated/prisma/client";

import DashboardPageClient from "./page-client";

/**
 * Soft budget on the cold-day digest prefetch. `loadDailyDigest`'s only
 * heavy input is the `daily-digest-extras` SWR cell: on the FIRST digest read
 * of a user's local day it rebuilds the streak scan + intraday-pulse read cold
 * (low hundreds of ms). Racing it against this budget bounds the worst-case
 * TTFB regression — the abandoned work still runs to completion and warms the
 * SWR cell, so the client fetch that follows a skipped dehydrate lands warm.
 */
const DIGEST_SOFT_BUDGET_MS = 400;

/**
 * Thin RSC wrapper around the (client) dashboard page.
 *
 * The measured first-load gap on `/` was never the server: FCP painted the
 * SSR skeleton shell at ~1.8 s but LCP landed at ~5.5 s (mobile-throttled)
 * because the real above-the-fold content waited for the full JS download +
 * hydrate + CLIENT-side fetches. This wrapper runs the same cached reads the
 * routes use during SSR and hands them to TanStack through `HydrationBoundary`,
 * so the first HTML already carries real content and the mounted cells start
 * warm instead of skeleton-first:
 *
 *  - the dashboard snapshot (`/api/dashboard/snapshot`) — every tile;
 *  - the Today digest (`/api/daily/digest` → `loadDailyDigest`) — the hero;
 *  - the batched chart series (`/api/measurements/series-batch` →
 *    `readSeriesBatch`) — the chart row.
 *
 * Contract notes:
 *  - Query keys come ONLY from the central factory. Every dehydrated VALUE is
 *    JSON-round-tripped so the hydrated shape is exactly what the client
 *    `queryFn` would produce from the wire ((await res.json()).data — Dates as
 *    ISO strings), never a Date-carrying sibling that poisons the cell.
 *  - The batched-series key is the crux: the CSV type list comes from the
 *    SHARED `deriveBatchChartTypes` over the SAME snapshot payload, and the ISO
 *    window from `computeBatchWindow(now, user.timezone)` threaded to the
 *    client as the `batchWindow` prop. Server and client build the identical
 *    key by construction, so the prefetched slice lands instead of refetching.
 *  - The digest is the day's data and belongs to no module (the `insights`
 *    key is AI analysis, which the digest omits on its own), so it is
 *    prefetched for every account, as the client fetches it for every account.
 *  - Record identity: the session comes from `getUnswitchedSession()`, which
 *    answers null while the browser is acting on somebody else's record. Every
 *    read below scopes to `user`, and under a switch `user` is the DELEGATE —
 *    so the snapshot, the digest and the widget layout would seed one person's
 *    numbers under a banner naming another. Since those three became delegable
 *    reads the client's refetch does correct it, which makes the failure a
 *    flash of the wrong person's dashboard rather than a permanent one; that
 *    is a smaller bug and not a different one, so the accessor still steps
 *    aside here. Its docblock carries the full argument, including why
 *    resolving the owner here instead is the worse answer.
 *  - Fail-soft: no session, an active switch, a builder hiccup, or a DB blip
 *    renders the page exactly as before this wrapper existed — the client cells
 *    own the fetch. Each prefetch is independent; one failing never blocks the
 *    others.
 */
export default async function DashboardPage() {
  // Operator/test escape hatch: `DASHBOARD_SSR_PREFETCH=false` renders the
  // pure client-fetch dashboard (pre-prefetch behaviour). The e2e server
  // sets it so Playwright route mocks — which only see CLIENT fetches —
  // keep governing what the dashboard paints. It gates EVERY prefetch below.
  if (process.env.DASHBOARD_SSR_PREFETCH === "false") {
    return <DashboardPageClient />;
  }
  let dehydratedState = null;
  let batchWindow: BatchWindow | undefined;
  try {
    const session = await getUnswitchedSession();
    if (session) {
      const { user } = session;
      const { body, locale } = await readDashboardSnapshotCached(user);
      // Match the client cell's wire shape exactly (JSON semantics, ISO
      // date strings) — same-key-different-shape is silent cache poison.
      const wireBody = JSON.parse(JSON.stringify(body)) as unknown as Record<
        string,
        unknown
      >;
      const queryClient = new QueryClient();
      queryClient.setQueryData(queryKeys.dashboardSnapshot(locale), wireBody);
      queryClient.setQueryData(queryKeys.dashboardWidgets(), wireBody.layout);

      // Above-the-fold prefetch runs ONLY in snapshot mode: legacy mode derives
      // its chart-type list from analytics queries the RSC did not run, so there
      // is no byte-identical key to dehydrate the series under. In legacy mode
      // `batchWindow` stays undefined and the client falls back to its own
      // browser-local window exactly as before — no behaviour change off-flag.
      const snapshotMode = isDashboardSnapshotEnabled();

      // The profile-tz window is computed ONCE (snapshot mode only) and threaded
      // to the client so the batched-series key matches byte-for-byte.
      if (snapshotMode) {
        batchWindow = computeBatchWindow(new Date(), user.timezone);
      }

      const seriesTypes = snapshotMode
        ? deriveBatchChartTypes(
            resolveDashboardLayout(wireBody.layout),
            (
              wireBody.tiles as {
                summaries?: Record<string, { count?: number }>;
              }
            )?.summaries,
          )
        : [];

      // Digest carries a soft budget (cold-day extras rebuild); series is a
      // warm rollup read (< 100 ms) with none. Both fail soft to `undefined`.
      const digestWork = loadDailyDigest(user).catch(() => undefined);
      const seriesWork =
        batchWindow && seriesTypes.length > 0
          ? readSeriesBatch(
              user.id,
              seriesTypes as MeasurementType[],
              new Date(batchWindow.from),
              new Date(batchWindow.to),
            )
              .then((result) => result.series)
              .catch(() => undefined)
          : Promise.resolve(undefined);

      const [digest, series] = await Promise.all([
        settleWithin(digestWork, DIGEST_SOFT_BUDGET_MS, undefined),
        seriesWork,
      ]);

      // JSON-round-trip both to the client wire shape before seeding.
      if (digest !== undefined) {
        queryClient.setQueryData(
          queryKeys.dailyDigest(),
          JSON.parse(JSON.stringify(digest)),
        );
      }
      // `series` is only ever set when `batchWindow` was (snapshot mode) — the
      // explicit `batchWindow` guard just narrows the type for the key build.
      if (series !== undefined && batchWindow) {
        queryClient.setQueryData(
          queryKeys.chartSeriesBatch(
            seriesTypes.join(","),
            batchWindow.from,
            batchWindow.to,
          ),
          JSON.parse(JSON.stringify(series)),
        );
      }

      dehydratedState = dehydrate(queryClient);
    }
  } catch {
    // Prefetch is an accelerator, never a gate — the client path stands.
  }

  if (dehydratedState === null) {
    return <DashboardPageClient batchWindow={batchWindow} />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <DashboardPageClient batchWindow={batchWindow} />
    </HydrationBoundary>
  );
}
