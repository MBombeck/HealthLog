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
  ReferenceArea,
} from "recharts";
import { Loader2 } from "lucide-react";
import { useState, useMemo, useId } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { formatDateShort } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import type { DataSummary } from "@/lib/analytics/trends";

// --- Types ---

interface MoodAnalyticsData {
  entries: Array<{ date: string; score: number; samples: number }>;
  summary: DataSummary;
}

interface ChartDataPoint {
  date: string;
  timestamp: number;
  pointIndex: number;
  score: number;
  ma?: number;
  trend?: number;
}

interface MoodChartProps {
  title?: string;
}

// --- Constants ---

const TIME_RANGES_KEYS = [
  { labelKey: "charts.points7Label", points: 7, titleKey: "charts.points7Title" },
  { labelKey: "charts.points30Label", points: 30, titleKey: "charts.points30Title" },
  { labelKey: "charts.points90Label", points: 90, titleKey: "charts.points90Title" },
  { labelKey: "charts.pointsAllLabel", points: 0, titleKey: "charts.pointsAllTitle" },
] as const;

const MOOD_LABELS: Record<number, string> = {
  1: "Lausig",
  2: "Schlecht",
  3: "Okay",
  4: "Gut",
  5: "Super",
};

const VALUE_BANDS = [
  { min: 1, max: 2, color: "#ff5555", opacity: 0.16 },
  { min: 2, max: 3, color: "#ffb86c", opacity: 0.18 },
  { min: 3, max: 5, color: "#50fa7b", opacity: 0.2 },
] as const;

const COLOR_MAIN = "#d6acff";
const COLOR_MA = "#ff79c6";
const COLOR_TREND = "#8be9fd";

// --- Helpers ---

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

function buildTrendLine(
  data: Array<{ date: Date; value: number }>,
): { points: Array<{ date: Date; value: number }>; slopePerDay: number } | null {
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

// --- Component ---

export function MoodChart({ title }: MoodChartProps) {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();
  const [rangePoints, setRangePoints] = useState(30);
  const [showMA, setShowMA] = useState(false);
  const [showTrend, setShowTrend] = useState(false);
  const [showBands, setShowBands] = useState(false);
  const maToggleId = useId();
  const trendToggleId = useId();
  const bandsToggleId = useId();

  const displayTitle = title ?? t("charts.mood");

  const { data, isLoading } = useQuery({
    queryKey: ["mood-chart-data"],
    queryFn: async (): Promise<MoodAnalyticsData> => {
      const res = await fetch("/api/mood/analytics");
      if (!res.ok) throw new Error("Failed to fetch mood analytics");
      const json = await res.json();
      return json.data as MoodAnalyticsData;
    },
    enabled: isAuthenticated,
  });

  const chartData = useMemo((): ChartDataPoint[] | undefined => {
    if (!data?.entries?.length) return undefined;

    const allPoints: ChartDataPoint[] = data.entries
      .map((entry) => ({
        date: formatDateShort(new Date(dayKeyToTimestamp(entry.date))),
        timestamp: dayKeyToTimestamp(entry.date),
        pointIndex: 0,
        score: entry.score,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    const visibleData =
      rangePoints > 0 ? allPoints.slice(-rangePoints) : allPoints;

    const enriched: ChartDataPoint[] = visibleData.map((d, index) => ({
      ...d,
      pointIndex: index,
    }));

    if (showMA) {
      const scoreData = enriched.map((d) => ({
        date: new Date(d.timestamp),
        value: d.score,
      }));

      if (scoreData.length >= 2) {
        const ma = movingAverageByPoints(scoreData, 7);
        for (const point of ma) {
          const pointTimestamp = point.date.getTime();
          const existing = enriched.find(
            (d) => d.timestamp === pointTimestamp,
          );
          if (existing) {
            existing.ma = point.value;
          }
        }
      }
    }

    if (showTrend) {
      const scoreData = enriched.map((d) => ({
        date: new Date(d.timestamp),
        value: d.score,
      }));

      if (scoreData.length >= 2) {
        const trend = buildTrendLine(scoreData);
        if (trend) {
          for (const point of trend.points) {
            const pointTimestamp = point.date.getTime();
            const existing = enriched.find(
              (d) => d.timestamp === pointTimestamp,
            );
            if (existing) {
              existing.trend = point.value;
            }
          }
        }
      }
    }

    return enriched;
  }, [data, rangePoints, showMA, showTrend]);

  const maxPointIndex = Math.max(0, (chartData?.length ?? 1) - 1);

  const formatMoodTick = (value: number): string => {
    return MOOD_LABELS[value] ?? String(value);
  };

  const formatTooltipValue = (value: number): string => {
    const rounded = Math.round(value * 10) / 10;
    const label = MOOD_LABELS[Math.round(value)];
    return label ? `${rounded} (${label})` : String(rounded);
  };

  if (!isLoading && !data?.entries?.length) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-medium">
            {displayTitle}
          </CardTitle>
          <div className="flex gap-1">
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
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-1.5">
            <Switch
              id={maToggleId}
              checked={showMA}
              onCheckedChange={setShowMA}
              className="scale-75"
            />
            <Label htmlFor={maToggleId} className="cursor-pointer text-xs">
              {t("charts.moodMA")}
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
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex h-48 items-center justify-center">
            <Loader2 className="text-primary h-6 w-6 animate-spin" />
          </div>
        ) : !chartData?.length ? (
          <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
            {t("charts.noData")}
          </div>
        ) : (
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartData}
                margin={{ top: 10, right: 8, bottom: 8, left: 8 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="hsl(var(--border))"
                  opacity={0.5}
                />
                {showBands &&
                  VALUE_BANDS.map((band) => (
                    <ReferenceArea
                      key={`band-${band.min}-${band.max}`}
                      y1={band.min}
                      y2={band.max}
                      fill={band.color}
                      fillOpacity={band.opacity}
                      strokeOpacity={0}
                      ifOverflow="discard"
                    />
                  ))}
                <XAxis
                  type="number"
                  dataKey="pointIndex"
                  domain={[0, maxPointIndex]}
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value: number) =>
                    formatDateShort(
                      new Date(
                        chartData[Math.round(value)]?.timestamp ?? Date.now(),
                      ),
                      true,
                    )
                  }
                  interval="preserveStartEnd"
                  padding={{ left: 10, right: 10 }}
                  tickMargin={10}
                />
                <YAxis
                  domain={[1, 5]}
                  ticks={[1, 2, 3, 4, 5]}
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                  width={65}
                  tickMargin={6}
                  tickFormatter={formatMoodTick}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "0.5rem",
                    fontSize: "0.875rem",
                  }}
                  formatter={(value, name) => {
                    if (typeof value !== "number") return String(value);
                    if (name === "score") {
                      return [formatTooltipValue(value), t("charts.moodScore")];
                    }
                    if (name === "ma") {
                      return [formatTooltipValue(value), t("charts.moodMA")];
                    }
                    if (name === "trend") {
                      return [formatTooltipValue(value), t("charts.trend")];
                    }
                    return [String(value), String(name)];
                  }}
                  labelFormatter={(_label, payload) =>
                    payload?.[0]?.payload?.timestamp
                      ? formatDateShort(
                          new Date(
                            (payload[0].payload as ChartDataPoint).timestamp,
                          ),
                          true,
                        )
                      : ""
                  }
                />
                <Line
                  type="monotone"
                  dataKey="score"
                  name="score"
                  stroke={COLOR_MAIN}
                  strokeWidth={2}
                  dot={{ r: 3, fill: COLOR_MAIN }}
                  activeDot={{ r: 5 }}
                  connectNulls
                />
                {showMA && (
                  <Line
                    type="monotone"
                    dataKey="ma"
                    name="ma"
                    stroke={COLOR_MA}
                    strokeWidth={1.5}
                    strokeDasharray="5 5"
                    dot={false}
                    connectNulls
                  />
                )}
                {showTrend && (
                  <Line
                    type="linear"
                    dataKey="trend"
                    name="trend"
                    stroke={COLOR_TREND}
                    strokeWidth={1}
                    strokeDasharray="8 4"
                    dot={false}
                    connectNulls
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
