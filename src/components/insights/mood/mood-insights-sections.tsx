"use client";

import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";

import { CalendarDays, Sparkles } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import {
  MoodHeatmap,
  MoodHeatmapSkeleton,
} from "@/components/charts/mood-heatmap";
import { SectionCard, type MoodInsightsResponse } from "./mood-insights-shared";
import { apiGet } from "@/lib/api/api-fetch";

/**
 * Every breakdown below the fold, in its own chunk.
 *
 * The calendar and the assessment are what this route paints first; the
 * dozen-odd breakdown cards under them — both tag axes, the influence board,
 * the two crosstabs, the day-context comparison, the four Recharts
 * mini-charts, the correlation cards — are not visible until the reader has
 * scrolled past the line chart and the target card. Static-importing them
 * made every cold mount of `/insights/mood` pay for all of them before
 * painting anything, and it is what put this route on its bundle ceiling.
 *
 * Deferred behind `next/dynamic` like the below-the-hero blocks on the
 * insights mother page. `ssr: false` because the whole subtree is a client
 * render off a client query anyway, and the skeleton holds the block open at
 * roughly the height of the classification tiles so the chunk lands without
 * shoving the page.
 */
/**
 * The better-days assessment, deferred for one specific reason: it renders the
 * catalogue's tag icons, and that resolver
 * (`@/components/mood/mood-tag-icons`) statically imports about a hundred and
 * sixty lucide icons. Eager, that map rode the first-load graph of a route
 * whose first paint is a calendar. The card itself sits a screen down, under
 * the line chart and the target card.
 *
 * It shares the icon map with the breakdown module below, so the two resolve
 * out of the same lazy group rather than duplicating it.
 */
const MoodBetterDays = dynamic(
  () =>
    import("./mood-better-days").then((mod) => ({
      default: mod.MoodBetterDays,
    })),
  {
    ssr: false,
    loading: () => <Skeleton className="min-h-24 w-full rounded-md" />,
  },
);

const MoodInsightsBreakdowns = dynamic(
  () =>
    import("./mood-insights-breakdowns").then((mod) => ({
      default: mod.MoodInsightsBreakdowns,
    })),
  {
    ssr: false,
    loading: () => <Skeleton className="min-h-48 w-full rounded-xl" />,
  },
);

/**
 * v1.8.5 — additional Mood Insights sections.
 *
 * Reads the pre-computed aggregate bundle from `/api/mood/insights` (cheap
 * cached server read, no LLM) and paints the calendar and the assessment
 * itself, handing the payload to the deferred breakdown module for everything
 * under them. On an empty data set the sections render nothing so the page
 * degrades to the line chart; a failed read is not silent, though — the "rest"
 * region surfaces a `QueryErrorRow` with retry (§6) and shows the loading
 * skeleton while fetching. The heatmap / assessment regions stay invisible
 * during load and error so the page never stacks three frames (see the
 * region split below).
 */

/**
 * v1.12.7 — the mood spine is split into three render regions so the page can
 * thread the operator's exact top-to-bottom order without prop-drilling the
 * whole aggregate payload:
 *
 *   - "heatmap"    — the Stimmungskalender, lifted above the line chart.
 *   - "assessment" — the better-days Einschätzung, placed right after the
 *                    Ziel card.
 *   - "rest"       — the Einordnung classification tiles, the "what stands
 *                    out" card, and every deep-dive breakdown.
 *
 * All three regions read the SAME `queryKeys.moodInsights()` query, so
 * TanStack Query dedups the fetch (single network read, 60 s staleTime); the
 * regions are pure JSX slices of one resolved payload.
 */
export type MoodInsightsRegion = "heatmap" | "assessment" | "rest";

/**
 * The one read every region shares, exported so the page can wait on the same
 * cell (same key, same fetch, same options) when it decides when the calendar
 * and the line chart appear.
 */
export function useMoodInsights() {
  const { isAuthenticated } = useAuth();
  return useQuery({
    queryKey: queryKeys.moodInsights(),
    queryFn: async () => {
      return apiGet<MoodInsightsResponse>("/api/mood/insights");
    },
    enabled: isAuthenticated,
    staleTime: 60_000,
  });
}

export function MoodInsightsSections({
  region = "rest",
  reveal = true,
}: {
  region?: MoodInsightsRegion;
  /**
   * v1.42 — heatmap region only: hold the calendar on its skeleton until the
   * page says the line chart below is ready too, so the two appear in the
   * same frame instead of one popping in after the other. The skeleton holds
   * the calendar's final height, so the reveal moves nothing.
   */
  reveal?: boolean;
} = {}) {
  const { t } = useTranslations();

  const { data, isLoading, isPending, isError, refetch } = useMoodInsights();

  // `isPending`, not `isLoading`: before the session resolves the read is
  // disabled rather than loading, and the frame must already be there.
  if (region === "heatmap" && (isPending || (!reveal && !isError))) {
    // The calendar's frame and final height from the first paint; the
    // window is known once the read has landed, assumed short until then.
    if (data && data.summary.totalEntries === 0) return null;
    return (
      <SectionCard title={t("insights.mood.heatmapTitle")} icon={CalendarDays}>
        <MoodHeatmapSkeleton days={data?.heatmap.windowDays} />
      </SectionCard>
    );
  }

  if (isLoading) {
    // Only the "rest" region carries the page-level loading skeleton (the
    // heatmap's own is above); the assessment region stays invisible while
    // loading so the page does not stack skeletons down its length.
    return region === "rest" ? (
      <Skeleton className="h-48 w-full rounded-lg" />
    ) : null;
  }

  if (isError) {
    // §6 — a failed read is not an empty page. Surface it once, in the main
    // "rest" region (mirroring the loading convention above), rather than
    // stacking an identical row in all three regions down the page.
    return region === "rest" ? (
      <QueryErrorRow onRetry={() => refetch()} />
    ) : null;
  }

  if (!data || data.summary.totalEntries === 0) {
    return null;
  }

  const heatmapCells = Object.fromEntries(
    data.heatmap.cells.map((cell) => [cell.date, cell]),
  );
  const betterDays = data.betterDays ?? [];
  const hasBetterDays = betterDays.length > 0;

  // v1.12.7 — the Stimmungskalender is lifted above the line chart on the page,
  // so it renders as its own region here.
  if (region === "heatmap") {
    return (
      <SectionCard title={t("insights.mood.heatmapTitle")} icon={CalendarDays}>
        <MoodHeatmap
          cells={heatmapCells}
          days={data.heatmap.windowDays}
          stretch
        />
      </SectionCard>
    );
  }

  // v1.12.7 — the better-days Einschätzung is placed right after the Ziel card
  // on the page, ahead of the classification tiles, so it renders as its own
  // region. It carries the same assessment-card weight the per-metric
  // `<InsightStatusCard>` uses on the other subpages (tighter `gap`/`py`, the
  // `insight-in` entry, and the `insight-assessment` hook) so it reads as THE
  // mood assessment, consistent across the app.
  if (region === "assessment") {
    if (!hasBetterDays) return null;
    return (
      <Card
        aria-live="polite"
        data-slot="insight-assessment"
        // v1.13.1 — match the canonical `gap-2` + `pb-1` heading-to-body
        // rhythm the other assessment cards use, so the heading sits tight
        // above its body instead of floating ~16-24 px above it.
        className="animate-insight-in gap-2 py-3 md:py-4"
      >
        <CardHeader>
          <TileHeader
            icon={Sparkles}
            title={t("insights.mood.betterDays.title")}
          />
        </CardHeader>
        <CardContent>
          <MoodBetterDays factors={betterDays} />
        </CardContent>
      </Card>
    );
  }

  // The rest region is one deferred subtree now: everything in it sits below
  // the fold, and the payload rides in as a prop so the deferred module cannot
  // draw a different snapshot of the aggregate from the regions above it.
  return <MoodInsightsBreakdowns data={data} />;
}
