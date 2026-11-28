"use client";

import { useState } from "react";

import { ActivityCalendarCard } from "@/components/activity/activity-calendar-card";
import { WorkoutList } from "@/components/insights/workout-list";
import { useCoachMetricScope } from "@/components/insights/use-coach-metric-scope";
import { InfoPopover } from "@/components/ui/info-popover";
import { ListGroup, ListHeading, ListItem } from "@/components/ui/list-row";
import { MenuSelect } from "@/components/ui/menu-select";
import {
  PageAddButton,
  PageCustomizeButton,
} from "@/components/ui/page-customize";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { RowValue } from "@/components/ui/row-value";
import { Skeleton } from "@/components/ui/skeleton";
import { ManualWorkoutSheet } from "@/components/workouts/manual-workout-sheet";
import { WorkoutsCustomizeSheet } from "@/components/workouts/workouts-customize-sheet";
import { useAuth } from "@/hooks/use-auth";
import { useInfiniteWorkouts } from "@/hooks/use-workouts";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useScrollResetOnRoute } from "@/hooks/use-scroll-reset-on-route";
import { useTranslations } from "@/lib/i18n/context";
import { translateOrNull } from "@/lib/i18n/translate-code";
import { useModuleListPrefs } from "@/lib/module-list-prefs";
import { canLogWorkout } from "@/lib/workouts/manual-entry";
import { WORKOUTS_PAGE_SIZE } from "@/lib/workouts/page-size";

const ALL_SPORTS = "all";

/**
 * `/insights/workouts`, a domain page (`domain-page-template.md`): the title
 * with its (i), the wrench ("Seite anpassen") and, on a wide screen, "Add";
 * the activity calendar as the one summary; then the workouts under one
 * heading with their count and the one filter, the sport.
 *
 * On a phone the tab bar's plus opens the workout form directly
 * (`captureKindForPath`). The module gate stands in front of this page: an
 * account with workouts off meets the module notice instead
 * (`ModulePageGate`), and the API refuses it.
 *
 * The `page.tsx` RSC wrapper server-prefetches the first page of the
 * unfiltered list under the same key this page reads.
 */
export default function InsightsWorkoutsPageClient() {
  const { t, tCount } = useTranslations();
  const [sportType, setSportType] = useState<string | undefined>(undefined);
  const [logOpen, setLogOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const { user } = useAuth();
  const capabilities = useRecordCapabilities();
  const showLog = canLogWorkout(capabilities, user?.modules);
  const { prefs, setSummary, setSummaryMeasure } =
    useModuleListPrefs("workouts");
  useScrollResetOnRoute();
  useCoachMetricScope("workouts");

  const {
    workouts,
    total,
    isLoading,
    isEmpty,
    isError,
    error,
    isFetchNextPageError,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useInfiniteWorkouts({ limit: WORKOUTS_PAGE_SIZE, sportType });
  // The sport filter's vocabulary and the sources come with the unfiltered
  // first page; under a filter that cell stays cached beside the filtered one.
  const { sports, sources } = useInfiniteWorkouts({
    limit: WORKOUTS_PAGE_SIZE,
  });

  const sportLabel = (sport: string) =>
    translateOrNull(t, `insights.workouts.sport.${sport}`) ?? sport;

  const noWorkoutsAtAll = isEmpty && sportType === undefined;

  return (
    <div data-slot="workouts-page" className="space-y-6">
      <PageHeader
        title={t("insights.workouts.title")}
        titleId="insights-subpage-title"
        titleAccessory={
          <InfoPopover
            align="start"
            triggerDataSlot="metric-explainer-trigger"
            bodyDataSlot="metric-explainer"
            iconClassName="size-5"
            content={t("insights.subPage.explainer.workoutsBody")}
          />
        }
        actions={
          <>
            <PageCustomizeButton onClick={() => setCustomizeOpen(true)} />
            {showLog ? (
              <PageAddButton
                slot="workout-log-manual"
                onClick={() => setLogOpen(true)}
              />
            ) : null}
          </>
        }
      />
      {showLog ? (
        <ManualWorkoutSheet open={logOpen} onOpenChange={setLogOpen} />
      ) : null}
      <WorkoutsCustomizeSheet
        open={customizeOpen}
        onOpenChange={setCustomizeOpen}
        summary={prefs.summary}
        onSummaryChange={setSummary}
        measure={prefs.summaryMeasure}
        onMeasureChange={setSummaryMeasure}
        sources={sources}
      />

      {/* Zone 3: the summary. It draws from steps alone too, so an account
          without workouts still sees its routine; "Seite anpassen" turns it
          off. */}
      {prefs.summary ? (
        <ActivityCalendarCard
          measure={prefs.summaryMeasure}
          onMeasureChange={setSummaryMeasure}
        />
      ) : null}

      {/* Zone 4: the records. */}
      <section aria-labelledby="workouts-heading" className="space-y-3">
        <ListHeading
          id="workouts-heading"
          title={t("insights.workouts.title")}
          count={
            total > 0 ? (
              <span
                data-slot="workout-list-count"
                aria-label={tCount("insights.workouts.count", total)}
              >
                {total}
              </span>
            ) : undefined
          }
          action={
            sports.length > 1 ? (
              <MenuSelect
                value={sportType ?? ALL_SPORTS}
                label={t("insights.workouts.filterLabel")}
                slot="workout-sport-filter"
                options={[
                  {
                    value: ALL_SPORTS,
                    label: t("insights.workouts.filterAll"),
                  },
                  ...sports.map((s) => ({
                    value: s.sportType,
                    label: sportLabel(s.sportType),
                  })),
                ]}
                onChange={(next) =>
                  setSportType(next === ALL_SPORTS ? undefined : next)
                }
              />
            ) : null
          }
        />
        {isError ? (
          <QueryErrorCard
            error={error}
            title={t("insights.workouts.loadError")}
            onRetry={() => refetch()}
          />
        ) : isLoading ? (
          <div data-slot="workouts-loading" className="space-y-2">
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-xl" />
          </div>
        ) : noWorkoutsAtAll ? (
          // The empty state is one row: what adding does.
          <ListGroup
            data-slot="workouts-empty"
            empty={
              showLog
                ? {
                    label: t("insights.workouts.manual.logWorkout"),
                    onSelect: () => setLogOpen(true),
                  }
                : { label: t("insights.workouts.emptyState.title") }
            }
          />
        ) : workouts.length === 0 ? (
          <ListGroup data-slot="workout-list-filter-empty">
            <ListItem
              title={t("list.noMatches")}
              onSelect={() => setSportType(undefined)}
              actionLabel={`${t("list.noMatches")}, ${t("list.resetFilter")}`}
              trailing={
                <RowValue className="text-primary">
                  {t("list.resetFilter")}
                </RowValue>
              }
            />
          </ListGroup>
        ) : (
          <WorkoutList
            workouts={workouts}
            total={total}
            pageSize={WORKOUTS_PAGE_SIZE}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            isFetchNextPageError={isFetchNextPageError}
            onLoadMore={fetchNextPage}
          />
        )}
      </section>
    </div>
  );
}
