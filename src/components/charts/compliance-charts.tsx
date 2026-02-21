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
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useTranslations } from "@/lib/i18n/context";
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
  const { t } = useTranslations();
  const [selectedId, setSelectedId] = useState(medications[0]?.id ?? "");
  const [rangePoints, setRangePoints] = useState<30 | 90 | 0>(30);

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
      <div className="flex justify-end">
        <Select value={selectedId} onValueChange={setSelectedId}>
          <SelectTrigger className="w-full sm:w-64">
            <SelectValue placeholder={t("charts.selectMedication")} />
          </SelectTrigger>
          <SelectContent>
            {medications.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name} ({m.dose})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="text-primary h-6 w-6 animate-spin" />
        </div>
      ) : !data?.dailyCompliance ? (
        <div className="text-muted-foreground flex h-48 items-center justify-center rounded-lg border border-dashed text-sm">
          {t("charts.noComplianceData")}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <div className="flex h-7 items-center">
              <h3 className="text-muted-foreground text-sm font-medium">
                {t("charts.complianceDays90")}
              </h3>
            </div>
            <ComplianceHeatmap dailyCompliance={data.dailyCompliance} />
          </div>
          <div className="min-w-0 space-y-2">
            <div className="flex h-7 items-center justify-between gap-2">
              <h3 className="text-muted-foreground text-sm font-medium">
                {t("charts.history")}
              </h3>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant={rangePoints === 30 ? "default" : "ghost"}
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setRangePoints(30)}
                  title={t("charts.points30Title")}
                >
                  {t("charts.points30Label")}
                </Button>
                <Button
                  type="button"
                  variant={rangePoints === 90 ? "default" : "ghost"}
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setRangePoints(90)}
                  title={t("charts.points90Title")}
                >
                  {t("charts.points90Label")}
                </Button>
                <Button
                  type="button"
                  variant={rangePoints === 0 ? "default" : "ghost"}
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setRangePoints(0)}
                  title={t("charts.pointsAllTitle")}
                >
                  {t("charts.pointsAllLabel")}
                </Button>
              </div>
            </div>
            <ComplianceLineChart
              dailyCompliance={data.dailyCompliance}
              rangePoints={rangePoints}
              onRangePointsChange={setRangePoints}
              showRangeControls={false}
            />
          </div>
        </div>
      )}
    </div>
  );
}
