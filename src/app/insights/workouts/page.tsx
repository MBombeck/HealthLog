"use client";

import { Activity } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { useWorkouts } from "@/hooks/use-workouts";
import { CoachLaunchButton } from "@/components/insights/coach-launch-button";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { WorkoutList } from "@/components/insights/workout-list";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * v1.4.32 — `/insights/workouts`.
 *
 * Workouts list sub-page. Pairs with the iOS HKWorkout ingest path
 * (`POST /api/workouts/batch`) and the v1.4.30 cross-source picker so
 * twin workouts from Apple Watch + Withings ScanWatch collapse to a
 * single row. The page is the user-visible surface for the workout
 * data the iOS client already syncs.
 *
 * Renders three states:
 *   - loading shell while the workouts query resolves,
 *   - empty state when the user has no workouts yet (CTA points at
 *     the iOS / Apple Health onboarding cue — there is no manual
 *     workout-entry form today),
 *   - the deduped list otherwise. Each row links to
 *     `/insights/workouts/[id]` for the detail surface.
 */
export default function InsightsWorkoutsPage() {
  const { t } = useTranslations();
  const { data, isLoading, isEmpty } = useWorkouts({ limit: 100 });

  return (
    <SubPageShell
      title={t("insights.workouts.title")}
      description={t("insights.workouts.description")}
      explainerMetric="workouts"
    >
      {isLoading ? (
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
      ) : data ? (
        <>
          <WorkoutList workouts={data.workouts} />
          <CoachLaunchButton />
        </>
      ) : null}
    </SubPageShell>
  );
}
