"use client";

import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useAiCapability } from "@/hooks/use-ai-capability";
import { InsightsTabStrip } from "@/components/insights/insights-tab-strip";
import { useInsightsAdvisorQuery } from "@/components/insights/use-insights-advisor";
import { useInsightsLayoutQuery } from "@/hooks/use-insights-layout";
import { queryKeys } from "@/lib/query-keys";
import type { InsightInputs } from "@/lib/insights/metric-availability";
import { apiGet } from "@/lib/api/api-fetch";

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
 * The tab-strip gate reads one small answer, `/api/insights/presence`
 * (reading counts per type, and whether mood, medication, workout and ECG
 * rows exist), plus the saved layout. Each page loads its own data; the
 * strip used to read the overview, a workouts page and the ECG list on
 * every page for four flags.
 *
 * CRITICAL — the `<CoachDrawer>` does NOT mount here. It lives only in
 * `src/app/insights/page.tsx` body so navigating into a sub-page
 * unmounts the drawer.
 */
interface InsightsPresence {
  metrics: Record<string, { count: number }>;
  hasMood: boolean;
  hasMedication: boolean;
  hasWorkouts: boolean;
  hasEcgRecordings: boolean;
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

  // Answered for the record on screen. A page whose module is off reads
  // false here, and the strip hides its pill through the surface map anyway.
  const presenceQuery = useQuery({
    queryKey: queryKeys.insightsPresence(),
    queryFn: () => apiGet<InsightsPresence>("/api/insights/presence"),
    enabled: isAuthenticated,
  });
  const presence = presenceQuery.data;

  // Nutrients is opt-in, so its pill follows the module toggle alone: the
  // in-context enable CTA lives on `/insights/nutrients` itself, and gating
  // on a first row as well left that page unreachable before data existed.
  const hasNutrients = user?.modules?.nutrients === true;
  const hasEcgRecordings = presence?.hasEcgRecordings === true;
  // Inside a switched-to record the metric pages read `/api/analytics`, which
  // serves only the caller's own record, so their pills would open an error.
  const switched = user?.accountAccess?.active != null;

  // Memoised so an unchanged answer keeps the same reference: the strip is
  // wrapped in `React.memo` and reruns `buildTabs` on a new object.
  const availability: InsightInputs | undefined = useMemo(() => {
    if (!isAuthenticated) return undefined;
    return {
      summaries: switched ? undefined : presence?.metrics,
      hasMood: presence?.hasMood === true,
      hasMedication: presence?.hasMedication === true,
      hasWorkouts: presence?.hasWorkouts === true,
      hasNutrients,
    };
  }, [isAuthenticated, presence, hasNutrients, switched]);

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
