"use client";

import { useQuery } from "@tanstack/react-query";
import { Coffee } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { TileHeader } from "@/components/insights/tile-header";
import { NutrientDailyBarChartDynamic } from "@/components/charts/nutrient-daily-bar-chart-dynamic";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { NutrientDailySeries } from "./types";

const WINDOW_DAYS = 30;

/**
 * v1.29 — caffeine card on `/insights/nutrients`. Rendered ONLY when the
 * window carries at least one logged day. The EFSA safe-level value is
 * phrased as a ceiling, never "limit exceeded" colouring: a day above the
 * dashed line is just a bar above a dashed line.
 *
 * Nothing is drawn while the read is on its way. Most accounts never log
 * caffeine, so a loading card was most often a card that collapsed again a
 * moment later. A failed read says so with a retry, instead of passing for
 * a month without caffeine; it is its own read, so the hydration card's
 * notice does not cover it.
 */
export function CaffeineCard() {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const { data, error, isError, refetch } = useQuery({
    queryKey: queryKeys.nutrientDaily("caffeine", WINDOW_DAYS),
    queryFn: () =>
      apiGet<NutrientDailySeries>(
        `/api/nutrients/daily?nutrient=caffeine&days=${WINDOW_DAYS}`,
      ),
    // The "route swing within a minute is a free cache hit" convention used
    // across the insights queries.
    staleTime: 60_000,
  });

  // The card keeps its frame and title on a failed read, like the hydration
  // card beside it.
  if (isError && !data) {
    return (
      <Card data-slot="nutrients-caffeine-card">
        <CardHeader>
          <TileHeader icon={Coffee} title={t("nutrients.names.caffeine")} />
        </CardHeader>
        <CardContent>
          <QueryErrorRow
            inset
            error={error}
            slot="nutrients-caffeine-error"
            message={t("nutrients.caffeine.loadError")}
            onRetry={() => void refetch()}
          />
        </CardContent>
      </Card>
    );
  }

  const hasData = (data?.days ?? []).some((d) => d.amount > 0);
  if (!data || !hasData) return null;

  const todayTotal = data.days.at(-1)?.amount ?? 0;

  return (
    <Card data-slot="nutrients-caffeine-card">
      <CardHeader>
        <TileHeader icon={Coffee} title={t("nutrients.names.caffeine")} />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <p className="text-2xl font-bold tabular-nums">
            {fmt.integer(Math.round(todayTotal))} {data.unit}
          </p>
          {data.reference ? (
            <p className="text-muted-foreground text-xs">
              {t("nutrients.caffeine.ceilingMeta", {
                value: fmt.integer(Math.round(data.reference.value)),
                unit: data.unit,
              })}
            </p>
          ) : null}
        </div>
        <NutrientDailyBarChartDynamic
          days={data.days}
          unit={data.unit}
          valueLabel={t("nutrients.names.caffeine")}
          referenceValue={data.reference?.value ?? null}
          dayLinks
        />
      </CardContent>
    </Card>
  );
}
