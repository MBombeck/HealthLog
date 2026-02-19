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
import { formatDateShort } from "@/lib/format";

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
}

const TIME_RANGES = [
  { label: "30T", days: 30 },
  { label: "90T", days: 90 },
] as const;

export function ComplianceLineChart({
  dailyCompliance,
}: ComplianceLineChartProps) {
  const [rangeDays, setRangeDays] = useState<30 | 90>(30);

  const chartData = useMemo(() => {
    const now = new Date();
    const points: Array<{ date: string; rate: number; timestamp: number }> = [];

    for (let d = rangeDays - 1; d >= 0; d--) {
      const date = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
      const dateKey = date.toISOString().slice(0, 10);
      const data = dailyCompliance[dateKey];

      if (data && data.expected > 0) {
        points.push({
          date: formatDateShort(date),
          rate: Math.round((data.taken / data.expected) * 100),
          timestamp: date.getTime(),
        });
      }
    }

    return points;
  }, [dailyCompliance, rangeDays]);

  return (
    <div>
      <div className="mb-3 flex justify-end gap-1">
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

      {chartData.length === 0 ? (
        <div className="text-muted-foreground flex h-48 items-center justify-center rounded-lg border border-dashed text-sm">
          Keine Daten im gewählten Zeitraum
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
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
      )}
    </div>
  );
}
