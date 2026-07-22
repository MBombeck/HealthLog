"use client";

import { Activity, Loader2 } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { useInfiniteWorkouts } from "@/hooks/use-workouts";
import { useModulePageGuard } from "@/hooks/use-module-page-guard";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { WorkoutList } from "@/components/insights/workout-list";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorCard } from "@/components/ui/query-error-card";

/**
 * v1.4.32 — `/insights/workouts`.
 *
 * Workouts list sub-page. Pairs with the iOS HKWorkout ingest path
 * (`POST /api/workouts/batch`) and the v1.4.30 cross-source picker so
 * twin workouts from Apple Watch + Withings ScanWatch collapse to a
 * single row. The page is the user-visible surface for the workout
 * data the iOS client already syncs.
 *
 * v1.32 — the `page.tsx` RSC wrapper server-prefetches the first page in
 * TanStack's infinite-data shape. Explicit "Load more" requests append
 * canonical offset pages while keeping the already-rendered history visible.
 *
 * Renders three states:
 *   - loading shell while the workouts query resolves,
 *   - empty state when the user has no workouts yet (CTA points at
 *     the iOS / Apple Health onboarding cue — there is no manual
 *     workout-entry form today),
 *   - the deduped list otherwise. Each row links to
 *     `/insights/workouts/[id]` for the detail surface.
 */
export default function InsightsWorkoutsPageClient() {
  const { t } = useTranslations();
  const { ready } = useModulePageGuard("workouts");
  const {
    workouts,
    isLoading,
    isEmpty,
    isError,
    isFetchNextPageError,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useInfiniteWorkouts({ limit: 100 });

  // v1.18.0 B1 — bounce a direct URL hit on a disabled-workouts account.
  if (!ready) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  return (
    <SubPageShell
      title={t("insights.workouts.title")}
      description={t("insights.workouts.description")}
      explainerMetric="workouts"
      coachLaunch
    >
      {/* No `<MetricRangeControls>` here: workouts are session records, not a
          MeasurementType series, so the period-over-period range read has
          nothing to aggregate. */}
      {isError ? (
        <QueryErrorCard
          title={t("insights.workouts.loadError")}
          onRetry={() => refetch()}
        />
      ) : isLoading ? (
        <div data-slot="workouts-loading" className="space-y-2">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      ) : isEmpty ? (
        <MetricEmptyState
          icon={<Activity className="size-6" />}
          title={t("insights.workouts.emptyState.title")}
          description={t("insights.workouts.emptyState.description")}
          cta={null}
          coachPrefill="I haven't logged any workouts yet — why does tracking them matter, and what should I focus on first?"
        />
      ) : workouts.length > 0 ? (
        <WorkoutList
          workouts={workouts}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          isFetchNextPageError={isFetchNextPageError}
          onLoadMore={fetchNextPage}
        />
      ) : null}
    </SubPageShell>
  );
}
