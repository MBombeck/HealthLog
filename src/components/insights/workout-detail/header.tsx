"use client";

import { useTranslations, useTimeFormatPreference } from "@/lib/i18n/context";
import { MEASUREMENT_SOURCE_LIST_LABEL_KEYS } from "@/lib/i18n/source-labels";
import { iconForSport } from "@/lib/workouts/sport-icons";
import type { WorkoutDetailPayload } from "@/hooks/use-workouts";
import { useUnitDisplay } from "@/hooks/use-unit-display";

import { formatDuration, formatDistance, formatDateRange } from "./format";

/**
 * Hero header — the at-a-glance verdict row. Sport icon badge, source
 * provenance line, sport name, date/time range, big duration + distance.
 */

export interface WorkoutDetailHeaderProps {
  workout: WorkoutDetailPayload;
}

function renderSportIconBadge(sportType: string) {
  const Icon = iconForSport(sportType);
  return (
    <span
      aria-hidden="true"
      className="bg-muted text-muted-foreground flex size-12 shrink-0 items-center justify-center rounded-full"
    >
      <Icon className="size-6" />
    </span>
  );
}

export function WorkoutDetailHeader({ workout }: WorkoutDetailHeaderProps) {
  const { t, locale } = useTranslations();
  const timeFormat = useTimeFormatPreference();
  const { preference } = useUnitDisplay();
  const sportLabelKey = `insights.workouts.sport.${workout.sportType}`;
  const sportLabel = t(sportLabelKey);
  const sportName =
    sportLabel === sportLabelKey ? workout.sportType : sportLabel;

  return (
    <header
      data-slot="workout-detail-header"
      // v1.30 mobile audit (W-1) — stack below sm so the long-format date
      // line never squeezes beside a text-2xl duration at 360px.
      className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4"
    >
      <div className="flex min-w-0 items-start gap-4">
        {renderSportIconBadge(workout.sportType)}
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-muted-foreground text-xs tracking-wide uppercase">
            {MEASUREMENT_SOURCE_LIST_LABEL_KEYS[
              workout.source as keyof typeof MEASUREMENT_SOURCE_LIST_LABEL_KEYS
            ]
              ? t(
                  MEASUREMENT_SOURCE_LIST_LABEL_KEYS[
                    workout.source as keyof typeof MEASUREMENT_SOURCE_LIST_LABEL_KEYS
                  ],
                )
              : workout.source}
          </p>
          <h2 className="truncate text-lg font-semibold sm:text-xl">
            {sportName}
          </h2>
          <p className="text-muted-foreground text-sm">
            {formatDateRange(
              workout.startedAt,
              workout.endedAt,
              locale,
              timeFormat,
            )}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 sm:flex-col sm:items-end sm:gap-0 sm:text-right">
        <span className="text-2xl font-semibold tabular-nums">
          {formatDuration(workout.durationSec, t)}
        </span>
        {workout.distanceM != null ? (
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatDistance(workout.distanceM, locale, preference)}
          </span>
        ) : null}
      </div>
    </header>
  );
}
