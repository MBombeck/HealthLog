"use client";

import Link from "next/link";
import {
  Activity,
  Bike,
  Dumbbell,
  Footprints,
  HeartPulse,
  Mountain,
  PersonStanding,
  type LucideIcon,
} from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { useWorkouts, type WorkoutListEntry } from "@/hooks/use-workouts";
import { cn } from "@/lib/utils";

/**
 * v1.4.32 — `<RecentWorkoutsTile>`.
 *
 * Dashboard card that surfaces the user's three most-recent workouts,
 * one row each, with the sport icon + the day + the duration. The
 * tile is gated on the `recentWorkouts` widget id in
 * `DEFAULT_DASHBOARD_LAYOUT` — operators / users opt out via Settings
 * → Dashboard. Empty-state mounts a neutral notice that steers the
 * user toward the Apple Health sync onboarding cue rather than a
 * dead "Add workout" button (the web has no manual workout-entry
 * form today; the iOS client owns the ingest path).
 *
 * Cache: shares the `["workouts", "recent", { limit: 3 }]` slot with
 * the canonical `useWorkouts({ limit: 3 })` consumer so navigating
 * between the dashboard and `/insights/workouts` is a single
 * round-trip per session.
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
  mixedCardio: HeartPulse,
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

function formatDayLabel(iso: string, locale: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(d);
}

function renderRow(workout: WorkoutListEntry, sportName: string) {
  const Icon = iconForSport(workout.sportType);
  return (
    <span
      data-slot="recent-workouts-row"
      className="flex items-center gap-3 text-sm"
    >
      <span
        aria-hidden="true"
        className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-full"
      >
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate font-medium">{sportName}</span>
    </span>
  );
}

export function RecentWorkoutsTile() {
  const { t, locale } = useTranslations();
  const { data, isLoading } = useWorkouts({ limit: 3 });
  const workouts = data?.workouts ?? [];

  return (
    <div
      data-slot="recent-workouts-tile"
      className={cn(
        "bg-card border-border space-y-3 rounded-xl border p-4",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="text-primary size-4" aria-hidden="true" />
          <h2 className="text-sm font-semibold">
            {t("dashboard.recentWorkouts.title")}
          </h2>
        </div>
        <Link
          href="/insights/workouts"
          className="text-muted-foreground hover:text-foreground text-xs"
        >
          {t("dashboard.recentWorkouts.viewAll")}
        </Link>
      </div>

      {isLoading ? (
        // v1.4.43 W11-L6 — reserve roughly the loaded tile height
        // (3 workouts × ~3 rem rows + spacing) so the surrounding
        // dashboard layout doesn't reflow once the data lands.
        <p
          data-slot="recent-workouts-loading"
          className="text-muted-foreground min-h-[10rem] text-xs"
        >
          {t("dashboard.recentWorkouts.loading")}
        </p>
      ) : workouts.length === 0 ? (
        <div data-slot="recent-workouts-empty" className="space-y-1">
          <p className="text-sm">
            {t("dashboard.recentWorkouts.empty.title")}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("dashboard.recentWorkouts.empty.cta")}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {workouts.map((workout) => {
            const sportLabelKey = `insights.workouts.sport.${workout.sportType}`;
            const sportLabel = t(sportLabelKey);
            const sportName =
              sportLabel === sportLabelKey ? workout.sportType : sportLabel;
            return (
              <li key={workout.id}>
                <Link
                  href={`/insights/workouts/${encodeURIComponent(workout.id)}`}
                  data-slot="recent-workouts-link"
                  className={cn(
                    "flex items-center gap-2 rounded-md px-1 py-1 transition-colors",
                    "hover:bg-accent focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
                  )}
                >
                  {renderRow(workout, sportName)}
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {formatDayLabel(workout.startedAt, locale)}
                  </span>
                  <span className="ml-1 shrink-0 text-xs font-medium tabular-nums">
                    {formatDuration(workout.durationSec)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
