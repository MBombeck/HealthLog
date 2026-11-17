"use client";

import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { TileHeader } from "@/components/insights/tile-header";
import { NutrientDailyBarChartDynamic } from "@/components/charts/nutrient-daily-bar-chart-dynamic";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { formatNutrientAmount } from "@/lib/nutrients/format-amount";
import type { NutrientDailySeries, NutrientIntakeOverview } from "./types";
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
 * Whether the card exists comes from the page's overview read, which lists
 * only the codes with data in the window: the page mounts the cards once it
 * is in, so this card paints its frame and a skeleton straight away rather
 * than popping in under its siblings when its own series lands. Most
 * accounts never log these, and for them the card is never drawn. A failed
 * read says so with a retry, instead of passing for a month without data; it
 * is its own read, so the hydration card's notice does not cover it.
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

  const overview = useQuery({
    queryKey: queryKeys.nutrientIntake(WINDOW_DAYS),
    queryFn: () =>
      apiGet<NutrientIntakeOverview>(`/api/nutrients?days=${WINDOW_DAYS}`),
  });
  const logged = (overview.data?.nutrients ?? []).some(
    (row) => row.nutrient === code,
  );

  const { data, error, isError, isLoading, refetch } = useQuery({
    queryKey: queryKeys.nutrientDaily(code, WINDOW_DAYS),
    queryFn: () =>
      apiGet<NutrientDailySeries>(
        `/api/nutrients/daily?nutrient=${code}&days=${WINDOW_DAYS}`,
      ),
    // The "route swing within a minute is a free cache hit" convention used
    // across the insights queries.
    staleTime: 60_000,
    enabled: logged,
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

  if (!logged) return null;
  if (isLoading || !data) {
    return (
      <Card data-slot={slot}>
        <CardHeader>
          <TileHeader icon={icon} title={title} />
        </CardHeader>
        <CardContent className="space-y-3" aria-hidden="true">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-[240px] w-full" />
        </CardContent>
      </Card>
    );
  }
  const hasData = data.days.some((d) => d.amount > 0);
  if (!hasData) return null;

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
            {formatNutrientAmount(fmt, todayTotal)} {unit}
          </p>
          {metaKey && reference ? (
            <p className="text-muted-foreground text-xs">
              {t(metaKey, {
                value: formatNutrientAmount(fmt, reference.value),
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
