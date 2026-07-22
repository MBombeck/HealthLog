"use client";

import type { ReactNode } from "react";
import {
  Flame,
  Footprints,
  HeartPulse,
  Map,
  Mountain,
  Timer,
} from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import type { WorkoutDetailPayload } from "@/hooks/use-workouts";

import {
  formatDuration,
  formatDistanceKm,
  formatNumber,
  formatPaceMinPerKm,
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
): string | null {
  const ctx = workout.sportContext;
  if (!ctx || ctx.count < 2) return null;
  const parts: string[] = [];
  if (ctx.avgDistanceM != null && ctx.avgDistanceM > 0) {
    parts.push(`${formatDistanceKm(ctx.avgDistanceM, locale)} km`);
  }
  parts.push(`${formatDurationMinutes(ctx.avgDurationSec, locale)} min`);
  if (ctx.avgAvgHr != null) parts.push(`${ctx.avgAvgHr} bpm`);
  return parts.join(" · ");
}

export function WorkoutDetailStats({ workout }: WorkoutDetailStatsProps) {
  const { t, locale } = useTranslations();
  const tiles: StatTileProps[] = [];

  tiles.push({
    icon: <Timer className="size-4" />,
    label: t("insights.workouts.detail.statsDuration"),
    value: formatDuration(workout.durationSec),
  });

  if (workout.distanceM != null && workout.distanceM > 0) {
    tiles.push({
      icon: <Map className="size-4" />,
      label: t("insights.workouts.detail.statsDistance"),
      value: `${formatDistanceKm(workout.distanceM, locale)} km`,
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
      value: `${formatNumber(workout.elevationM, locale, 1)} m`,
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
      value: formatPaceMinPerKm(workout.durationSec, workout.distanceM),
    });
  }

  const averageLine = sportAverageLine(workout, locale);

  return (
    <Card data-slot="workout-detail-stats">
      <CardHeader>
        <h2
          data-slot="card-title"
          className="text-base leading-none font-semibold"
        >
          {t("insights.workouts.detail.statsTitle")}
        </h2>
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
        {averageLine ? (
          <p
            data-slot="workout-detail-sport-average"
            className="text-muted-foreground text-xs"
          >
            {t("insights.workouts.detail.sportAverageLabel")}{" "}
            <span className="tabular-nums">{averageLine}</span>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
