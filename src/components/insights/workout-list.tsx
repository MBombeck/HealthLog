"use client";

import { getNumberFormat } from "@/lib/intl/formatter-cache";
import { formatDurationMinutes } from "@/lib/i18n/duration";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { iconForSport } from "@/lib/workouts/sport-icons";
import type { WorkoutListEntry } from "@/hooks/use-workouts";
import {
  ListColumns,
  ListGroup,
  ListHead,
  ListItem,
  ListMoreRow,
} from "@/components/ui/list-row";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import { formatDistance } from "@/components/insights/workout-detail/format";
import { translateOrNull } from "@/lib/i18n/translate-code";

/**
 * The workouts of the workouts page (domain page template, zone 4): one
 * `ListGroup`, one `ListItem` per workout. Icon tile, the sport, one meta
 * line with the start and, on a phone, the distance; the
 * duration trailing. On a wide screen the same rows gain the distance,
 * energy and average pulse as columns under a quiet column head. The whole
 * row opens the workout. The cross-source merge runs on the server, so the
 * list is already deduped when it lands here.
 *
 * "Weitere n zeigen" is the last row while the server holds more.
 */

function formatEnergy(kcal: number, locale: string): string {
  return getNumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(Math.round(kcal));
}

export interface WorkoutListProps {
  workouts: WorkoutListEntry[];
  /** Workouts the server holds for the current filter. */
  total?: number;
  /** Rows one more page adds. */
  pageSize?: number;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  isFetchNextPageError?: boolean;
  onLoadMore?: () => void;
}

export function WorkoutList({
  workouts,
  total = workouts.length,
  pageSize = workouts.length,
  hasNextPage = false,
  isFetchingNextPage = false,
  isFetchNextPageError = false,
  onLoadMore,
}: WorkoutListProps) {
  const { t, locale } = useTranslations();
  // The reader's date order, hour cycle and zone, as everywhere else; the
  // year shows whenever the workout is not from this year.
  const fmt = useFormatters();
  const { preference } = useUnitDisplay();
  const more = Math.max(0, Math.min(pageSize, total - workouts.length));

  return (
    <ListGroup data-slot="workout-list">
      <ListHead
        title={t("insights.workouts.column.workout")}
        columns={[
          { key: "distance", label: t("insights.workouts.column.distance") },
          { key: "energy", label: t("insights.workouts.column.energy") },
          { key: "pulse", label: t("insights.workouts.column.pulse") },
          { key: "duration", label: t("insights.workouts.column.duration") },
        ]}
      />
      {workouts.map((workout) => {
        const Icon = iconForSport(workout.sportType);
        // A sport the bundle has no copy for renders as its canonical string,
        // never as the raw `insights.workouts.sport.x` key.
        const sportName =
          translateOrNull(t, `insights.workouts.sport.${workout.sportType}`) ??
          workout.sportType;
        const duration = formatDurationMinutes(
          Math.round(workout.durationSec / 60),
          t,
        );
        const distance =
          workout.distanceM != null
            ? formatDistance(workout.distanceM, locale, preference)
            : null;
        return (
          <ListItem
            key={workout.id}
            data-slot="workout-list-row"
            href={`/insights/workouts/${encodeURIComponent(workout.id)}`}
            icon={
              <span
                aria-hidden="true"
                className="bg-muted text-foreground flex size-8 items-center justify-center rounded-lg"
              >
                <Icon className="size-4" />
              </span>
            }
            title={sportName}
            meta={
              <>
                {`${fmt.dateWithWeekdaySmart(workout.startedAt)}, ${fmt.time(workout.startedAt)}`}
                {distance ? (
                  <span data-slot="workout-list-distance" className="md:hidden">
                    {`, ${distance}`}
                  </span>
                ) : null}
              </>
            }
            trailing={
              <>
                <span className="md:hidden">{duration}</span>
                <ListColumns
                  cells={[
                    { key: "distance", content: distance },
                    {
                      key: "energy",
                      content:
                        workout.activeEnergyKcal != null ? (
                          <span data-slot="workout-list-energy">
                            {`${formatEnergy(workout.activeEnergyKcal, locale)} kcal`}
                          </span>
                        ) : null,
                    },
                    {
                      key: "pulse",
                      content:
                        workout.avgHr != null ? (
                          <span data-slot="workout-list-avg-hr">
                            {`${workout.avgHr} bpm`}
                          </span>
                        ) : null,
                    },
                    { key: "duration", content: duration, strong: true },
                  ]}
                />
              </>
            }
          />
        );
      })}
      {hasNextPage && onLoadMore ? (
        <ListMoreRow
          label={
            isFetchingNextPage
              ? t("insights.workouts.loadingMore")
              : t("list.showMore", { count: more })
          }
          busy={isFetchingNextPage}
          error={
            isFetchNextPageError
              ? t("insights.workouts.loadMoreError")
              : undefined
          }
          onSelect={onLoadMore}
        />
      ) : null}
    </ListGroup>
  );
}
