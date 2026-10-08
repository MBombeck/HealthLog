"use client";

import Link from "next/link";
import { Activity } from "lucide-react";

import { formatDurationMinutes } from "@/lib/i18n/duration";
import { useTranslations } from "@/lib/i18n/context";
import { useWorkouts, type WorkoutListEntry } from "@/hooks/use-workouts";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { getDateTimeFormat } from "@/lib/intl/formatter-cache";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { iconForSport } from "@/lib/workouts/sport-icons";

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

function formatDayLabel(iso: string, locale: string): string {
  const d = new Date(iso);
  return getDateTimeFormat(locale, {
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
  const { data, isError, refetch } = useWorkouts({ limit: 3 });

  // A query's `isLoading` is not a hydration-safe branch: TanStack reports the
  // optimistic mount fetch on the client's very first render and cannot on the
  // server, so an `isLoading` gate renders one thing in the streamed HTML and
  // another in the hydration render — React #418, and the whole streamed
  // dashboard is discarded. Gate on what both sides can see instead: whether
  // the cell holds an answer yet.
  const showLoading = !data && !isError;
  const workouts = data?.workouts ?? [];

  return (
    <Card data-slot="recent-workouts-tile" className="h-full">
      <CardHeader>
        {/* Canonical tile header (foreground icon + title) — the same
            `TileHeader` contract the Insights tiles use, so the dashboard
            stops speaking a separate header language. `size="sm"` matches the
            compact dashboard tile. */}
        <TileHeader
          icon={Activity}
          size="sm"
          title={t("dashboard.recentWorkouts.title")}
          titleAs="h2"
          right={
            <Link
              href="/insights/workouts"
              className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center text-xs"
            >
              {t("dashboard.recentWorkouts.viewAll")}
            </Link>
          }
        />
      </CardHeader>
      <CardContent>
        {showLoading ? (
          // v1.4.43 W11-L6 — reserve roughly the loaded tile height
          // (3 workouts × ~3 rem rows + spacing) so the surrounding
          // dashboard layout doesn't reflow once the data lands.
          // v1.29.x — row-shaped skeletons instead of a "loading…" text
          // line, matching the sport-icon + label + day + duration shape
          // the loaded rows render.
          <div data-slot="recent-workouts-loading" className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3 px-1 py-1">
                <Skeleton className="size-7 shrink-0 rounded-full" />
                <Skeleton className="h-4 min-w-0 flex-1" />
                <Skeleton className="h-4 w-12 shrink-0" />
                <Skeleton className="h-4 w-8 shrink-0" />
              </div>
            ))}
          </div>
        ) : isError ? (
          <QueryErrorCard
            onRetry={() => refetch()}
            className="border-0 bg-transparent shadow-none"
          />
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
                      {formatDurationMinutes(
                        Math.round(workout.durationSec / 60),
                        t,
                      )}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
