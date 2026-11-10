"use client";

import dynamic from "next/dynamic";
import { Divide } from "lucide-react";

import {
  ChartErrorBoundary,
  ChartErrorState,
} from "@/components/charts/chart-error-state";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { TileHeader } from "@/components/insights/tile-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { GKI_COMPONENT_UNIT } from "@/lib/measurements/glucose-ketone-index";
import { useGlucoseKetoneIndexSeries } from "@/lib/queries/use-glucose-ketone-index";
import { importWithRetry } from "@/lib/retry-import";

// The line chart the custom metrics draw: a value over time with range tabs
// and the day doors. Loaded through the one recharts boundary.
const IndexChartLazy = dynamic(
  () =>
    importWithRetry(() => import("@/components/charts/chart-runtime")).then(
      (mod) => ({ default: mod.CustomMetricChart }),
    ),
  { ssr: false, loading: () => <ChartSkeleton /> },
);

/**
 * The glucose-ketone index (#1367), beneath the ketone chart. Every point is
 * one ketone reading and the glucose reading the server paired with it; the
 * value is the server's and is drawn as given. The latest pair is spelled out
 * so the number can be traced to the two readings it came from. No band and
 * no verdict: what the index should be is the treating clinician's call.
 */
export function GkiCard() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const query = useGlucoseKetoneIndexSeries();
  const points = query.data?.points ?? [];
  const latest = points[points.length - 1];
  const title = t("measurements.glucoseKetoneIndex");

  return (
    <Card data-slot="gki-card" aria-busy={query.isFetching || undefined}>
      <CardHeader>
        <TileHeader icon={Divide} title={title} titleAs="h2" />
        <CardDescription>
          {t("insights.bloodKetones.gki.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isPending ? (
          <ChartSkeleton />
        ) : query.isError ? (
          <ChartErrorState
            error={query.error}
            title={t("charts.errorTitle")}
            actionLabel={t("common.retry")}
            actionContext={title}
            onAction={() => void query.refetch()}
          />
        ) : !latest ? (
          <EmptyState
            variant="plain"
            size="compact"
            title={t("insights.bloodKetones.gki.emptyTitle")}
            description={t("insights.bloodKetones.gki.emptyDescription")}
          />
        ) : (
          <>
            <p className="text-sm" data-slot="gki-latest">
              {t("insights.bloodKetones.gki.latest", {
                value: fmt.number(latest.value, 1),
                glucose: fmt.number(latest.gki.glucoseMmol, 1),
                ketones: fmt.number(latest.gki.ketonesMmol, 1),
                unit: GKI_COMPONENT_UNIT,
                date: fmt.dateTime(latest.at),
              })}
            </p>
            <ChartErrorBoundary>
              <IndexChartLazy
                name={title}
                unit=""
                targetLow={null}
                targetHigh={null}
                decimals={1}
                entries={points.map((p) => ({
                  id: p.id,
                  customMetricId: "",
                  value: p.value,
                  unit: "",
                  measuredAt: p.at,
                  note: null,
                  createdAt: p.at,
                }))}
              />
            </ChartErrorBoundary>
          </>
        )}
      </CardContent>
    </Card>
  );
}
