"use client";

import { useMemo, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts";
import { Button } from "@/components/ui/button";
import { useViewportWidth } from "@/hooks/use-viewport-width";
import { chooseTickInterval } from "@/lib/charts/x-axis-density";
import { useTranslations } from "@/lib/i18n/context";
import { makeFormatters } from "@/lib/format-locale";

interface DailyData {
  expected: number;
  taken: number;
  skipped: number;
  onTime?: number;
  late?: number;
  veryLate?: number;
}

interface ComplianceLineChartProps {
  dailyCompliance: Record<string, DailyData>;
  rangePoints?: 30 | 90 | 0;
  onRangePointsChange?: (value: 30 | 90 | 0) => void;
  showRangeControls?: boolean;
  /**
   * v1.4.25 W7b — per-user display timezone for the X-axis labels.
   * Defaults to "Europe/Berlin" so older callers keep their previous
   * rendering bit-for-bit.
   */
  userTimezone?: string;
}

const TIME_RANGES = [
  { label: "30M", points: 30, title: "Die dreissig letzten Messpunkte" },
  { label: "90M", points: 90, title: "Die neunzig letzten Messpunkte" },
  { label: "Alle", points: 0, title: "Alle verfuegbaren Messpunkte" },
] as const;

export function ComplianceLineChart({
  dailyCompliance,
  rangePoints,
  onRangePointsChange,
  showRangeControls = true,
  userTimezone = "Europe/Berlin",
}: ComplianceLineChartProps) {
  const [internalRangePoints, setInternalRangePoints] = useState<30 | 90 | 0>(
    30,
  );
  const activeRangePoints = rangePoints ?? internalRangePoints;
  const setActiveRangePoints = onRangePointsChange ?? setInternalRangePoints;
  const viewportWidth = useViewportWidth();
  const { locale } = useTranslations();
  // v1.4.25 W7b — tz-aware date label for the X-axis. Falls back to
  // legacy Europe/Berlin when the prop is omitted.
  const tzFmt = useMemo(
    () => makeFormatters(locale, userTimezone),
    [locale, userTimezone],
  );

  const chartData = useMemo(() => {
    const points = Object.entries(dailyCompliance)
      .filter(([, data]) => data.expected > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dateKey, data]) => {
        const date = new Date(`${dateKey}T12:00:00.000Z`);
        return {
          date: tzFmt.date(date),
          rate: Math.min(100, Math.round((data.taken / data.expected) * 100)),
          timestamp: date.getTime(),
        };
      });

    return activeRangePoints > 0 ? points.slice(-activeRangePoints) : points;
  }, [dailyCompliance, activeRangePoints, tzFmt]);

  return (
    <div>
      {showRangeControls ? (
        <div className="mb-3 flex justify-end gap-1">
          {TIME_RANGES.map((r) => (
            <Button
              key={r.label}
              variant={activeRangePoints === r.points ? "default" : "ghost"}
              size="sm"
              className="min-h-11 px-3 text-xs"
              onClick={() => setActiveRangePoints(r.points)}
              title={r.title}
            >
              {r.label}
            </Button>
          ))}
        </div>
      ) : null}

      {chartData.length === 0 ? (
        <div className="text-muted-foreground flex h-48 items-center justify-center rounded-lg border border-dashed text-sm">
          Keine Daten im gewählten Zeitraum
        </div>
      ) : (
        <div className="touch-pan-y">
          <ResponsiveContainer width="100%" height={180}>
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
                interval={chooseTickInterval(chartData.length, viewportWidth)}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                unit="%"
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--card)",
                  border: "1px solid var(--border)",
                  borderRadius: "0.5rem",
                  fontSize: "0.875rem",
                }}
                formatter={(value) => [`${value}%`, "Compliance"]}
              />
              <ReferenceLine
                y={80}
                stroke="var(--dracula-green)"
                strokeDasharray="5 5"
                strokeOpacity={0.7}
                label={{
                  value: "Ziel 80%",
                  position: "right",
                  fill: "var(--muted-foreground)",
                  fontSize: 10,
                }}
              />
              <Line
                type="monotone"
                dataKey="rate"
                name="Compliance"
                stroke="var(--dracula-purple)"
                strokeWidth={2}
                dot={{ r: 2, fill: "var(--dracula-purple)" }}
                activeDot={{ r: 4 }}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
