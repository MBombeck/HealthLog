"use client";

import { useQuery } from "@tanstack/react-query";
import { Coffee } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TileHeader } from "@/components/insights/tile-header";
import { NutrientDailyBarChartDynamic } from "@/components/charts/nutrient-daily-bar-chart-dynamic";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { NutrientDailySeries } from "./types";

const WINDOW_DAYS = 30;

/**
 * v1.29 — caffeine card on `/insights/nutrients`. Rendered ONLY when the
 * window carries at least one logged day (a query-error also collapses
 * to nothing rather than a card the user can do nothing with — the
 * hydration card above already carries the surface's error affordance).
 * The EFSA safe-level value is phrased as a ceiling, never "limit
 * exceeded" colouring: a day above the dashed line is just a bar above
 * a dashed line.
 */
export function CaffeineCard() {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.nutrientDaily("caffeine", WINDOW_DAYS),
    queryFn: () =>
      apiGet<NutrientDailySeries>(
        `/api/nutrients/daily?nutrient=caffeine&days=${WINDOW_DAYS}`,
      ),
    // v1.30 UI audit (M7) — this card unmounts entirely on a no-data window
    // (`hasData` gate below), so a self-hoster who never logs caffeine saw
    // the 280px skeleton collapse on every `/insights/nutrients` visit. A
    // 60s `staleTime` (the "route swing within a minute is a free cache
    // hit" convention used across the insights queries) keeps the flash to
    // once per session rather than once per mount.
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <Card data-slot="nutrients-caffeine-card">
        <CardContent className="py-6" aria-hidden="true">
          <Skeleton className="h-[280px] w-full" />
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
