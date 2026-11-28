"use client";

import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { MEASUREMENT_SOURCE_LIST_LABEL_KEYS } from "@/lib/i18n/source-labels";
import { iconForSport } from "@/lib/workouts/sport-icons";
import type { WorkoutDetailPayload } from "@/hooks/use-workouts";
import { useUnitDisplay } from "@/hooks/use-unit-display";

import { formatDuration, formatDistance } from "./format";
import { translateOrNull } from "@/lib/i18n/translate-code";

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

/**
 * The provenance line. A FIT upload is stored under the generic `IMPORT`
 * source, which read as "Import" over a run whose file names its device; the
 * maker from the file says more, and "FIT file" stands in when it has none.
 */
function sourceLine(
  workout: WorkoutDetailPayload,
  t: (key: string) => string,
): string {
  const meta =
    workout.metadata !== null && typeof workout.metadata === "object"
      ? (workout.metadata as Record<string, unknown>)
      : null;
  if (meta?.importFormat === "fit") {
    const maker = meta.fitManufacturer;
    return typeof maker === "string" && maker.length > 0
      ? maker
          .split("_")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ")
      : t("insights.workouts.detail.sourceFitFile");
  }
  const key =
    MEASUREMENT_SOURCE_LIST_LABEL_KEYS[
      workout.source as keyof typeof MEASUREMENT_SOURCE_LIST_LABEL_KEYS
    ];
  return key ? t(key) : workout.source;
}

export function WorkoutDetailHeader({ workout }: WorkoutDetailHeaderProps) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const { preference } = useUnitDisplay();
  const sportLabelKey = `insights.workouts.sport.${workout.sportType}`;
  const sportName = translateOrNull(t, sportLabelKey) ?? workout.sportType;

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
          <p className="text-muted-foreground text-xs">
            {sourceLine(workout, t)}
          </p>
          <h2 className="truncate text-lg font-semibold sm:text-xl">
            {sportName}
          </h2>
          <p className="text-muted-foreground text-sm">
            {`${fmt.dateWithWeekdaySmart(workout.startedAt)}, ${fmt.time(workout.startedAt)}–${fmt.time(workout.endedAt)}`}
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
