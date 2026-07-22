"use client";

import dynamic from "next/dynamic";
import { HeartPulse } from "lucide-react";
import type { ComponentProps } from "react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { ChartErrorBoundary } from "@/components/charts/chart-error-state";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { importWithRetry } from "@/lib/retry-import";
import { useTranslations } from "@/lib/i18n/context";
import type { WorkoutDetailPayload } from "@/hooks/use-workouts";

// Route the HR curve through the ONE recharts async boundary so the
// library stays a single shared chunk (chart-runtime.ts header rule).
const WorkoutHrChartLazy = dynamic(
  () =>
    importWithRetry(() => import("@/components/charts/chart-runtime")).then(
      (mod) => ({ default: mod.WorkoutHrChart }),
    ),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
function WorkoutHrChart(props: ComponentProps<typeof WorkoutHrChartLazy>) {
  return (
    <ChartErrorBoundary>
      <WorkoutHrChartLazy {...props} />
    </ChartErrorBoundary>
  );
}

export interface WorkoutDetailHrSectionProps {
  workout: WorkoutDetailPayload;
}

/**
 * Heart-rate curve card — mean line + optional min→max envelope + %HRmax
 * zone bands + an average-HR reference line. A muted provenance chip
 * discloses when the curve was reconstructed from pulse data around the
 * session rather than the workout's own sensor stream. Returns `null`
 * when no series is available (hide, don't render empty).
 */
export function WorkoutDetailHrSection({
  workout,
}: WorkoutDetailHrSectionProps) {
  const { t } = useTranslations();
  const series = workout.hrSeries;
  if (!series || series.points.length < 2) return null;

  return (
    <Card data-slot="workout-detail-hr">
      <CardHeader className="gap-1">
        <TileHeader
          icon={HeartPulse}
          title={t("insights.workouts.detail.hrChartTitle")}
          titleAs="h2"
        />
        {series.source === "pulse_window" ? (
          <p
            data-slot="workout-detail-hr-provenance"
            className="text-muted-foreground text-xs"
          >
            {t("insights.workouts.detail.hrFromPulse")}
          </p>
        ) : null}
      </CardHeader>
      <CardContent>
        <WorkoutHrChart
          points={series.points}
          bucketSec={series.bucketSec}
          envelope={series.envelope}
          avgHr={workout.avgHr}
          zones={workout.zones?.zones ?? null}
        />
      </CardContent>
    </Card>
  );
}
