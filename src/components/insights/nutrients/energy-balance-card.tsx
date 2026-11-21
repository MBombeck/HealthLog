"use client";

import { useQuery } from "@tanstack/react-query";
import { Scale } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { TileHeader } from "@/components/insights/tile-header";
import { apiGet } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { formatNutrientAmount } from "@/lib/nutrients/format-amount";
import type { EnergyBalance } from "@/lib/nutrients/energy-balance";
import { queryKeys } from "@/lib/query-keys";

const WINDOW_DAYS = 30;
/** The most recent complete days listed under the headline. */
const LISTED_DAYS = 7;

/**
 * The daily energy balance on `/insights/nutrients`: what was eaten against
 * resting plus active energy, from data that already arrives (no food
 * logging here). Renders only once a day in the window holds an intake.
 *
 * The headline is the latest seven-day trend, else the window mean. Every
 * number is the server's (`GET /api/nutrients/energy-balance`); the card
 * formats and never recomputes. A balance is a signed number, never coloured
 * as good or bad: a deficit is a goal for one person and a warning for
 * another, and the card does not know which.
 */
export function EnergyBalanceCard() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.energyBalance(WINDOW_DAYS),
    queryFn: () =>
      apiGet<EnergyBalance>(
        `/api/nutrients/energy-balance?days=${WINDOW_DAYS}`,
      ),
    staleTime: 60_000,
  });

  if (isError && !data) {
    return (
      <QueryErrorRow
        error={error}
        slot="nutrients-energy-balance-error"
        message={t("nutrients.energyBalance.loadError")}
        onRetry={() => void refetch()}
      />
    );
  }
  if (isLoading || !data) {
    return <Skeleton className="h-40 w-full" aria-hidden="true" />;
  }
  if (!data.days.some((d) => d.intakeKcal !== null)) return null;

  const kcal = (value: number) =>
    `${value > 0 ? "+" : ""}${formatNutrientAmount(fmt, value)} kcal`;
  const complete = data.days.filter((d) => !d.partial);
  const latestTrend = [...complete]
    .reverse()
    .find((d) => d.trendKcal !== null)?.trendKcal;
  const headline = latestTrend ?? data.summary.meanBalanceKcal;
  const estimatedDays = complete.filter(
    (d) => d.restingEstimated && d.balanceKcal !== null,
  ).length;
  const listed = complete
    .filter((d) => d.balanceKcal !== null)
    .slice(-LISTED_DAYS)
    .reverse();

  return (
    <Card data-slot="nutrients-energy-balance-card">
      <CardHeader>
        <TileHeader icon={Scale} title={t("nutrients.energyBalance.title")} />
      </CardHeader>
      <CardContent className="space-y-4">
        {headline === null ? (
          <p className="text-sm" data-slot="nutrients-energy-balance-missing">
            {t(
              data.estimateGaps.length > 0
                ? "nutrients.energyBalance.needsProfile"
                : "nutrients.energyBalance.needsExpenditure",
            )}
          </p>
        ) : (
          <div className="space-y-1">
            <p
              className="text-2xl font-bold tabular-nums"
              data-slot="nutrients-energy-balance-headline"
            >
              {t("nutrients.energyBalance.perDay", { value: kcal(headline) })}
            </p>
            <p className="text-muted-foreground text-xs">
              {latestTrend != null
                ? t("nutrients.energyBalance.trendMeta")
                : t("nutrients.energyBalance.meanMeta", {
                    days: data.summary.daysWithBalance,
                  })}
            </p>
            {data.summary.meanIntakeKcal !== null &&
            data.summary.meanExpenditureKcal !== null ? (
              <p className="text-muted-foreground text-xs">
                {t("nutrients.energyBalance.means", {
                  days: data.summary.daysWithBalance,
                  intake: formatNutrientAmount(
                    fmt,
                    data.summary.meanIntakeKcal,
                  ),
                  used: formatNutrientAmount(
                    fmt,
                    data.summary.meanExpenditureKcal,
                  ),
                })}
              </p>
            ) : null}
          </div>
        )}
        {listed.length > 0 ? (
          <ul
            className="divide-border divide-y text-sm"
            data-slot="nutrients-energy-balance-days"
          >
            {listed.map((d) => (
              <li
                key={d.day}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-2"
              >
                <span>{fmt.dateShortSmartCalendar(d.day)}</span>
                <span className="font-medium tabular-nums">
                  {kcal(d.balanceKcal as number)}
                </span>
                <span className="text-muted-foreground col-span-2 text-xs">
                  {t("nutrients.energyBalance.dayLine", {
                    intake: formatNutrientAmount(fmt, d.intakeKcal as number),
                    used: formatNutrientAmount(
                      fmt,
                      d.expenditureKcal as number,
                    ),
                  })}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {estimatedDays > 0 ? (
          <p className="text-muted-foreground text-xs">
            {t("nutrients.energyBalance.estimated", { days: estimatedDays })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
