"use client";

import { TrendingUp } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { useFormatters, useTranslations } from "@/lib/i18n/context";

import type { BiomarkerTrendDto } from "./types";
import { labUnitText } from "@/lib/labs/dimensionless";

/**
 * v1.44 — the marker's slope over all its readings, and where that straight
 * line would leave the reference band.
 *
 * Server-authoritative: every number is the route's (`computeLabTrend`); this
 * only words it. Renders nothing below three readings over a year. The exit
 * sentence names itself a projection, never a forecast.
 */
export function LabTrendCard({
  trend,
  unit,
}: {
  trend: BiomarkerTrendDto | undefined;
  unit: string;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  if (!trend || trend.status !== "ok") return null;

  const digits = Math.abs(trend.slopePerYear) >= 10 ? 0 : 2;
  const per = (v: number) => fmt.number(Math.abs(v), digits);
  const direction =
    trend.slopePerYear > 0
      ? "rising"
      : trend.slopePerYear < 0
        ? "falling"
        : "flat";
  const shownUnit = labUnitText(unit);
  // A value without a unit fills the {unit} slot with a marker and drops it
  // together with the space before it, so no language keeps the gap ("0.3 .",
  // "0.3 씩").
  const SLOT = "\u0000";
  const tidy = (text: string) =>
    shownUnit ? text : text.replace(new RegExp(` ?${SLOT}`, "g"), "");
  const slopeLine = tidy(
    t(`labs.trend.slope.${direction}`, {
      amount: per(trend.slopePerYear),
      unit: shownUnit || SLOT,
      n: trend.n,
      since: fmt.dateShortSmartCalendar(trend.firstAt),
    }),
  );
  const projectionLine =
    trend.projection === "exits" && trend.exitDate
      ? t(`labs.trend.projection.exits.${trend.exitBound ?? "high"}`, {
          date: fmt.dateShortSmartCalendar(trend.exitDate),
        })
      : trend.projection === "no_band"
        ? null
        : trend.projection === "stale"
          ? t("labs.trend.projection.stale", {
              date: fmt.dateShortSmartCalendar(trend.lastAt),
            })
          : trend.projection === "beyond_horizon"
            ? t(
                trend.horizonCapped
                  ? "labs.trend.projection.beyond_horizon_capped"
                  : "labs.trend.projection.beyond_horizon",
                {
                  years: fmt.number(
                    trend.horizonYears,
                    trend.horizonCapped ? 0 : 1,
                  ),
                },
              )
            : t(`labs.trend.projection.${trend.projection}`);

  return (
    <Card data-slot="lab-trend">
      <CardHeader>
        <TileHeader icon={TrendingUp} title={t("labs.trend.title")} />
      </CardHeader>
      <CardContent className="space-y-1">
        <p className="text-sm" data-slot="lab-trend-slope">
          {slopeLine}
        </p>
        {projectionLine ? (
          <p
            className="text-sm"
            data-slot="lab-trend-projection"
            data-projection={trend.projection}
          >
            {projectionLine}
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs">
          {tidy(
            t("labs.trend.interval", {
              lo: fmt.number(trend.slopeCi95[0], 2),
              hi: fmt.number(trend.slopeCi95[1], 2),
              unit: shownUnit || SLOT,
            }),
          )}
        </p>
      </CardContent>
    </Card>
  );
}
