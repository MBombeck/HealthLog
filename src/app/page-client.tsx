"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useDashboardChartReveal } from "@/components/dashboard/chart-reveal";
import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import { EnvironmentChip } from "@/components/dashboard/environment-chip";
import { RecoveryKitBanner } from "@/components/dashboard/recovery-kit-banner";
import {
  QuickEntrySheets,
  type QuickEntryDialog,
} from "@/components/dashboard/quick-entry-sheets";
import {
  buildChartEntries,
  revealChartIds,
  visibleChartTiles,
} from "@/components/dashboard/tiles/chart-tiles";
import { DashboardTiles } from "@/components/dashboard/tiles/dashboard-tiles";
import { buildStripEntries } from "@/components/dashboard/tiles/strip-tiles";
import { useDashboardTileContext } from "@/components/dashboard/tiles/tile-context";
import { useDashboardData } from "@/components/dashboard/tiles/use-dashboard-data";
import { TodayAsks } from "@/components/dashboard/today-asks";
import {
  TodayScores,
  TodayScoresSkeleton,
  todaySlot as resolveTodaySlot,
} from "@/components/dashboard/today-scores";
import { GettingStartedChecklist } from "@/components/onboarding/getting-started-checklist";
import { SetupCard } from "@/components/onboarding/setup-card";
import { useSetupState } from "@/components/onboarding/use-setup-state";
import { PullToRefreshIndicator } from "@/components/ui/pull-to-refresh-indicator";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { useAccountOnceMounted, useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useDailyMorning } from "@/lib/queries/use-daily-morning";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import type { BatchWindow } from "@/lib/dashboard/batch-chart-types";

/**
 * The dashboard: the header, what today asks (only when it asks something),
 * the score row, and the tiles and charts the layout switches on. Which tiles exist, what each reads, when each shows and
 * where it sits is the registry under `components/dashboard/tiles/`; this
 * component only composes.
 */
export default function DashboardPageClient({
  batchWindow,
  demoMode = false,
}: {
  /**
   * The batched-series ISO window computed server-side from the PROFILE time
   * zone, present only when the RSC prefetch ran. Adopted verbatim so the
   * `chartSeriesBatch` key matches the key the RSC dehydrated under.
   */
  batchWindow?: BatchWindow;
  /**
   * True on a `DEMO_MODE` instance. The demo is one shared, read-only
   * account a visitor cannot set up, so the setup checklist has nothing to
   * offer there, as the shell already leaves out the tour.
   */
  demoMode?: boolean;
} = {}) {
  const { isAuthenticated } = useAuth();
  const mounted = useMounted();
  // The account payload is withheld until this boundary has mounted, so the
  // hydration render paints exactly what the server streamed. Every
  // account-derived branch (the BMI chart's height gate, the personalised
  // bands, the module gates, the unit labels) would otherwise render one
  // thing on the server and another here, and with the RSC prefetch on that
  // costs the whole streamed dashboard (React #418). See
  // `useAccountOnceMounted`.
  const user = useAccountOnceMounted();
  const setup = useSetupState(!demoMode && Boolean(user));
  const queryClient = useQueryClient();
  const { canWriteDomain } = useRecordCapabilities();
  const canAddMeasurement = canWriteDomain("measurements");
  const canLogDose = canWriteDomain("medications");
  const [quickEntryDialog, setQuickEntryDialog] =
    useState<QuickEntryDialog>(null);

  // Pull to refresh: a PWA resumed from the home screen never fires a focus
  // event, and the dashboard fans out into a dozen independent reads, so
  // refetching every active query is the one tractable "refresh everything
  // visible".
  const refreshDashboard = useCallback(
    () => queryClient.refetchQueries({ type: "active" }),
    [queryClient],
  );
  const pull = usePullToRefresh({ onRefresh: refreshDashboard });

  const dashboard = useDashboardData({
    isAuthenticated,
    mounted,
    batchWindowProp: batchWindow,
  });
  const { digestQuery, layout, primaryLoading } = dashboard;
  const morningQuery = useDailyMorning(isAuthenticated);
  const todaySlot = resolveTodaySlot({
    // Only an explicit `false` in the layout settings hides the score row.
    visible: layout.todayCardVisible !== false,
    hasDigest: digestQuery.data != null,
    // `null` is a morning-less answer (an older cache): the Health score
    // stands alone.
    hasMorning: morningQuery.data != null,
    mounted,
    digestLoading: digestQuery.isLoading,
    morningLoading: morningQuery.isLoading,
    digestError: digestQuery.isError,
  });
  const tileContext = useDashboardTileContext({ dashboard, user });

  // Every data-backed chart mounts as soon as its gate flips (so the chart
  // reads fan out in parallel), but the cells hold their skeletons until
  // every gated chart reported its data settled, or the reveal timeout fired
  // (see `chart-reveal.tsx`), so the row swaps in one frame.
  const chartTiles = visibleChartTiles(tileContext);
  const { revealed: chartsRevealed, markReady: markChartReady } =
    useDashboardChartReveal(revealChartIds(chartTiles));
  const stripEntries = buildStripEntries(tileContext);
  const chartEntries = buildChartEntries(chartTiles, {
    ...tileContext,
    preloadedSeries: dashboard.preloadedSeries,
    markChartReady,
  });

  return (
    <div
      className="space-y-6"
      // The switch in the layout settings, for the e2e check: the score row
      // itself renders nothing on a day without a digest.
      data-today-card={layout.todayCardVisible === false ? "off" : "on"}
    >
      <PullToRefreshIndicator {...pull} />
      <DashboardHeader onQuickEntry={setQuickEntryDialog} />
      <RecoveryKitBanner isAdmin={user?.role === "ADMIN"} />
      {/* 1.50 — the setup card of an account that went through the new
          setup flow; older accounts keep the checklist further down. */}
      {setup.data?.person.cardShown ? <SetupCard state={setup.data} /> : null}

      {/* A quiet note about the newest stored environment day (high pollen, a
          hot night, very poor air). Nothing unless one applies, and nothing
          before mount (the module map and the overview are client reads).
          Not a layout widget. */}
      {mounted && <EnvironmentChip />}

      {/* Bottom sheet below `md`, centred dialog from `md` up. */}
      <QuickEntrySheets
        open={quickEntryDialog}
        onClose={() => setQuickEntryDialog(null)}
      />

      <DashboardTiles
        lead={
          // What today asks, then the score row: on the strip's grid and its
          // gutter, so the three rows read as one. DATA-FIRST, so the SSR
          // pass paints them. That is hydration-safe ONLY because `page.tsx`
          // seeds the digest and the morning together or not at all, and
          // because `["daily", …]` is NOT in the persist allowlist
          // (`PERSIST_ALLOWLIST_HEADS` in `@/lib/pwa/query-persister`), so
          // neither rehydrates from disk. Without both, the server and the
          // first client pass paint the same skeleton.
          //
          // The asks are the server's (`DailyDigest.asks`, at most two, none
          // on most days); the card renders nothing without them, and the
          // layout switch never hides them. The score row can be switched
          // off in the layout settings. A digest without a morning (an older
          // service-worker cache) shows the Health score alone; a failed
          // digest is an error card with retry.
          <>
            {digestQuery.data ? (
              <TodayAsks
                asks={digestQuery.data.asks ?? []}
                onLogDose={
                  canLogDose
                    ? () => setQuickEntryDialog("medicationIntake")
                    : undefined
                }
              />
            ) : null}
            {(todaySlot === "block" || todaySlot === "hero") &&
            digestQuery.data ? (
              <TodayScores
                digest={digestQuery.data}
                morning={todaySlot === "block" ? morningQuery.data : null}
              />
            ) : todaySlot === "skeleton" ? (
              <TodayScoresSkeleton />
            ) : todaySlot === "error" ? (
              <QueryErrorCard
                error={digestQuery.error}
                onRetry={() => digestQuery.refetch()}
              />
            ) : null}
          </>
        }
        stripEntries={stripEntries}
        chartEntries={chartEntries}
        chartsRevealed={chartsRevealed}
        layout={layout}
        primaryLoading={primaryLoading}
        mounted={mounted}
        user={user}
        canAddMeasurement={canAddMeasurement}
        onAddMeasurement={() => setQuickEntryDialog("measurement")}
      />

      {/* The getting-started checklist sits below the tiles and charts: it
          mounts only once the snapshot resolves, and above the strip its late
          arrival pushed every tile down. It gates itself on onboarding state
          and disappears once dismissed or complete. */}
      {demoMode || setup.data?.person.planned !== false ? null : (
        <GettingStartedChecklist />
      )}
    </div>
  );
}
