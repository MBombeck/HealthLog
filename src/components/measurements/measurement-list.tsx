"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { formatDateTime } from "@/lib/format";

const TYPE_LABELS: Record<string, string> = {
  WEIGHT: "Gewicht",
  BLOOD_PRESSURE_SYS: "Sys",
  BLOOD_PRESSURE_DIA: "Dia",
  PULSE: "Puls",
  BODY_FAT: "Körperfett",
  SLEEP_DURATION: "Schlaf",
  ACTIVITY_STEPS: "Schritte",
};

const TYPE_COLORS: Record<string, string> = {
  WEIGHT: "bg-chart-1/20 text-chart-1",
  BLOOD_PRESSURE_SYS: "bg-chart-3/20 text-chart-3",
  BLOOD_PRESSURE_DIA: "bg-chart-3/20 text-chart-3",
  PULSE: "bg-chart-5/20 text-chart-5",
  BODY_FAT: "bg-chart-4/20 text-chart-4",
  SLEEP_DURATION: "bg-chart-2/20 text-chart-2",
  ACTIVITY_STEPS: "bg-chart-2/20 text-chart-2",
};

interface Measurement {
  id: string;
  type: string;
  value: number;
  unit: string;
  source: string;
  measuredAt: string;
  notes: string | null;
}

interface MeasurementListProps {
  onEdit?: (m: Measurement) => void;
}

export function MeasurementList({ onEdit }: MeasurementListProps) {
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [typeFilter, setTypeFilter] = useState<string>("ALL");

  const { data, isLoading } = useQuery({
    queryKey: ["measurements", typeFilter === "ALL" ? undefined : typeFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (typeFilter !== "ALL") params.set("type", typeFilter);
      params.set("limit", "50");
      const res = await fetch(`/api/measurements?${params}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      return json.data as {
        measurements: Measurement[];
        meta: { total: number };
      };
    },
    enabled: isAuthenticated,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/measurements/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["measurements"] });
    },
  });

  if (!isAuthenticated) {
    return (
      <p className="text-muted-foreground text-sm">
        Bitte anmelden, um Messwerte zu sehen.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Alle Typen" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Alle Typen</SelectItem>
            {Object.entries(TYPE_LABELS).map(([val, label]) => (
              <SelectItem key={val} value={val}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {data?.meta.total !== undefined && (
          <span className="text-muted-foreground text-sm">
            {data.meta.total} Messwerte
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="flex h-32 items-center justify-center">
          <Loader2 className="text-primary h-6 w-6 animate-spin" />
        </div>
      ) : !data?.measurements.length ? (
        <div className="text-muted-foreground flex h-32 items-center justify-center rounded-lg border border-dashed">
          Keine Messwerte vorhanden
        </div>
      ) : (
        <div className="space-y-2">
          {data.measurements.map((m) => (
            <div
              key={m.id}
              className="bg-card border-border flex items-center justify-between rounded-lg border p-3"
            >
              <div className="flex items-center gap-3">
                <Badge
                  variant="secondary"
                  className={TYPE_COLORS[m.type] ?? ""}
                >
                  {TYPE_LABELS[m.type] ?? m.type}
                </Badge>
                <div>
                  <span className="text-lg font-semibold">
                    {m.value} {m.unit}
                  </span>
                  {m.notes && (
                    <p className="text-muted-foreground text-xs">{m.notes}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs">
                  {formatDateTime(m.measuredAt)}
                </span>
                {m.source !== "MANUAL" && (
                  <Badge variant="outline" className="text-xs">
                    {m.source}
                  </Badge>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => onEdit?.(m)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive h-8 w-8"
                  onClick={() => {
                    if (confirm("Messwert wirklich löschen?")) {
                      deleteMutation.mutate(m.id);
                    }
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
