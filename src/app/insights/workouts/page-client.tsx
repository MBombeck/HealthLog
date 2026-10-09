"use client";

import { useMemo, useState } from "react";
import { Activity } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { useInfiniteWorkouts } from "@/hooks/use-workouts";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import {
  SubPageAddButton,
  SubPageShell,
} from "@/components/insights/sub-page-shell";
import { WorkoutList } from "@/components/insights/workout-list";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ManualWorkoutSheet } from "@/components/workouts/manual-workout-sheet";
import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { canLogWorkout } from "@/lib/workouts/manual-entry";
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
 *
 * A sport filter narrows the list server-side through the `sportType`
 * parameter the route and the hook already accept. The chips offer only
 * sports the account actually has, captured from the unfiltered read, so
 * choosing one never empties the row it was chosen from. The RSC prefetch
 * seeds the unfiltered key only, so a filtered view costs one client fetch.
 */
export default function InsightsWorkoutsPageClient() {
  const { t, tCount } = useTranslations();
  const [sportType, setSportType] = useState<string | undefined>(undefined);
  const [logOpen, setLogOpen] = useState(false);
  const { user } = useAuth();
  const capabilities = useRecordCapabilities();
  const showLog = canLogWorkout(capabilities, user?.modules);
  const {
    workouts,
    total,
    isLoading,
    isEmpty,
    isError,
    isFetchNextPageError,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useInfiniteWorkouts({ limit: 100, sportType });

  // The chip row's vocabulary comes from the UNFILTERED read: deriving it
  // from the filtered list would collapse the row to the one sport already
  // chosen, leaving no way back. With no filter active this resolves to the
  // very same query key as the list above, so the two share one query and
  // the row costs nothing; under a filter it keeps serving that cache.
  const { workouts: allSports } = useInfiniteWorkouts({ limit: 100 });
  const sportOptions = useMemo(
    () => Array.from(new Set(allSports.map((w) => w.sportType))).sort(),
    [allSports],
  );

  const sportLabel = (sport: string) => {
    // A sport enum the bundle has no copy for renders as its canonical
    // string rather than a raw key — same fallback the list rows use.
    const key = `insights.workouts.sport.${sport}`;
    const label = t(key);
    return label === key ? sport : label;
  };

  return (
    <SubPageShell
      title={t("insights.workouts.title")}
      description={t("insights.workouts.description")}
      explainerMetric="workouts"
      coachLaunch
      headerAction={
        showLog ? (
          // The shared header plus; it opens the form in place.
          <SubPageAddButton
            label={t("insights.workouts.manual.logWorkout")}
            onClick={() => setLogOpen(true)}
            slot="workout-log-manual"
          />
        ) : null
      }
    >
      {showLog ? (
        <ManualWorkoutSheet open={logOpen} onOpenChange={setLogOpen} />
      ) : null}
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
      ) : isEmpty && sportType === undefined ? (
        <MetricEmptyState
          icon={<Activity className="size-6" />}
          title={t("insights.workouts.emptyState.title")}
          description={t("insights.workouts.emptyState.description")}
          cta={
            showLog ? (
              <Button size="sm" type="button" onClick={() => setLogOpen(true)}>
                {t("insights.workouts.manual.logWorkout")}
              </Button>
            ) : null
          }
          coachPrefill="I haven't logged any workouts yet. Why does tracking them matter, and what should I focus on first?"
        />
      ) : (
        <>
          {sportOptions.length > 1 ? (
            <div
              data-slot="workout-sport-filter"
              role="group"
              aria-label={t("insights.workouts.filterLabel")}
              // Borderless page-level blocks track the shell heading's own
              // card inset, so the row, the count line and the h1 above them
              // share one left edge.
              className="flex flex-wrap gap-2 px-4 md:px-6"
            >
              {[undefined, ...sportOptions].map((sport) => {
                const active = sport === sportType;
                return (
                  <button
                    key={sport ?? "all"}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSportType(sport)}
                    className={cn(
                      "focus-visible:ring-ring inline-flex min-h-11 items-center rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none sm:min-h-8",
                      active
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {sport === undefined
                      ? t("insights.workouts.filterAll")
                      : sportLabel(sport)}
                  </button>
                );
              })}
            </div>
          ) : null}
          {workouts.length > 0 ? (
            <>
              <p
                data-slot="workout-list-count"
                className="text-muted-foreground px-4 text-xs md:px-6"
              >
                {tCount("insights.workouts.count", total)}
              </p>
              <WorkoutList
                workouts={workouts}
                hasNextPage={hasNextPage}
                isFetchingNextPage={isFetchingNextPage}
                isFetchNextPageError={isFetchNextPageError}
                onLoadMore={fetchNextPage}
              />
            </>
          ) : (
            <p
              data-slot="workout-list-filter-empty"
              className="text-muted-foreground px-4 text-sm md:px-6"
            >
              {t("insights.workouts.filterEmpty")}
            </p>
          )}
        </>
      )}
    </SubPageShell>
  );
}
