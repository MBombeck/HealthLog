"use client";

import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useAiCapability } from "@/hooks/use-ai-capability";
import { useSurfaceVisible } from "@/hooks/use-surface-visible";
import { useWorkouts } from "@/hooks/use-workouts";
import { InsightsTabStrip } from "@/components/insights/insights-tab-strip";
import {
  nextAdvisorPollInterval,
  useInsightsAdvisorQuery,
} from "@/components/insights/use-insights-advisor";
import { pollAttemptCount } from "@/lib/queries/refetch-interval";
import { useAnalyticsQuery } from "@/lib/queries/use-analytics-query";
import { useInsightsLayoutQuery } from "@/hooks/use-insights-layout";
import { queryKeys } from "@/lib/query-keys";
import type { InsightInputs } from "@/lib/insights/metric-availability";
import { apiGet } from "@/lib/api/api-fetch";
import { useEcgList } from "@/components/insights/use-ecg-list";

/**
 * v1.4.25 — client shell for `src/app/insights/layout.tsx`.
 *
 * Owns the regenerate button on the sticky tab strip, so it works from
 * every Insights surface. The strip shows no briefing, so the shell does
 * not read it: the overview's own `useInsightsAdvisorQuery` does, and the
 * shell's hook reads it only while its regenerate settles. Every metric
 * page used to send the briefing read (and load the schema chunk that
 * parses it) for a button.
 *
 * v1.4.27 — also owns the analytics + comprehensive reads that
 * power the tab-strip availability gate. The analytics consumer goes
 * through the shared `useAnalyticsQuery({ slice: "summaries" })` hook
 * (v1.4.33 IW2); the comprehensive consumer still owns its bespoke
 * fetch but shares its cache key with the sub-page consumers so the
 * payload lands once per route, dedup-shared across consumers.
 *
 * CRITICAL — the `<CoachDrawer>` does NOT mount here. It lives only in
 * `src/app/insights/page.tsx` body so navigating into a sub-page
 * unmounts the drawer.
 */
interface ComprehensivePayload {
  moodSummary: { count: number } | null;
  medications: Array<{ id: string }>;
  /**
   * v1.16.7 — true when the route served a stale cache body while a
   * background rebuild runs (stale-while-revalidate). The query polls
   * (bounded) while set so the fresh aggregate lands in-session.
   */
  revalidating?: boolean;
}

export function InsightsLayoutShell({ children }: { children: ReactNode }) {
  const { isAuthenticated, user } = useAuth();
  // The regenerate button follows the `briefing` capability on
  // `/api/auth/me`: the server resolves the operator's switch,
  // the person's AI analysis opt-out, provider presence and consent into one
  // answer, and the strip offers regenerate only while that answer is yes.
  // Unavailable while `/me` loads, so nothing fires before the answer lands.
  const briefing = useAiCapability("briefing");
  // v1.16.4 — `mounted` keeps the hydration render in lockstep with the
  // SSR HTML: a late-hydrating boundary can see resolved query state on
  // its first render (auth + flags settled), which used to flip the
  // regenerate affordance on at hydration time and trip React #418.
  const mounted = useMounted();
  const advisorEnabled = mounted && isAuthenticated && briefing.available;

  const advisor = useInsightsAdvisorQuery(false);

  // Shared analytics fetch — the layout shell only reads
  // `summaries[METRIC].count` for the tab-strip availability gate, so
  // it lands on IW1's slim `?slice=summaries` branch (2 SQL passes,
  // no correlations / health-score / bp-in-target tail).
  const analyticsQuery = useAnalyticsQuery({ slice: "summaries" });

  // Shared comprehensive fetch — mood + medication signals for the
  // event-driven gating branches. Sub-pages read the same key so the
  // payload lands once per route.
  const comprehensiveQuery = useQuery({
    queryKey: queryKeys.insightsComprehensive(),
    queryFn: async () => {
      return apiGet<ComprehensivePayload>("/api/insights/comprehensive");
    },
    enabled: isAuthenticated,
    // v1.16.7 — converge a stale-served (SWR) body in-session: while the
    // route reports `revalidating: true`, poll on the same bounded
    // cadence the advisor query uses until a fresh body lands.
    refetchInterval: (query) =>
      nextAdvisorPollInterval(
        query.state.data?.revalidating,
        pollAttemptCount(query.state),
      ),
  });

  // v1.4.32 — workout-presence gate. The workouts pill gates on at
  // least one canonical row in the list-endpoint response. The
  // single-row probe shares its cache slot with the list page +
  // dashboard tile so navigation between surfaces is a free cache hit.
  // Only while the Workouts module shows: a switched-off module is never
  // probed (its pill is hidden by the surface map regardless).
  const workoutsVisible = useSurfaceVisible("insights-page:workouts");
  const workoutsProbe = useWorkouts({ limit: 1, enabled: workoutsVisible });

  // v1.29 — nutrients gate. `nutrients` is opt-in (default off), unlike
  // the always-on metric clusters, so the pill's floor is the module
  // toggle alone — not a data-presence probe. Gating on BOTH the toggle
  // AND a first row was a catch-22: the in-context enable CTA lives on
  // `/insights/nutrients` itself, and that page was only reachable once
  // data already existed. A user who just flipped the module on (or
  // wants to) can now always reach the page; the page itself still
  // degrades from "enable" → "no rows yet" → the three-card spine.
  const nutrientsEnabled = user?.modules?.nutrients === true;

  // v1.30 — ECG recording presence for the Heart-group ECG
  // pill. ECG carries no `MeasurementType`, so the metric `availability`
  // model can't gate it; it rides its own `hasRecordings` probe instead. The
  // query shares `queryKeys.insightsEcgList()` with `<EcgSection>` and the
  // ECG page, so the flag lands once per route (dedup-shared, no extra
  // traffic). Undefined until it resolves → the pill stays off on first paint,
  // exactly like the metric pills light up as their summaries land.
  const ecgProbe = useEcgList();
  const hasEcgRecordings = ecgProbe.data?.data.hasRecordings === true;

  // v1.4.31 — memoise the `availability` prop so an unchanged
  // payload doesn't recreate the object on every cache-write of
  // analytics or comprehensive. The strip is wrapped in
  // `React.memo` and would still rerun `buildTabs(availability)` on
  // every parent render if this prop kept arriving as a fresh
  // reference. Per
  // `.planning/research/v15-insights-blocking-bug.md` fix 2.
  const summaries = analyticsQuery.data?.summaries;
  const hasMood = (comprehensiveQuery.data?.moodSummary?.count ?? 0) > 0;
  const hasMedication = (comprehensiveQuery.data?.medications?.length ?? 0) > 0;
  const hasWorkouts = (workoutsProbe.data?.workouts.length ?? 0) > 0;
  const hasNutrients = nutrientsEnabled;
  const availability: InsightInputs | undefined = useMemo(() => {
    if (!isAuthenticated) return undefined;
    return { summaries, hasMood, hasMedication, hasWorkouts, hasNutrients };
  }, [
    isAuthenticated,
    summaries,
    hasMood,
    hasMedication,
    hasWorkouts,
    hasNutrients,
  ]);

  // v1.15.14 — couple the tab strip to the saved insights layout.
  // A sub-page pill now shows iff its metric has data AND its slug is
  // layout-`visible`; the strip orders pills by the saved `order`. We
  // pass the derived visibility set + order map only once the GET has
  // SETTLED (`isSuccess`) — while the layout query is in flight the
  // strip falls back to the data-only gate (props `undefined`) so the
  // first paint is unchanged and a slow/failed layout fetch never
  // suppresses a pill the user has data for. The query shares
  // `queryKeys.insightsLayout()` with the overview + edit mode, so a
  // "Fertig" save repaints the strip in lockstep.
  const { layout: insightsLayout, isSuccess: layoutSettled } =
    useInsightsLayoutQuery(isAuthenticated);
  const visibleTileIds = useMemo(() => {
    if (!layoutSettled) return undefined;
    return new Set(
      insightsLayout.tiles
        .filter((tile) => tile.visible)
        .map((tile) => tile.id),
    );
  }, [layoutSettled, insightsLayout]);
  const tileOrder = useMemo(() => {
    if (!layoutSettled) return undefined;
    return new Map(insightsLayout.tiles.map((tile) => [tile.id, tile.order]));
  }, [layoutSettled, insightsLayout]);

  return (
    <div data-slot="insights-layout-shell" className="space-y-8">
      {/*
        AuthShell gives every route a generic `pt-6`. Insights already owns a
        sticky, padded navigation row as its first surface, so that generic
        spacer became a second unexplained 24px gap on phones. Remove only
        that inherited top padding when this shell is the direct route child.
        Horizontal padding and safe-area-aware bottom clearance stay intact;
        no negative margin can clip pill focus.
      */}
      <style jsx global>{`
        @media (max-width: 767px) {
          #main-content > div:has(> [data-slot="insights-layout-shell"]) {
            padding-top: 0;
          }
        }
      `}</style>
      <InsightsTabStrip
        onRegenerate={advisorEnabled ? advisor.regenerate : undefined}
        regenerating={advisor.isRegenerating}
        regenerateOutcome={advisor.regenerateOutcome}
        regenerateSettling={advisor.regenerateSettling}
        availability={availability}
        visibleTileIds={visibleTileIds}
        tileOrder={tileOrder}
        modules={user?.modules}
        hasEcgRecordings={hasEcgRecordings}
      />
      {children}
    </div>
  );
}
