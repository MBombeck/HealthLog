"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { formatDateShort } from "@/lib/format";

const TIME_RANGES = [
  { label: "7T", days: 7 },
  { label: "30T", days: 30 },
  { label: "90T", days: 90 },
  { label: "Alle", days: 0 },
] as const;

const COLORS = [
  "#8be9fd",
  "#bd93f9",
  "#ff79c6",
  "#50fa7b",
  "#ffb86c",
  "#f1fa8c",
  "#ff5555",
];

interface IntakeSummaryPoint {
  date: string;
  total: number;
  medications: Record<string, number>;
}

interface IntakeSummaryResponse {
  points: IntakeSummaryPoint[];
  medications: string[];
}

type ChartPoint = {
  date: string;
  timestamp: number;
  total: number;
} & Record<string, string | number>;

export function MedicationIntakeChart() {
  const { isAuthenticated } = useAuth();
  const [rangeDays, setRangeDays] = useState(30);

  const { data, isLoading } = useQuery({
    queryKey: ["chart-data", "medication-intake", rangeDays],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (rangeDays > 0) {
        params.set(
          "from",
          new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString(),
        );
      }
      const url = params.size
        ? `/api/medications/intake-summary?${params.toString()}`
        : "/api/medications/intake-summary";

      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch medication intake summary");

      const json = await res.json();
      const payload = json.data as IntakeSummaryResponse;

      const points: ChartPoint[] = payload.points.map((point) => ({
        date: formatDateShort(point.date),
        timestamp: new Date(point.date).getTime(),
        total: point.total,
        ...point.medications,
      }));

      return {
        points,
        medications: payload.medications,
      };
    },
    enabled: isAuthenticated,
  });

  if (!isLoading && !data?.points.length) return null;

  return (
    <div className="bg-card border-border rounded-xl border p-4 md:p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-semibold">Medikamenten-Einnahmen</h3>
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
      ) : !data?.points.length ? null : (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={data.points}>
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
              minTickGap={18}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: "0.5rem",
                fontSize: "0.875rem",
              }}
              formatter={(value) =>
                typeof value === "number" ? `${value} Einnahmen` : value
              }
            />
            {data.medications.length > 1 && <Legend />}
            {data.medications.map((name, index) => (
              <Bar
                key={name}
                dataKey={name}
                name={name}
                stackId="intakes"
                fill={COLORS[index % COLORS.length]}
                radius={
                  index === data.medications.length - 1 ? [4, 4, 0, 0] : undefined
                }
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
