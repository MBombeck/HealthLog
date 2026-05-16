"use client";

import type { ReactNode } from "react";
import {
  Activity,
  Bike,
  Dumbbell,
  Flame,
  Footprints,
  HeartPulse,
  Map,
  Mountain,
  PersonStanding,
  Timer,
  type LucideIcon,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import type { WorkoutDetailPayload } from "@/hooks/use-workouts";

/**
 * v1.4.32 — workout-detail components: header, stats, optional route,
 * optional HR chart.
 *
 * Mounted by `/insights/workouts/[id]/page.tsx`. The page itself owns
 * the data fetch + the empty / loading / error branches; each
 * component below is a pure render primitive over a non-null
 * `WorkoutDetailPayload`.
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
  const s = seconds % 60;
  if (h > 0) {
    return `${h}h ${m.toString().padStart(2, "0")}m ${s.toString().padStart(2, "0")}s`;
  }
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function formatDistanceKm(meters: number, locale: string): string {
  const km = meters / 1000;
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 2,
    minimumFractionDigits: km < 10 ? 2 : 1,
  }).format(km);
}

function formatNumber(value: number, locale: string, fractionDigits = 0): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  }).format(value);
}

function formatPaceMinPerKm(durationSec: number, meters: number, locale: string): string {
  // Pace is the seconds-per-kilometre value. Only meaningful for
  // run / walk / hike. The caller already gated on `meters > 0`.
  const secPerKm = (durationSec / meters) * 1000;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${s.toString().padStart(2, "0")} ${locale === "en" ? "/km" : "/km"}`;
}

function formatDateRange(startedAt: string, endedAt: string, locale: string): string {
  const start = new Date(startedAt);
  const end = new Date(endedAt);
  const dateFmt = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
  const timeFmt = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${dateFmt.format(start)} · ${timeFmt.format(start)} – ${timeFmt.format(end)}`;
}

// ── Header ───────────────────────────────────────────────────────────

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
  const sportLabelKey = `insights.workouts.sport.${workout.sportType}`;
  const sportLabel = t(sportLabelKey);
  const sportName =
    sportLabel === sportLabelKey ? workout.sportType : sportLabel;

  return (
    <header
      data-slot="workout-detail-header"
      className="flex items-start gap-4"
    >
      {renderSportIconBadge(workout.sportType)}
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-muted-foreground text-xs uppercase tracking-wide">
          {workout.source}
        </p>
        <h2 className="truncate text-lg font-semibold sm:text-xl">
          {sportName}
        </h2>
        <p className="text-muted-foreground text-sm">
          {formatDateRange(workout.startedAt, workout.endedAt, locale)}
        </p>
      </div>
      <div className="flex flex-col items-end text-right">
        <span className="text-2xl font-semibold tabular-nums">
          {formatDuration(workout.durationSec)}
        </span>
        {workout.distanceM != null ? (
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatDistanceKm(workout.distanceM, locale)} km
          </span>
        ) : null}
      </div>
    </header>
  );
}

// ── Stats ────────────────────────────────────────────────────────────

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
        <span className="text-muted-foreground text-[11px]">{hint}</span>
      ) : null}
    </div>
  );
}

export interface WorkoutDetailStatsProps {
  workout: WorkoutDetailPayload;
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

  // Pace is only meaningful for foot- and ride-paced sports. Surface
  // it when the workout has both a distance and a sport with a
  // canonical pace unit; the fallback covers the long-tail HK enum
  // values without lighting up a misleading number.
  const PACE_SPORTS = new Set([
    "walking",
    "running",
    "hiking",
    "cycling",
  ]);
  if (
    workout.distanceM != null &&
    workout.distanceM > 100 &&
    PACE_SPORTS.has(workout.sportType)
  ) {
    tiles.push({
      icon: <Timer className="size-4" />,
      label: t("insights.workouts.detail.statsPace"),
      value: formatPaceMinPerKm(workout.durationSec, workout.distanceM, locale),
    });
  }

  return (
    <Card data-slot="workout-detail-stats">
      <CardHeader>
        <CardTitle className="text-base">
          {t("insights.workouts.detail.statsTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent
        className={cn(
          "grid gap-2",
          "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4",
        )}
      >
        {tiles.map((tile) => (
          <StatTile key={tile.label} {...tile} />
        ))}
      </CardContent>
    </Card>
  );
}

// ── Route ────────────────────────────────────────────────────────────

export interface WorkoutDetailRouteProps {
  workout: WorkoutDetailPayload;
}

interface LineStringGeometry {
  type: "LineString";
  coordinates: Array<[number, number] | [number, number, number]>;
}

function isLineString(value: unknown): value is LineStringGeometry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.type === "LineString" && Array.isArray(v.coordinates);
}

export function WorkoutDetailRoute({ workout }: WorkoutDetailRouteProps) {
  const { t } = useTranslations();
  const geometry = workout.route?.geometry;

  if (!isLineString(geometry) || geometry.coordinates.length < 2) {
    return (
      <Card data-slot="workout-detail-route-empty">
        <CardHeader>
          <CardTitle className="text-base">
            {t("insights.workouts.detail.routeTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          {t("insights.workouts.detail.routeUnavailable")}
        </CardContent>
      </Card>
    );
  }

  // The map widget itself defers to v1.5.x (MapLibre / Leaflet not yet
  // pulled in). For v1.4.32 we paint a lightweight SVG polyline of the
  // route geometry — projection-free, normalised against the bounding
  // box, no third-party dependency. Resolution is fine on screen
  // because routes are bounded to 20 000 points by the ingest cap.
  const coordinates = geometry.coordinates;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of coordinates) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const padLon = (maxLon - minLon) * 0.05 || 0.0001;
  const padLat = (maxLat - minLat) * 0.05 || 0.0001;
  minLon -= padLon;
  maxLon += padLon;
  minLat -= padLat;
  maxLat += padLat;
  const VIEW_W = 400;
  const VIEW_H = 240;
  const points = coordinates
    .map(([lon, lat]) => {
      const x = ((lon - minLon) / (maxLon - minLon)) * VIEW_W;
      // SVG y-axis grows downward; flip lat → y.
      const y = VIEW_H - ((lat - minLat) / (maxLat - minLat)) * VIEW_H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <Card data-slot="workout-detail-route">
      <CardHeader>
        <CardTitle className="text-base">
          {t("insights.workouts.detail.routeTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="bg-muted/40 h-60 w-full rounded-md"
          role="img"
          aria-label={t("insights.workouts.detail.routeTitle")}
        >
          <polyline
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-primary"
          />
        </svg>
      </CardContent>
    </Card>
  );
}

// ── Heart-rate chart ─────────────────────────────────────────────────

export function WorkoutDetailHRChart({ workout }: { workout: WorkoutDetailPayload }) {
  const { t } = useTranslations();

  // Per-second HR samples are not persisted on the Workout row today —
  // the W8d ingest schema stores aggregates only (avg / max / min).
  // The per-second series lives on the corresponding `Measurement`
  // rows posted alongside the workout via `POST /api/measurements/batch`.
  // Wiring that into the detail page consumes a future v1.5.x sprint
  // (see R-F T2 + W8d outline); for v1.4.32 the slot renders a
  // graceful empty state with the aggregates already surfaced on
  // `<WorkoutDetailStats>`.
  return (
    <Card data-slot="workout-detail-hr-chart">
      <CardHeader>
        <CardTitle className="text-base">
          {t("insights.workouts.detail.hrChartTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-muted-foreground space-y-2 text-sm">
        <p>{t("insights.workouts.detail.hrChartUnavailable")}</p>
        {workout.avgHr != null || workout.maxHr != null ? (
          <p>
            {workout.avgHr != null
              ? `${t("insights.workouts.detail.statsAvgHr")}: ${workout.avgHr} bpm`
              : null}
            {workout.avgHr != null && workout.maxHr != null ? " · " : ""}
            {workout.maxHr != null
              ? `${t("insights.workouts.detail.statsMaxHr")}: ${workout.maxHr} bpm`
              : null}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
