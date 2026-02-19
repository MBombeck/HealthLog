"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Activity, Heart, Pill, TrendingUp } from "lucide-react";
import { TrendCard } from "@/components/charts/trend-card";
import { HealthChart } from "@/components/charts/health-chart";
import { InsightsCard } from "@/components/insights/insights-card";
import type { DataSummary } from "@/lib/analytics/trends";

interface AnalyticsData {
  summaries: Record<string, DataSummary>;
  bmi: number | null;
  bpInTargetPct: number | null;
}

export default function DashboardPage() {
  const { isAuthenticated } = useAuth();

  const { data } = useQuery({
    queryKey: ["analytics"],
    queryFn: async () => {
      const res = await fetch("/api/analytics");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as AnalyticsData;
    },
    enabled: isAuthenticated,
  });

  const w = data?.summaries.WEIGHT;
  const sys = data?.summaries.BLOOD_PRESSURE_SYS;
  const p = data?.summaries.PULSE;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground text-sm">
          Dein Gesundheitsüberblick
          {data?.bmi && ` — BMI: ${data.bmi}`}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <TrendCard
          label="Gewicht"
          latest={w?.latest ?? null}
          unit="kg"
          avg7={w?.avg7 ?? null}
          avg30={w?.avg30 ?? null}
          slope30={w?.slope30 ?? null}
          icon={Activity}
        />
        <TrendCard
          label="Blutdruck (Sys)"
          latest={sys?.latest ?? null}
          unit="mmHg"
          avg7={sys?.avg7 ?? null}
          avg30={sys?.avg30 ?? null}
          slope30={sys?.slope30 ?? null}
          icon={Heart}
        />
        <TrendCard
          label="Puls"
          latest={p?.latest ?? null}
          unit="bpm"
          avg7={p?.avg7 ?? null}
          avg30={p?.avg30 ?? null}
          slope30={p?.slope30 ?? null}
          icon={TrendingUp}
        />
        <MedSummaryCard />
      </div>

      {data?.bpInTargetPct !== undefined && data.bpInTargetPct !== null && (
        <div className="bg-card border-border rounded-xl border p-4">
          <span className="text-muted-foreground text-sm">
            Blutdruck im Zielbereich (30T):{" "}
          </span>
          <span className="font-semibold">{data.bpInTargetPct}%</span>
        </div>
      )}

      <HealthChart
        types={["WEIGHT"]}
        title="Gewicht"
        colors={["#bd93f9"]}
        unit="kg"
      />

      <HealthChart
        types={["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"]}
        title="Blutdruck"
        colors={["#ff79c6", "#8be9fd"]}
        unit="mmHg"
      />

      <HealthChart
        types={["PULSE"]}
        title="Puls"
        colors={["#50fa7b"]}
        unit="bpm"
      />

      <InsightsCard />
    </div>
  );
}

function MedSummaryCard() {
  const { isAuthenticated } = useAuth();
  const { data: meds } = useQuery({
    queryKey: ["medications"],
    queryFn: async () => {
      const res = await fetch("/api/medications");
      if (!res.ok) return [];
      const json = await res.json();
      return json.data as Array<{ id: string; active: boolean }>;
    },
    enabled: isAuthenticated,
  });

  const active = meds?.filter((m) => m.active).length ?? 0;

  return (
    <div className="bg-card border-border rounded-xl border p-4">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-sm font-medium">
          Medikamente
        </span>
        <Pill className="text-muted-foreground h-4 w-4" />
      </div>
      <div className="mt-2 text-2xl font-bold">{active}</div>
      <p className="text-muted-foreground mt-1 text-xs">aktive Medikamente</p>
    </div>
  );
}
