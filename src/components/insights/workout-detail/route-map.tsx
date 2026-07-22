"use client";

import { useMemo, type ComponentProps } from "react";
import dynamic from "next/dynamic";
import { Map as MapIcon, Download } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TileHeader } from "@/components/insights/tile-header";
import { ChartErrorBoundary } from "@/components/charts/chart-error-state";
import { importWithRetry } from "@/lib/retry-import";
import { useTranslations } from "@/lib/i18n/context";
import {
  projectRoute,
  buildElevationProfile,
  buildGpxDocument,
  type RouteCoordinate,
} from "@/lib/workouts/route-svg";
import type { WorkoutDetailPayload } from "@/hooks/use-workouts";

const WorkoutElevationChartLazy = dynamic(
  () =>
    importWithRetry(() => import("@/components/charts/chart-runtime")).then(
      (mod) => ({ default: mod.WorkoutElevationChart }),
    ),
  { ssr: false, loading: () => <div className="h-24 w-full" /> },
);
function WorkoutElevationChart(
  props: ComponentProps<typeof WorkoutElevationChartLazy>,
) {
  return (
    <ChartErrorBoundary>
      <WorkoutElevationChartLazy {...props} />
    </ChartErrorBoundary>
  );
}

interface LineStringGeometry {
  type: "LineString";
  coordinates: RouteCoordinate[];
}

function isLineString(value: unknown): value is LineStringGeometry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.type === "LineString" && Array.isArray(v.coordinates);
}

export interface WorkoutDetailRouteProps {
  workout: WorkoutDetailPayload;
}

/**
 * GPS route card — a self-rendered, aspect-true SVG polyline over the
 * user's own stored geometry. Zero external requests: no tile server, no
 * geocoder, nothing leaves the origin (binding privacy/CSP property).
 * Start = filled `--success` dot, end = `--foreground` ring. Optional
 * elevation profile below when the track carries altitude. A GPX export
 * lets the user take their track with them — built client-side, zero
 * egress. Returns `null` when there is no usable geometry (hide, don't
 * render empty).
 */
export function WorkoutDetailRoute({ workout }: WorkoutDetailRouteProps) {
  const { t } = useTranslations();
  const geometry = workout.route?.geometry;
  const coordinates = isLineString(geometry) ? geometry.coordinates : null;

  const projected = useMemo(
    () => (coordinates ? projectRoute(coordinates) : null),
    [coordinates],
  );
  const elevation = useMemo(
    () => (coordinates ? buildElevationProfile(coordinates) : null),
    [coordinates],
  );

  if (!coordinates || !projected) return null;

  const exportGpx = () => {
    const gpx = buildGpxDocument({
      coordinates,
      timestamps: workout.route?.sampleTimestamps ?? null,
      sportType: workout.sportType,
      startedAt: workout.startedAt,
    });
    const blob = new Blob([gpx], { type: "application/gpx+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `workout-${workout.id}.gpx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const markerR = 1.6;

  return (
    <Card data-slot="workout-detail-route">
      <CardHeader>
        <TileHeader
          icon={MapIcon}
          title={t("insights.workouts.detail.routeTitle")}
          titleAs="h2"
          right={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={exportGpx}
              data-slot="workout-detail-gpx-export"
            >
              <Download className="size-4" aria-hidden="true" />
              {t("insights.workouts.detail.exportGpx")}
            </Button>
          }
        />
      </CardHeader>
      <CardContent className="space-y-3">
        <svg
          viewBox={projected.viewBox}
          preserveAspectRatio="xMidYMid meet"
          className="bg-muted/40 max-h-72 w-full rounded-md"
          role="img"
          aria-label={t("insights.workouts.detail.routeTitle")}
        >
          <path
            d={projected.path}
            fill="none"
            stroke="var(--chart-1)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {/* End ring first so the start dot always sits on top on a loop. */}
          <circle
            cx={projected.end.x}
            cy={projected.end.y}
            r={markerR}
            fill="none"
            stroke="var(--foreground)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          <circle
            cx={projected.start.x}
            cy={projected.start.y}
            r={markerR}
            fill="var(--success)"
          />
        </svg>
        {elevation ? (
          <div data-slot="workout-detail-elevation">
            <p className="text-muted-foreground mb-1 text-xs">
              {t("insights.workouts.detail.elevationTitle")}
            </p>
            <WorkoutElevationChart points={elevation} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
