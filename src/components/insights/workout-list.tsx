"use client";

import Link from "next/link";
import {
  Activity,
  Bike,
  Dumbbell,
  Footprints,
  Heart,
  Mountain,
  PersonStanding,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import type { WorkoutListEntry } from "@/hooks/use-workouts";

/**
 * v1.4.32 — workout list row primitive.
 *
 * Renders the canonical workouts list returned by `GET /api/workouts`.
 * Each row links to `/insights/workouts/[id]`. The visual shape mirrors
 * the dashboard tile primitives — single-line metadata strip with the
 * sport icon, the date, the duration, and (when present) the distance
 * + active-energy chips. The Apple Watch + Withings cross-source merge
 * runs server-side, so the list is already deduped by the time it
 * lands here.
 */

const SPORT_TYPE_ICON: Record<string, LucideIcon> = {
  walking: Footprints,
  running: PersonStanding,
  cycling: Bike,
  hiking: Mountain,
  swimming: Activity,
  rowing: Activity,
  elliptical: Activity,
  stairClimber: Activity,
  yoga: PersonStanding,
  mindAndBody: PersonStanding,
  strength: Dumbbell,
  hiit: Activity,
  dance: Activity,
  golf: Activity,
  tennis: Activity,
  basketball: Activity,
  soccer: Activity,
  crossTraining: Activity,
  mixedCardio: Heart,
  other: Activity,
};

function iconForSport(sportType: string): LucideIcon {
  return SPORT_TYPE_ICON[sportType] ?? Activity;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  return `${m}m`;
}

function formatDistanceKm(meters: number, locale: string): string {
  const km = meters / 1000;
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 2,
    minimumFractionDigits: km < 10 ? 2 : 1,
  }).format(km);
}

function formatEnergy(kcal: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(Math.round(kcal));
}

function formatDate(iso: string, locale: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export interface WorkoutListProps {
  workouts: WorkoutListEntry[];
  className?: string;
}

export function WorkoutList({ workouts, className }: WorkoutListProps) {
  const { t, locale } = useTranslations();

  return (
    <ul
      data-slot="workout-list"
      className={cn("divide-y divide-border rounded-lg border", className)}
    >
      {workouts.map((workout) => {
        const Icon = iconForSport(workout.sportType);
        const sportLabelKey = `insights.workouts.sport.${workout.sportType}`;
        const sportLabel = t(sportLabelKey);
        // Translation keys missing from one locale fall back to the
        // canonical sport-type string so a new HK enum value never
        // renders the raw `insights.workouts.sport.x` placeholder.
        const sportName = sportLabel === sportLabelKey
          ? workout.sportType
          : sportLabel;

        return (
          <li key={workout.id}>
            <Link
              href={`/insights/workouts/${encodeURIComponent(workout.id)}`}
              data-slot="workout-list-row"
              className={cn(
                "flex items-center gap-3 px-3 py-3 text-sm transition-colors",
                "hover:bg-accent focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
              )}
            >
              <span
                aria-hidden="true"
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
              >
                <Icon className="size-4" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-medium">{sportName}</span>
                <span className="text-muted-foreground truncate text-xs">
                  {formatDate(workout.startedAt, locale)}
                </span>
              </div>
              <div className="flex flex-col items-end gap-0.5 text-xs">
                <span className="font-medium tabular-nums">
                  {formatDuration(workout.durationSec)}
                </span>
                <span className="text-muted-foreground flex flex-wrap justify-end gap-x-2 tabular-nums">
                  {workout.distanceM != null ? (
                    <span data-slot="workout-list-distance">
                      {formatDistanceKm(workout.distanceM, locale)} km
                    </span>
                  ) : null}
                  {workout.activeEnergyKcal != null ? (
                    <span data-slot="workout-list-energy">
                      {formatEnergy(workout.activeEnergyKcal, locale)} kcal
                    </span>
                  ) : null}
                </span>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
