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
} from "recharts";
import { Loader2 } from "lucide-react";
import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { formatDateShort } from "@/lib/format";
import { movingAverage, trendLinePoints } from "@/lib/analytics/trends";

const TIME_RANGES = [
  { label: "7T", days: 7 },
  { label: "30T", days: 30 },
  { label: "90T", days: 90 },
  { label: "Alle", days: 0 },
] as const;

interface HealthChartProps {
  types: string[];
  title: string;
  colors?: string[];
  unit?: string;
}

interface ChartDataPoint {
  date: string;
  timestamp: number;
  [key: string]: string | number;
}

export function HealthChart({
  types,
  title,
  colors = ["#bd93f9", "#ff79c6", "#8be9fd"],
  unit,
}: HealthChartProps) {
  const { isAuthenticated } = useAuth();
  const [rangeDays, setRangeDays] = useState(30);
  const [showMA, setShowMA] = useState(false);
  const [showTrend, setShowTrend] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["chart-data", types.join(","), rangeDays],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", "500");
      if (rangeDays > 0) {
        params.set(
          "from",
          new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString(),
        );
      }

      const allData: ChartDataPoint[] = [];

      for (const type of types) {
        const typeParams = new URLSearchParams(params);
        typeParams.set("type", type);
        const res = await fetch(`/api/measurements?${typeParams}`);
        if (!res.ok) continue;
        const json = await res.json();

        for (const m of json.data.measurements) {
          const dateStr = formatDateShort(m.measuredAt);
          const existing = allData.find((d) => d.date === dateStr);
          if (existing) {
            existing[type] = m.value;
          } else {
            allData.push({
              date: dateStr,
              timestamp: new Date(m.measuredAt).getTime(),
              [type]: m.value,
            });
          }
        }
      }

      return allData.sort((a, b) => a.timestamp - b.timestamp);
    },
    enabled: isAuthenticated,
  });

  const typeLabels: Record<string, string> = {
    WEIGHT: "Gewicht",
    BLOOD_PRESSURE_SYS: "Systolisch",
    BLOOD_PRESSURE_DIA: "Diastolisch",
    PULSE: "Puls",
    BODY_FAT: "Körperfett",
    SLEEP_DURATION: "Schlaf",
    ACTIVITY_STEPS: "Schritte",
  };

  // Compute overlay data (MA + trend) from raw chart data
  const chartData = useMemo(() => {
    if (!data?.length) return data;

    const enriched = data.map((d) => ({ ...d }));

    if (showMA) {
      for (const type of types) {
        const typeData = enriched
          .filter((d) => d[type] !== undefined)
          .map((d) => ({
            date: new Date(d.timestamp),
            value: d[type] as number,
          }));

        if (typeData.length >= 2) {
          const ma = movingAverage(typeData, 7);
          for (const point of ma) {
            const dateStr = formatDateShort(point.date);
            const existing = enriched.find((d) => d.date === dateStr);
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
          const trend = trendLinePoints(typeData, rangeDays || 365);
          if (trend) {
            const startStr = formatDateShort(trend.start.date);
            const endStr = formatDateShort(trend.end.date);
            const startPoint = enriched.find((d) => d.date === startStr);
            const endPoint = enriched.find((d) => d.date === endStr);
            if (startPoint) startPoint[`${type}_trend`] = trend.start.value;
            if (endPoint) endPoint[`${type}_trend`] = trend.end.value;
          }
        }
      }
    }

    return enriched;
  }, [data, showMA, showTrend, types, rangeDays]);

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
      return [min - delta, max + delta];
    }

    const span = max - min;
    const padding = Math.max(span * 0.08, 0.5);
    return [min - padding, max + padding];
  }, [chartData, showMA, showTrend, types]);

  const formatValue = (value: number) =>
    new Intl.NumberFormat("de-DE", {
      maximumFractionDigits: 1,
    }).format(value);

  // Hide entire chart when no data exists (after loading)
  if (!isLoading && !data?.length) return null;

  return (
    <div className="bg-card border-border rounded-xl border p-4 md:p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-semibold">{title}</h3>
        <div className="flex gap-1">
          {TIME_RANGES.map((r) => (
            <Button
              key={r.label}
              variant={rangeDays === r.days ? "default" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setRangeDays(r.days)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Overlay toggles */}
      <div className="text-muted-foreground mb-3 flex items-center gap-4 text-xs">
        <div className="flex items-center gap-1.5">
          <Switch
            id="ma-toggle"
            checked={showMA}
            onCheckedChange={setShowMA}
            className="scale-75"
          />
          <Label htmlFor="ma-toggle" className="cursor-pointer text-xs">
            7T-Schnitt
          </Label>
        </div>
        <div className="flex items-center gap-1.5">
          <Switch
            id="trend-toggle"
            checked={showTrend}
            onCheckedChange={setShowTrend}
            className="scale-75"
          />
          <Label htmlFor="trend-toggle" className="cursor-pointer text-xs">
            Trend
          </Label>
        </div>
      </div>

      {isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="text-primary h-6 w-6 animate-spin" />
        </div>
      ) : !chartData?.length ? null : (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={chartData}>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--border)"
              opacity={0.5}
            />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              domain={yDomain}
              tickFormatter={(value) =>
                typeof value === "number" ? formatValue(value) : String(value)
              }
              unit={unit ? ` ${unit}` : undefined}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: "0.5rem",
                fontSize: "0.875rem",
              }}
              formatter={(value) =>
                typeof value === "number"
                  ? `${formatValue(value)}${unit ? ` ${unit}` : ""}`
                  : value
              }
            />
            {(types.length > 1 || showMA || showTrend) && <Legend />}
            {types.map((type, i) => (
              <Line
                key={type}
                type="monotone"
                dataKey={type}
                name={typeLabels[type] ?? type}
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
                  name={`${typeLabels[type] ?? type} (7T-Schnitt)`}
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
                  name={`${typeLabels[type] ?? type} (Trend)`}
                  stroke="var(--muted-foreground)"
                  strokeWidth={1}
                  strokeDasharray="8 4"
                  dot={false}
                  connectNulls
                />
              ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
