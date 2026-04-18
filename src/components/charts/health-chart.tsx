"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ReferenceArea,
} from "recharts";
import { Loader2 } from "lucide-react";
import { useState, useMemo, useId } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { formatDateShort } from "@/lib/format";
import { useTranslations, useFormatters } from "@/lib/i18n/context";

const TIME_RANGES_KEYS = [
  {
    labelKey: "charts.points7Label",
    points: 7,
    titleKey: "charts.points7Title",
  },
  {
    labelKey: "charts.points30Label",
    points: 30,
    titleKey: "charts.points30Title",
  },
  {
    labelKey: "charts.points90Label",
    points: 90,
    titleKey: "charts.points90Title",
  },
  {
    labelKey: "charts.pointsAllLabel",
    points: 0,
    titleKey: "charts.pointsAllTitle",
  },
] as const;

interface HealthChartProps {
  types: string[];
  title: string;
  colors?: string[];
  unit?: string;
  yAxisUnit?: string;
  valueMode?: "raw" | "bmi";
  yAxisWidth?: number;
  showYAxisUnit?: boolean;
  valueBands?: Array<{
    min: number;
    max: number;
    color: string;
    opacity?: number;
    strokeOpacity?: number;
  }>;
  targetZones?: Array<{
    min: number;
    max: number;
    color: string;
    opacity?: number;
    label?: string;
    textColor?: string;
    lineOpacity?: number;
  }>;
}

interface ChartDataPoint {
  date: string;
  timestamp: number;
  pointIndex?: number;
  [key: string]: string | number | undefined;
}

interface MeasurementApiRow {
  measuredAt: string;
  value: number;
}

interface VisibleTargetZone {
  key: string;
  low: number;
  high: number;
  topPct: number;
  heightPct: number;
  color: string;
  opacity: number;
  label: string | undefined;
  textColor: string | undefined;
  lineOpacity: number;
}

const BASE_TYPE_LABEL_KEYS: Record<string, string> = {
  WEIGHT: "charts.weight",
  BLOOD_PRESSURE_SYS: "charts.systolic",
  BLOOD_PRESSURE_DIA: "charts.diastolic",
  PULSE: "charts.pulse",
  BODY_FAT: "charts.bodyFat",
  SLEEP_DURATION: "charts.sleep",
  ACTIVITY_STEPS: "charts.steps",
  BLOOD_GLUCOSE: "measurements.typeBloodGlucose",
};

function getTypeLabel(
  type: string,
  valueMode: "raw" | "bmi",
  t: (key: string) => string,
): string {
  if (type === "WEIGHT" && valueMode === "bmi") {
    return "BMI";
  }
  const key = BASE_TYPE_LABEL_KEYS[type];
  return key ? t(key) : type;
}

const BERLIN_DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function toBerlinDayKey(value: string): string {
  const parts = BERLIN_DAY_FORMATTER.formatToParts(new Date(value));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error("Could not derive day key for chart");
  }

  return `${year}-${month}-${day}`;
}

function dayKeyToTimestamp(dayKey: string): number {
  const [year, month, day] = dayKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day, 12, 0, 0);
}

function movingAverageByPoints(
  data: Array<{ date: Date; value: number }>,
  windowSize: number,
): Array<{ date: Date; value: number }> {
  if (data.length === 0) return [];

  const sorted = [...data].sort((a, b) => a.date.getTime() - b.date.getTime());

  return sorted.map((point, index) => {
    const start = Math.max(0, index - windowSize + 1);
    const window = sorted.slice(start, index + 1);
    const avg =
      window.reduce((sum, item) => sum + item.value, 0) / window.length;
    return {
      date: point.date,
      value: Math.round(avg * 100) / 100,
    };
  });
}

function buildTrendSeriesByTime(data: Array<{ date: Date; value: number }>): {
  points: Array<{ date: Date; value: number }>;
  slopePerDay: number;
} | null {
  if (data.length < 2) return null;

  const sorted = [...data].sort((a, b) => a.date.getTime() - b.date.getTime());
  const startTime = sorted[0].date.getTime();
  const points = sorted.map((p) => ({
    x: (p.date.getTime() - startTime) / 86400000,
    y: p.value,
  }));

  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);

  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return null;

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  return {
    points: sorted.map((p) => ({
      date: p.date,
      value:
        Math.round(
          (intercept + slope * ((p.date.getTime() - startTime) / 86400000)) *
            100,
        ) / 100,
    })),
    slopePerDay: slope,
  };
}

export function HealthChart({
  types,
  title,
  colors = ["#bd93f9", "#ff79c6", "#8be9fd"],
  unit,
  yAxisUnit,
  valueMode = "raw",
  yAxisWidth = 76,
  showYAxisUnit = true,
  valueBands,
  targetZones,
}: HealthChartProps) {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();
  const fmt = useFormatters();
  const [rangePoints, setRangePoints] = useState(30);
  const [showMA, setShowMA] = useState(false);
  const [showTrend, setShowTrend] = useState(false);
  const [showBands, setShowBands] = useState(false);
  const maToggleId = useId();
  const trendToggleId = useId();
  const bandsToggleId = useId();

  const bmiDivisor =
    valueMode === "bmi" && user?.heightCm ? (user.heightCm / 100) ** 2 : null;

  const { data, isLoading } = useQuery({
    queryKey: [
      "chart-data",
      types.join(","),
      valueMode,
      bmiDivisor ?? "no-bmi",
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("sortBy", "measuredAt");
      params.set("sortDir", "asc");

      const dailyAggregates = new Map<
        string,
        {
          timestamp: number;
          values: Record<string, { sum: number; count: number }>;
        }
      >();

      async function fetchAllMeasurementsByType(type: string) {
        const pageSize = 500;
        let offset = 0;

        while (true) {
          const typeParams = new URLSearchParams(params);
          typeParams.set("type", type);
          typeParams.set("limit", String(pageSize));
          typeParams.set("offset", String(offset));

          const res = await fetch(`/api/measurements?${typeParams}`);
          if (!res.ok) break;

          const json = await res.json();
          const page = (json.data?.measurements ?? []) as MeasurementApiRow[];
          const total = Number(json.data?.meta?.total ?? page.length);

          for (const measurement of page) {
            const rawValue = measurement.value;
            const value =
              valueMode === "bmi"
                ? bmiDivisor
                  ? rawValue / bmiDivisor
                  : null
                : rawValue;

            if (value == null || !Number.isFinite(value)) {
              continue;
            }

            const dayKey = toBerlinDayKey(measurement.measuredAt);
            const bucket = dailyAggregates.get(dayKey) ?? {
              timestamp: dayKeyToTimestamp(dayKey),
              values: {},
            };
            const current = bucket.values[type] ?? { sum: 0, count: 0 };
            current.sum += value;
            current.count += 1;
            bucket.values[type] = current;
            dailyAggregates.set(dayKey, bucket);
          }

          offset += page.length;
          if (page.length === 0 || offset >= total || page.length < pageSize) {
            break;
          }
        }
      }

      await Promise.all(types.map(fetchAllMeasurementsByType));

      const allData: ChartDataPoint[] = Array.from(dailyAggregates.values())
        .map((bucket) => {
          const point: ChartDataPoint = {
            date: formatDateShort(new Date(bucket.timestamp)),
            timestamp: bucket.timestamp,
          };

          for (const [type, stats] of Object.entries(bucket.values)) {
            point[type] = stats.sum / stats.count;
          }

          return point;
        })
        .sort((a, b) => a.timestamp - b.timestamp);

      return allData;
    },
    enabled: isAuthenticated,
  });

  const chartData = useMemo(() => {
    if (!data?.length) return data;

    const visibleData = rangePoints > 0 ? data.slice(-rangePoints) : [...data];
    const enriched: ChartDataPoint[] = visibleData.map((d, index) => ({
      ...d,
      pointIndex: index,
    }));

    if (showMA) {
      for (const type of types) {
        const typeData = enriched
          .filter((d) => d[type] !== undefined)
          .map((d) => ({
            date: new Date(d.timestamp),
            value: d[type] as number,
          }));

        if (typeData.length >= 2) {
          const ma = movingAverageByPoints(typeData, 7);
          for (const point of ma) {
            const pointTimestamp = point.date.getTime();
            const existing = enriched.find(
              (d) => d.timestamp === pointTimestamp,
            );
            if (existing) {
              existing[`${type}_ma`] = point.value;
            }
          }
        }
      }
    }

    if (showTrend) {
      for (const type of types) {
        const typeData = enriched
          .filter((d) => d[type] !== undefined)
          .map((d) => ({
            date: new Date(d.timestamp),
            value: d[type] as number,
          }));

        if (typeData.length >= 2) {
          const trend = buildTrendSeriesByTime(typeData);
          if (trend) {
            for (const point of trend.points) {
              const pointTimestamp = point.date.getTime();
              const existing = enriched.find(
                (d) => d.timestamp === pointTimestamp,
              );
              if (existing) {
                existing[`${type}_trend`] = point.value;
              }
            }
          }
        }
      }
    }

    return enriched;
  }, [data, rangePoints, showMA, showTrend, types]);

  const yDomain = useMemo<[number, number] | undefined>(() => {
    if (!chartData?.length) return undefined;

    const keys = [...types];
    if (showMA) keys.push(...types.map((type) => `${type}_ma`));
    if (showTrend) keys.push(...types.map((type) => `${type}_trend`));

    const values = chartData
      .flatMap((point) => keys.map((key) => point[key]))
      .filter((value): value is number => typeof value === "number")
      .filter((value) => Number.isFinite(value));

    if (!values.length) return undefined;

    const min = Math.min(...values);
    const max = Math.max(...values);

    if (min === max) {
      const delta = Math.max(Math.abs(min) * 0.05, 1);
      return [min - delta, max + delta * 1.35];
    }

    const span = max - min;
    const paddingBottom = Math.max(span * 0.08, 0.5);
    const paddingTop = Math.max(span * 0.16, 1);
    return [min - paddingBottom, max + paddingTop];
  }, [chartData, showMA, showTrend, types]);

  const visibleBands = useMemo(() => {
    if (!showBands || !valueBands?.length || !yDomain) return [];

    const [domainMin, domainMax] = yDomain;
    const span = domainMax - domainMin;
    if (!Number.isFinite(span) || span <= 0) return [];

    return valueBands
      .map((band, index) => {
        const low = Math.max(Math.min(band.min, band.max), domainMin);
        const high = Math.min(Math.max(band.min, band.max), domainMax);
        if (high <= low) return null;

        const topPct = ((domainMax - high) / span) * 100;
        const heightPct = ((high - low) / span) * 100;

        return {
          key: `${band.min}-${band.max}-${index}`,
          topPct,
          heightPct,
          color: band.color,
          opacity: band.opacity ?? 0.2,
          strokeOpacity: band.strokeOpacity ?? 0.35,
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          key: string;
          topPct: number;
          heightPct: number;
          color: string;
          opacity: number;
          strokeOpacity: number;
        } => entry !== null && entry.heightPct > 0,
      );
  }, [showBands, valueBands, yDomain]);

  const visibleTargetZones = useMemo<VisibleTargetZone[]>(() => {
    if (!showBands || !targetZones?.length || !yDomain) return [];
    const [domainMin, domainMax] = yDomain;
    const span = domainMax - domainMin;
    if (!Number.isFinite(span) || span <= 0) return [];

    const zones: Array<{
      key: string;
      low: number;
      high: number;
      topPct: number;
      heightPct: number;
      color: string;
      opacity: number;
      label: string | undefined;
      textColor: string | undefined;
      lineOpacity: number;
    }> = [];

    for (const [index, zone] of targetZones.entries()) {
      const low = Math.max(Math.min(zone.min, zone.max), domainMin);
      const high = Math.min(Math.max(zone.min, zone.max), domainMax);
      if (high <= low) continue;
      const topPct = ((domainMax - high) / span) * 100;
      const heightPct = ((high - low) / span) * 100;

      zones.push({
        key: `${zone.min}-${zone.max}-${index}`,
        low,
        high,
        topPct,
        heightPct,
        color: zone.color,
        opacity: zone.opacity ?? 0.3,
        label: zone.label ?? undefined,
        textColor: zone.textColor ?? undefined,
        lineOpacity: zone.lineOpacity ?? 0.42,
      });
    }

    return zones;
  }, [showBands, targetZones, yDomain]);

  const formatAxisValue = (value: number) => fmt.integer(value);

  const formatTooltipValue = (value: number) => fmt.number(value, 1);

  const trendInfo = useMemo(() => {
    if (!showTrend || !chartData?.length) return [];

    const formatSigned = (value: number) => {
      const formatted = fmt.number(Math.abs(value), 1);
      return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatted}`;
    };

    return types
      .map((type) => {
        const series = chartData.filter(
          (point) =>
            typeof point[type] === "number" &&
            typeof point[`${type}_trend`] === "number",
        );
        if (series.length < 2) return null;

        const first = series[0];
        const last = series[series.length - 1];
        const days = (last.timestamp - first.timestamp) / 86400000;
        if (!Number.isFinite(days) || days <= 0) return null;

        const firstTrend = first[`${type}_trend`] as number;
        const lastTrend = last[`${type}_trend`] as number;
        const weeklyDelta = ((lastTrend - firstTrend) / days) * 7;
        const base = first[type] as number;
        const weeklyPct =
          Math.abs(base) > Number.EPSILON
            ? (weeklyDelta / Math.abs(base)) * 100
            : null;
        const unitSuffix = unit ? ` ${unit}` : "";

        return `${getTypeLabel(type, valueMode, t)}: ${formatSigned(
          weeklyDelta,
        )}${unitSuffix}${t("charts.perWeek")}${
          weeklyPct != null
            ? ` (${formatSigned(weeklyPct)} %${t("charts.perWeek")})`
            : ""
        }`;
      })
      .filter((entry): entry is string => entry !== null);
  }, [chartData, showTrend, types, unit, valueMode, t, fmt]);

  if (!isLoading && !data?.length) return null;

  const maxPointIndex = Math.max(0, (chartData?.length ?? 1) - 1);
  const showContextDetails = showMA || showTrend || showBands;

  return (
    <div className="bg-card border-border rounded-xl border p-4 md:p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="flex flex-wrap justify-end gap-1">
          {TIME_RANGES_KEYS.map((r) => (
            <Button
              key={r.labelKey}
              variant={rangePoints === r.points ? "default" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setRangePoints(r.points)}
              title={t(r.titleKey)}
            >
              {t(r.labelKey)}
            </Button>
          ))}
        </div>
      </div>

      <div className="text-muted-foreground mb-3 flex items-center gap-4 text-xs">
        <div className="flex items-center gap-1.5">
          <Switch
            id={maToggleId}
            checked={showMA}
            onCheckedChange={setShowMA}
            className="scale-75"
          />
          <Label htmlFor={maToggleId} className="cursor-pointer text-xs">
            {t("charts.movingAverage7d")}
          </Label>
        </div>
        <div className="flex items-center gap-1.5">
          <Switch
            id={trendToggleId}
            checked={showTrend}
            onCheckedChange={setShowTrend}
            className="scale-75"
          />
          <Label htmlFor={trendToggleId} className="cursor-pointer text-xs">
            {t("charts.trend")}
          </Label>
        </div>
        {valueBands?.length || targetZones?.length ? (
          <div className="flex items-center gap-1.5">
            <Switch
              id={bandsToggleId}
              checked={showBands}
              onCheckedChange={setShowBands}
              className="scale-75"
            />
            <Label htmlFor={bandsToggleId} className="cursor-pointer text-xs">
              {t("charts.targetRanges")}
            </Label>
          </div>
        ) : null}
      </div>

      {showTrend && trendInfo.length > 0 ? (
        <div className="text-muted-foreground mb-3 flex flex-wrap gap-3 text-xs">
          {trendInfo.map((info) => (
            <span key={info}>{info}</span>
          ))}
        </div>
      ) : null}

      {isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="text-primary h-6 w-6 animate-spin" />
        </div>
      ) : !chartData?.length ? null : (
        <div className="relative h-[240px]">
          {visibleBands.length > 0 ? (
            <div
              className="pointer-events-none absolute"
              style={{
                left: `${8 + yAxisWidth}px`,
                right: "18px",
                top: "10px",
                bottom: "32px",
                zIndex: 0,
              }}
            >
              {visibleBands.map((band) => (
                <div
                  key={band.key}
                  className="absolute right-0 left-0"
                  style={{
                    top: `${band.topPct}%`,
                    height: `${band.heightPct}%`,
                    backgroundColor: band.color,
                    opacity: band.opacity,
                    borderTop: `1px solid ${band.color}`,
                    borderBottom: `1px solid ${band.color}`,
                  }}
                />
              ))}
            </div>
          ) : null}

          <div className="relative z-10 h-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartData}
                margin={{ top: 10, right: 8, bottom: 8, left: 8 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--border)"
                  opacity={0.5}
                />
                <XAxis
                  type="number"
                  dataKey="pointIndex"
                  domain={[0, maxPointIndex]}
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) =>
                    formatDateShort(
                      new Date(
                        chartData?.[Math.round(value)]?.timestamp ?? Date.now(),
                      ),
                      true,
                    )
                  }
                  interval="preserveStartEnd"
                  padding={{ left: 10, right: 10 }}
                  tickMargin={10}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                  width={yAxisWidth}
                  tickMargin={10}
                  domain={yDomain}
                  tickFormatter={(value) =>
                    typeof value === "number"
                      ? formatAxisValue(Math.round(value))
                      : String(value)
                  }
                  unit={
                    showYAxisUnit && (yAxisUnit ?? unit)
                      ? ` ${yAxisUnit ?? unit}`
                      : undefined
                  }
                />
                {visibleTargetZones.map((zone) => (
                  <ReferenceArea
                    key={`${zone.key}-fill`}
                    x1={0}
                    x2={maxPointIndex}
                    y1={zone.low}
                    y2={zone.high}
                    fill={zone.color}
                    fillOpacity={zone.opacity}
                    strokeOpacity={0}
                    ifOverflow="discard"
                  />
                ))}
                {visibleTargetZones.map((zone) => (
                  <ReferenceLine
                    key={`${zone.key}-low`}
                    y={zone.low}
                    stroke={zone.color}
                    strokeDasharray="6 4"
                    strokeWidth={1.75}
                    strokeOpacity={zone.lineOpacity}
                  />
                ))}
                {visibleTargetZones.map((zone) => (
                  <ReferenceLine
                    key={`${zone.key}-high`}
                    y={zone.high}
                    stroke={zone.color}
                    strokeDasharray="6 4"
                    strokeWidth={1.75}
                    strokeOpacity={zone.lineOpacity}
                    label={
                      zone.label
                        ? {
                            value: zone.label,
                            position: "right",
                            fill: zone.textColor ?? zone.color,
                            fontSize: 10,
                          }
                        : undefined
                    }
                  />
                ))}
                <Tooltip
                  filterNull={false}
                  contentStyle={{
                    backgroundColor: "var(--card)",
                    border: "1px solid var(--border)",
                    borderRadius: "0.5rem",
                    fontSize: "0.875rem",
                  }}
                  formatter={(value) =>
                    typeof value === "number"
                      ? `${formatTooltipValue(value)}${unit ? ` ${unit}` : ""}`
                      : value
                  }
                  labelFormatter={(_label, payload) =>
                    payload?.[0]?.payload?.timestamp
                      ? formatDateShort(
                          new Date(payload[0].payload.timestamp),
                          true,
                        )
                      : ""
                  }
                />
                {showContextDetails && (
                  <Legend
                    wrapperStyle={{
                      fontSize: "0.875rem",
                      fontFamily: "inherit",
                      fontWeight: "normal",
                    }}
                  />
                )}
                {types.map((type, i) => (
                  <Line
                    key={type}
                    type="monotone"
                    dataKey={type}
                    name={getTypeLabel(type, valueMode, t)}
                    stroke={colors[i % colors.length]}
                    strokeWidth={2}
                    dot={{ r: 3, fill: colors[i % colors.length] }}
                    activeDot={{ r: 5 }}
                    connectNulls
                  />
                ))}
                {showMA &&
                  types.map((type, i) => (
                    <Line
                      key={`${type}_ma`}
                      type="monotone"
                      dataKey={`${type}_ma`}
                      name={`${getTypeLabel(type, valueMode, t)} (${t("charts.movingAverage7d")})`}
                      stroke={colors[i % colors.length]}
                      strokeWidth={1.5}
                      strokeDasharray="5 5"
                      strokeOpacity={0.7}
                      dot={false}
                      connectNulls
                    />
                  ))}
                {showTrend &&
                  types.map((type) => (
                    <Line
                      key={`${type}_trend`}
                      type="linear"
                      dataKey={`${type}_trend`}
                      name={`${getTypeLabel(type, valueMode, t)} (${t("charts.trend")})`}
                      stroke="var(--muted-foreground)"
                      strokeWidth={1}
                      strokeDasharray="8 4"
                      dot={false}
                      connectNulls
                    />
                  ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
