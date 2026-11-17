"use client";

import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { TileHeader } from "@/components/insights/tile-header";
import { NutrientDailyBarChartDynamic } from "@/components/charts/nutrient-daily-bar-chart-dynamic";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { NutrientDailySeries } from "./types";
import { nutrientUnitLabel } from "./unit-label";

const WINDOW_DAYS = 30;

interface SingleNutrientCardProps {
  /** The catalog code the card charts (`caffeine`, `alcohol`). */
  code: string;
  icon: LucideIcon;
  /**
   * The i18n key of the meta line naming the reference, or `null` for a code
   * whose reference the card does not draw (alcohol has none to draw).
   */
  metaKey: string | null;
  /** The i18n key of the failed-read message. */
  loadErrorKey: string;
}

/**
 * One nutrient's card on `/insights/nutrients`: today's total and a 30-day
 * bar chart. Rendered ONLY when the window carries at least one logged day.
 * Caffeine's EFSA safe level is phrased as a ceiling and drawn as a dashed
 * line, never as "limit exceeded" colouring: a day above the line is just a
 * bar above a dashed line. Alcohol draws no line.
 *
 * Nothing is drawn while the read is on its way. Most accounts never log
 * these, so a loading card was most often a card that collapsed again a
 * moment later. A failed read says so with a retry, instead of passing for
 * a month without data; it is its own read, so the hydration card's notice
 * does not cover it.
 */
export function SingleNutrientCard({
  code,
  icon,
  metaKey,
  loadErrorKey,
}: SingleNutrientCardProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const title = t(`nutrients.names.${code}`);
  const slot = `nutrients-${code}-card`;

  const { data, error, isError, refetch } = useQuery({
    queryKey: queryKeys.nutrientDaily(code, WINDOW_DAYS),
    queryFn: () =>
      apiGet<NutrientDailySeries>(
        `/api/nutrients/daily?nutrient=${code}&days=${WINDOW_DAYS}`,
      ),
    // The "route swing within a minute is a free cache hit" convention used
    // across the insights queries.
    staleTime: 60_000,
  });

  // The card keeps its frame and title on a failed read, like the hydration
  // card beside it.
  if (isError && !data) {
    return (
      <Card data-slot={slot}>
        <CardHeader>
          <TileHeader icon={icon} title={title} />
        </CardHeader>
        <CardContent>
          <QueryErrorRow
            inset
            error={error}
            slot={`nutrients-${code}-error`}
            message={t(loadErrorKey)}
            onRetry={() => void refetch()}
          />
        </CardContent>
      </Card>
    );
  }

  const hasData = (data?.days ?? []).some((d) => d.amount > 0);
  if (!data || !hasData) return null;

  const todayTotal = data.days.at(-1)?.amount ?? 0;
  const unit = nutrientUnitLabel(data.unit, t);
  const reference = metaKey ? data.reference : null;

  return (
    <Card data-slot={slot}>
      <CardHeader>
        <TileHeader icon={icon} title={title} />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <p className="text-2xl font-bold tabular-nums">
            {fmt.integer(Math.round(todayTotal))} {unit}
          </p>
          {metaKey && reference ? (
            <p className="text-muted-foreground text-xs">
              {t(metaKey, {
                value: fmt.integer(Math.round(reference.value)),
                unit,
                authority: reference.authority ?? "EFSA",
              })}
            </p>
          ) : null}
        </div>
        <NutrientDailyBarChartDynamic
          days={data.days}
          unit={unit}
          valueLabel={title}
          referenceValue={reference?.value ?? null}
          dayLinks
        />
      </CardContent>
    </Card>
  );
}
