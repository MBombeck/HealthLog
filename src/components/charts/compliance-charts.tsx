"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { ComplianceHeatmap } from "./compliance-heatmap";
import { ComplianceLineChart } from "./compliance-line-chart";

interface DailyData {
  expected: number;
  taken: number;
  skipped: number;
  onTime?: number;
  late?: number;
  veryLate?: number;
}

interface ComplianceData {
  dailyCompliance: Record<string, DailyData>;
}

interface Medication {
  id: string;
  name: string;
  dose: string;
  active: boolean;
}

interface ComplianceChartsProps {
  medications: Medication[];
}

export function ComplianceCharts({ medications }: ComplianceChartsProps) {
  const [selectedId, setSelectedId] = useState(medications[0]?.id ?? "");

  const { data, isLoading } = useQuery({
    queryKey: ["compliance-chart", selectedId],
    queryFn: async () => {
      const res = await fetch(`/api/medications/${selectedId}/compliance`);
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as ComplianceData;
    },
    enabled: !!selectedId,
    staleTime: 60 * 1000,
  });

  if (medications.length === 0) return null;

  return (
    <div className="bg-card border-border space-y-4 rounded-xl border p-4 md:p-6">
      <Select value={selectedId} onValueChange={setSelectedId}>
        <SelectTrigger className="w-full sm:w-64">
          <SelectValue placeholder="Medikament wählen" />
        </SelectTrigger>
        <SelectContent>
          {medications.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.name} ({m.dose})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="text-primary h-6 w-6 animate-spin" />
        </div>
      ) : !data?.dailyCompliance ? (
        <div className="text-muted-foreground flex h-48 items-center justify-center rounded-lg border border-dashed text-sm">
          Keine Compliance-Daten verfügbar
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-2">
            <h3 className="text-muted-foreground text-sm font-medium">
              Kalender (90 Tage)
            </h3>
            <ComplianceHeatmap dailyCompliance={data.dailyCompliance} />
          </div>
          <div className="space-y-2">
            <h3 className="text-muted-foreground text-sm font-medium">
              Verlauf
            </h3>
            <ComplianceLineChart dailyCompliance={data.dailyCompliance} />
          </div>
        </div>
      )}
    </div>
  );
}
