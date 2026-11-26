"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useDashboardChartReveal } from "@/components/dashboard/chart-reveal";
import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import { EnvironmentChip } from "@/components/dashboard/environment-chip";
import { RecoveryKitBanner } from "@/components/dashboard/recovery-kit-banner";
import { ServerSetupNotice } from "@/components/admin/server-setup-notice";
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
import {
  MorningBlock,
  morningSlot,
  useDailyMorning,
} from "@/components/daily/morning-block";
import { MorningSkeleton } from "@/components/daily/morning-skeleton";
import { TodayHero } from "@/components/daily/today-hero";
import { GettingStartedChecklist } from "@/components/onboarding/getting-started-checklist";
import { PullToRefreshIndicator } from "@/components/ui/pull-to-refresh-indicator";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { useAccountOnceMounted, useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import type { BatchWindow } from "@/lib/dashboard/batch-chart-types";
import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";

/**
 * The dashboard: the header, the morning block (the Today hero as its
 * fallback), and the tiles and charts the
 * layout switches on. Which tiles exist, what each reads, when each shows and
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
  const queryClient = useQueryClient();
  const { canWriteDomain } = useRecordCapabilities();
  const canAddMeasurement = canWriteDomain("measurements");
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
  const todaySlot = morningSlot({
    // Only an explicit `false` in the layout settings hides the block.
    visible: layout.todayCardVisible !== false,
    hasDigest: digestQuery.data != null,
    // `null` is a morning-less answer (an older cache): the hero stands in.
    hasMorning: morningQuery.data != null,
    mounted,
    digestLoading: digestQuery.isLoading,
    morningLoading: morningQuery.isLoading,
    digestError: digestQuery.isError,
  });
  const tileContext = useDashboardTileContext({ dashboard, user });

  const renderFilteredHeroAllClear =
    (layout.enabledHeroItemKinds ?? PRIORITY_ITEM_KINDS).length <
    PRIORITY_ITEM_KINDS.length;

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
      // The switch in the layout settings, for the e2e check: the card
      // itself renders nothing on a day without a digest.
      data-today-card={layout.todayCardVisible === false ? "off" : "on"}
    >
      <PullToRefreshIndicator {...pull} />
      <DashboardHeader onQuickEntry={setQuickEntryDialog} />
      <RecoveryKitBanner isAdmin={user?.role === "ADMIN"} />
      {/* Where an admin lands after signing in: one notice about the server
          (an unfinished setup, or the relay question waiting on the admin
          start page), until that admin sets it aside. Nothing for anyone
          else. The relay question itself is asked on the admin start page. */}
      <ServerSetupNotice surface="dashboard" />

      {/* Records other people share with you are reached from the account
          switcher in the top bar and the sidebar, not from a card here. The
          dashboard is this account's own day. */}

      {
        // The morning block above the tile strip: the day's sentence, the
        // health score beside it, and the cards (last night, different
        // today, to do today). DATA-FIRST, so the SSR pass paints it (the
        // LCP element). That is hydration-safe ONLY because `page.tsx` seeds
        // the digest and the morning together or not at all, so both are
        // present on the SSR pass and the first hydration render or both are
        // absent, and because `["daily", …]` is NOT in the persist allowlist
        // (`PERSIST_ALLOWLIST_HEADS` in `@/lib/pwa/query-persister`), so
        // neither rehydrates from disk. Without both, the server and the
        // first client pass paint the same skeleton and the block fills in
        // one step; a sentence never changes after hydration.
        //
        // The digest alone, with the morning failed (or a response cached
        // by an older service worker that has none), falls back to the Today
        // hero. A failed digest is an error card with retry. The block can
        // be switched off in the layout settings; only an explicit `false`
        // hides it, its skeleton and its error card.
        todaySlot === "block" && digestQuery.data && morningQuery.data ? (
          <MorningBlock
            digest={digestQuery.data}
            morning={morningQuery.data}
            // The server-persisted hero choice rides the same resolved
            // layout as the widget visibility, so SSR and hydration agree.
            primaryContent={layout.hero ?? "score"}
            onLogDose={() => setQuickEntryDialog("medicationIntake")}
            onAddMeasurement={
              canAddMeasurement
                ? () => setQuickEntryDialog("measurement")
                : undefined
            }
          />
        ) : todaySlot === "skeleton" ? (
          <MorningSkeleton />
        ) : todaySlot === "hero" && digestQuery.data ? (
          <TodayHero
            digest={digestQuery.data}
            renderFilteredAllClear={renderFilteredHeroAllClear}
            primaryContent={layout.hero ?? "score"}
          />
        ) : todaySlot === "error" ? (
          <QueryErrorCard
            error={digestQuery.error}
            onRetry={() => digestQuery.refetch()}
          />
        ) : null
      }

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
      {demoMode ? null : <GettingStartedChecklist />}
    </div>
  );
}
