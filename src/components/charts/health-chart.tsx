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
import { useState } from "react";
import { Button } from "@/components/ui/button";

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
          const dateStr = new Date(m.measuredAt).toLocaleDateString("de-DE", {
            timeZone: "Europe/Berlin",
            day: "2-digit",
            month: "2-digit",
          });
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

      {isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="text-primary h-6 w-6 animate-spin" />
        </div>
      ) : !data?.length ? (
        <div className="text-muted-foreground flex h-48 items-center justify-center rounded-lg border border-dashed text-sm">
          Keine Daten im gewählten Zeitraum
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={data}>
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
              unit={unit ? ` ${unit}` : undefined}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: "0.5rem",
                fontSize: "0.875rem",
              }}
            />
            {types.length > 1 && <Legend />}
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
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
