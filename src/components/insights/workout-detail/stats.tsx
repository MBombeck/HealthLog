"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Flame,
  Footprints,
  HeartPulse,
  Map,
  Mountain,
  Timer,
} from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import type { WorkoutDetailPayload } from "@/hooks/use-workouts";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import type { UnitPreference } from "@/lib/measurements/display-transform";

import {
  formatDuration,
  formatDistance,
  formatElevation,
  formatNumber,
  formatPace,
  formatDurationMinutes,
} from "./format";

interface StatTileProps {
  icon: ReactNode;
  label: string;
  value: string;
  hint?: string;
}

function StatTile({ icon, label, value, hint }: StatTileProps) {
  return (
    <div
      data-slot="workout-detail-stat"
      className="flex flex-col gap-1 rounded-lg border p-3"
    >
      <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <span aria-hidden="true" className="size-4">
          {icon}
        </span>
        {label}
      </span>
      <span className="text-base font-semibold tabular-nums">{value}</span>
      {hint ? (
        <span className="text-muted-foreground text-xs">{hint}</span>
      ) : null}
    </div>
  );
}

export interface WorkoutDetailStatsProps {
  workout: WorkoutDetailPayload;
}

const PACE_SPORTS = new Set(["walking", "running", "hiking", "cycling"]);

/**
 * Build the muted own-history comparison line ("Your recent average:
 * 5.8 km · 34 min · 148 bpm"). Own-history only — never a population
 * comparison (non-diagnostic standard). Rendered only when at least two
 * sessions of the sport exist, so it never restates the single workout
 * you are already looking at.
 */
function sportAverageLine(
  workout: WorkoutDetailPayload,
  locale: string,
  preference: UnitPreference,
): string | null {
  const ctx = workout.sportContext;
  if (!ctx || ctx.count < 2) return null;
  const parts: string[] = [];
  if (ctx.avgDistanceM != null && ctx.avgDistanceM > 0) {
    parts.push(formatDistance(ctx.avgDistanceM, locale, preference));
  }
  parts.push(`${formatDurationMinutes(ctx.avgDurationSec, locale)} min`);
  if (ctx.avgAvgHr != null) parts.push(`${ctx.avgAvgHr} bpm`);
  return parts.join(" · ");
}

export function WorkoutDetailStats({ workout }: WorkoutDetailStatsProps) {
  const { t, locale } = useTranslations();
  const { preference } = useUnitDisplay();
  const tiles: StatTileProps[] = [];

  tiles.push({
    icon: <Timer className="size-4" />,
    label: t("insights.workouts.detail.statsDuration"),
    value: formatDuration(workout.durationSec, t),
  });

  if (workout.distanceM != null && workout.distanceM > 0) {
    tiles.push({
      icon: <Map className="size-4" />,
      label: t("insights.workouts.detail.statsDistance"),
      value: formatDistance(workout.distanceM, locale, preference),
    });
  }

  if (workout.activeEnergyKcal != null) {
    tiles.push({
      icon: <Flame className="size-4" />,
      label: t("insights.workouts.detail.statsActiveEnergy"),
      value: `${formatNumber(workout.activeEnergyKcal, locale)} kcal`,
    });
  }

  if (workout.avgHr != null) {
    tiles.push({
      icon: <HeartPulse className="size-4" />,
      label: t("insights.workouts.detail.statsAvgHr"),
      value: `${workout.avgHr} bpm`,
      hint:
        workout.maxHr != null
          ? `${t("insights.workouts.detail.statsMaxHr")}: ${workout.maxHr} bpm`
          : undefined,
    });
  }

  if (workout.minHr != null) {
    tiles.push({
      icon: <HeartPulse className="size-4" />,
      label: t("insights.workouts.detail.statsMinHr"),
      value: `${workout.minHr} bpm`,
    });
  }

  if (workout.stepCount != null && workout.stepCount > 0) {
    tiles.push({
      icon: <Footprints className="size-4" />,
      label: t("insights.workouts.detail.statsStepCount"),
      value: formatNumber(workout.stepCount, locale),
    });
  }

  if (workout.elevationM != null && workout.elevationM !== 0) {
    tiles.push({
      icon: <Mountain className="size-4" />,
      label: t("insights.workouts.detail.statsElevation"),
      value: formatElevation(workout.elevationM, locale, preference),
    });
  }

  if (
    workout.distanceM != null &&
    workout.distanceM > 100 &&
    PACE_SPORTS.has(workout.sportType)
  ) {
    tiles.push({
      icon: <Timer className="size-4" />,
      label: t("insights.workouts.detail.statsPace"),
      value: formatPace(workout.durationSec, workout.distanceM, preference),
    });
  }

  const averageLine = sportAverageLine(workout, locale, preference);

  return (
    <Card data-slot="workout-detail-stats">
      <CardHeader>
        {/* Icon-less `TileHeader`, not a hand-rolled h2 — the standards
            allow exactly three header patterns and this card is a tile. */}
        <TileHeader
          title={t("insights.workouts.detail.statsTitle")}
          titleAs="h2"
        />
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          className={cn(
            "grid gap-2",
            "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4",
          )}
        >
          {tiles.map((tile) => (
            <StatTile key={tile.label} {...tile} />
          ))}
        </div>
        {averageLine || workout.previousWorkoutId ? (
          // One row, per the inline-action shape: the sentence wraps
          // internally, the link stays beside it.
          <div className="flex items-start justify-between gap-3">
            {averageLine ? (
              <p
                data-slot="workout-detail-sport-average"
                className="text-muted-foreground min-w-0 flex-1 text-xs"
              >
                {t("insights.workouts.detail.sportAverageLabel")}{" "}
                <span className="tabular-nums">{averageLine}</span>
              </p>
            ) : (
              <span className="min-w-0 flex-1" />
            )}
            {workout.previousWorkoutId ? (
              <Link
                href={`/insights/workouts/${workout.previousWorkoutId}`}
                data-slot="workout-detail-previous-link"
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex shrink-0 items-center gap-1.5 text-xs underline-offset-4 transition-colors hover:underline focus-visible:ring-[3px] focus-visible:outline-none"
              >
                {t("insights.workouts.detail.previousSessionLink")}
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
