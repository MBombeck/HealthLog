"use client";

import type { ReactNode } from "react";

import type { useFormatters } from "@/lib/i18n/context";
import type { ComparisonBaseline } from "@/lib/dashboard-layout";
import { usesHourlyMeanDay } from "@/lib/measurements/day-statistic";

import { RichChartTooltip, type RichTooltipRow } from "../chart-tooltip";

import type { ChartDataPoint } from "./types";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

interface TooltipPayloadItem {
  name?: string;
  value?: number;
  color?: string;
  dataKey?: string;
  payload?: ChartDataPoint;
}

/**
 * The tooltip's `content` renderer. One row per series under the cursor,
 * with a delta: against the prior period when the comparison is on and the
 * day has a prior value (and the prior value as its own row), otherwise
 * against the personal baseline. The auxiliary lines (`*_ma`, `*_trend`,
 * `*_compare`) are skipped: the comparison shows up as the delta, and the
 * average and trend are already drawn as dashed overlays.
 */
export function makeTooltipContent({
  chartData,
  dayLinkSource,
  personalBaselines,
  compareBaseline,
  bucketCaption,
  unit,
  t,
  fmt,
  dateLabelFor,
  formatValue,
  tooltipAction,
}: {
  chartData: ChartDataPoint[] | undefined;
  dayLinkSource: ChartDataPoint[] | undefined;
  personalBaselines: Map<string, number>;
  compareBaseline: ComparisonBaseline;
  bucketCaption: string | null;
  unit?: string;
  t: Translate;
  fmt: ReturnType<typeof useFormatters>;
  dateLabelFor: (date: Date) => string;
  formatValue: (value: number) => string;
  tooltipAction: (index: number | undefined) => ReactNode | undefined;
}) {
  const unitSuffix = unit ? ` ${unit}` : "";
  const signedDelta = (diff: number) => {
    const sign = diff > 0 ? "+" : "−";
    return `${sign}${fmt.number(Math.abs(diff), 1)}${unitSuffix}`;
  };

  return function TooltipContent(props: unknown) {
    const {
      active,
      payload,
      label: rechartsLabel,
    } = props as {
      active?: boolean;
      payload?: TooltipPayloadItem[];
      label?: number;
    };
    if (!active || !payload?.length) return null;
    const ts =
      payload[0]?.payload?.timestamp ??
      (typeof rechartsLabel === "number"
        ? chartData?.[Math.round(rechartsLabel)]?.timestamp
        : undefined);
    const dateLabel = ts ? dateLabelFor(new Date(ts)) : "";
    const rows: RichTooltipRow[] = [];
    // The current and prior values of the hovered day come from the same
    // payload object.
    const hoverPoint = payload[0]?.payload as ChartDataPoint | undefined;
    for (const item of payload) {
      if (typeof item.value !== "number") continue;
      const dataKey = String(item.dataKey ?? "");
      if (
        dataKey.endsWith("_ma") ||
        dataKey.endsWith("_trend") ||
        dataKey.endsWith("_compare")
      )
        continue;
      const baseline = personalBaselines.get(dataKey);
      let delta: string | undefined;
      const compareValue =
        compareBaseline !== "none" && hoverPoint
          ? (hoverPoint[`${dataKey}_compare`] as number | undefined)
          : undefined;
      if (
        compareBaseline !== "none" &&
        typeof compareValue === "number" &&
        Number.isFinite(compareValue)
      ) {
        const diff = item.value - compareValue;
        delta =
          Math.abs(diff) < 0.05
            ? t("charts.deltaUnchanged")
            : t(
                compareBaseline === "lastMonth"
                  ? "comparison.deltaVs.lastMonth"
                  : "comparison.deltaVs.lastYear",
              ).replace("{delta}", signedDelta(diff));
      } else if (baseline != null) {
        const diff = item.value - baseline;
        delta =
          Math.abs(diff) < 0.05
            ? t("charts.deltaUnchanged")
            : t("charts.deltaVsBaseline").replace("{delta}", signedDelta(diff));
      }
      rows.push({
        // Name the statistic where it is not the plain mean of the readings:
        // a day of pulse is the mean of its hours' means.
        name: usesHourlyMeanDay(dataKey)
          ? t("charts.tooltipHourlyMean", {
              metric: item.name ?? dataKey,
            })
          : (item.name ?? dataKey),
        value: `${formatValue(item.value)}${unitSuffix}`,
        color: item.color ?? "var(--dracula-purple)",
        delta,
      });
      if (
        compareBaseline !== "none" &&
        typeof compareValue === "number" &&
        Number.isFinite(compareValue)
      ) {
        rows.push({
          name: `${item.name ?? dataKey} · ${t("comparison.tooltipPrior")}`,
          value: `${formatValue(compareValue)}${unitSuffix}`,
          color: item.color ?? "var(--dracula-purple)",
        });
      }
    }
    if (rows.length === 0) return null;
    return (
      <RichChartTooltip
        active
        label={bucketCaption ? `${dateLabel} · ${t(bucketCaption)}` : dateLabel}
        rows={rows}
        action={tooltipAction(
          hoverPoint ? dayLinkSource?.indexOf(hoverPoint) : undefined,
        )}
      />
    );
  };
}
