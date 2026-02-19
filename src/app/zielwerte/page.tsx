"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Scale,
  Heart,
  Activity,
  Moon,
  Percent,
  Loader2,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertCircle,
} from "lucide-react";

interface TargetData {
  type: string;
  label: string;
  current: number | null;
  average30: number | null;
  trend: "up" | "down" | "stable" | null;
  unit: string;
  range: { min: number; max: number } | null;
  classification: { category: string; color: string } | null;
  source: string;
}

interface BpDiastolic {
  current: number | null;
  average30: number | null;
  range: { min: number; max: number } | null;
}

interface TargetsResponse {
  targets: TargetData[];
  bpDiastolic: BpDiastolic;
  profile: {
    heightCm: number | null;
    age: number | null;
    gender: string | null;
  };
}

const TYPE_ICONS: Record<string, typeof Scale> = {
  WEIGHT: Scale,
  BLOOD_PRESSURE: Heart,
  PULSE: Activity,
  SLEEP_DURATION: Moon,
  BODY_FAT: Percent,
};

const TYPE_COLORS: Record<string, string> = {
  WEIGHT: "text-dracula-purple",
  BLOOD_PRESSURE: "text-dracula-pink",
  PULSE: "text-dracula-green",
  SLEEP_DURATION: "text-dracula-cyan",
  BODY_FAT: "text-dracula-orange",
};

function TrendIcon({ trend }: { trend: "up" | "down" | "stable" | null }) {
  if (trend === "up") {
    return <TrendingUp className="h-4 w-4 text-orange-400" />;
  }
  if (trend === "down") {
    return <TrendingDown className="h-4 w-4 text-cyan-400" />;
  }
  if (trend === "stable") {
    return <Minus className="h-4 w-4 text-green-400" />;
  }
  return null;
}

/**
 * A simple horizontal range bar showing where the current value falls
 * relative to a target range.
 */
function RangeBar({
  value,
  min,
  max,
  unit,
}: {
  value: number;
  min: number;
  max: number;
  unit: string;
}) {
  // Expand visual range to show values outside the target
  const padding = (max - min) * 0.5;
  const visualMin = min - padding;
  const visualMax = max + padding;
  const clampedValue = Math.max(visualMin, Math.min(visualMax, value));
  const position = ((clampedValue - visualMin) / (visualMax - visualMin)) * 100;
  const rangeStart = ((min - visualMin) / (visualMax - visualMin)) * 100;
  const rangeEnd = ((max - visualMin) / (visualMax - visualMin)) * 100;

  const inRange = value >= min && value <= max;

  return (
    <div className="space-y-1.5">
      <div className="bg-muted/50 relative h-3 w-full rounded-full">
        {/* Target range zone */}
        <div
          className="absolute top-0 h-full rounded-full bg-green-500/20"
          style={{
            left: `${rangeStart}%`,
            width: `${rangeEnd - rangeStart}%`,
          }}
        />
        {/* Current value marker */}
        <div
          className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-sm"
          style={{
            left: `${position}%`,
            backgroundColor: inRange
              ? "hsl(var(--chart-2))"
              : "hsl(var(--chart-5))",
            borderColor: inRange
              ? "hsl(var(--chart-2))"
              : "hsl(var(--chart-5))",
          }}
        />
      </div>
      <div className="text-muted-foreground flex justify-between text-xs">
        <span>
          {min} {unit}
        </span>
        <span>
          {max} {unit}
        </span>
      </div>
    </div>
  );
}

function TargetCard({
  target,
  bpDiastolic,
}: {
  target: TargetData;
  bpDiastolic?: BpDiastolic;
}) {
  const Icon = TYPE_ICONS[target.type] ?? Activity;
  const iconColor = TYPE_COLORS[target.type] ?? "text-primary";
  const isBp = target.type === "BLOOD_PRESSURE";

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className={`h-4 w-4 ${iconColor}`} />
            <CardTitle className="text-sm font-medium">
              {target.label}
            </CardTitle>
          </div>
          <TrendIcon trend={target.trend} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Current value */}
        {target.current != null ? (
          <div className="space-y-1">
            <div className="flex items-baseline gap-2">
              {isBp && bpDiastolic?.current != null ? (
                <>
                  <span className="text-3xl font-bold">
                    {Math.round(target.current)}
                  </span>
                  <span className="text-muted-foreground text-lg">/</span>
                  <span className="text-2xl font-bold">
                    {Math.round(bpDiastolic.current)}
                  </span>
                </>
              ) : (
                <span className="text-3xl font-bold">
                  {target.type === "BODY_FAT"
                    ? target.current.toFixed(1)
                    : Math.round(target.current * 10) / 10}
                </span>
              )}
              <span className="text-muted-foreground text-sm">
                {target.unit}
              </span>
            </div>
            {target.average30 != null && (
              <p className="text-muted-foreground text-xs">
                30-Tage-Durchschnitt:{" "}
                {isBp && bpDiastolic?.average30 != null
                  ? `${Math.round(target.average30)}/${Math.round(bpDiastolic.average30)}`
                  : Math.round(target.average30 * 10) / 10}{" "}
                {target.unit}
              </p>
            )}
          </div>
        ) : (
          <div className="text-muted-foreground flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            <span className="text-sm">Noch keine Messung vorhanden</span>
          </div>
        )}

        {/* Range bar */}
        {target.range && target.current != null && (
          <RangeBar
            value={target.current}
            min={target.range.min}
            max={target.range.max}
            unit={target.unit}
          />
        )}

        {/* BP diastolic range bar */}
        {isBp && bpDiastolic?.range && bpDiastolic.current != null && (
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs">Diastolisch</p>
            <RangeBar
              value={bpDiastolic.current}
              min={bpDiastolic.range.min}
              max={bpDiastolic.range.max}
              unit="mmHg"
            />
          </div>
        )}

        {/* Classification + source */}
        <div className="flex items-center justify-between">
          {target.classification ? (
            <Badge
              style={{
                backgroundColor: `${target.classification.color}20`,
                color: target.classification.color,
              }}
            >
              {target.classification.category}
            </Badge>
          ) : (
            <span />
          )}
          <span className="text-muted-foreground text-xs">{target.source}</span>
        </div>
      </CardContent>
    </Card>
  );
}

export default function ZielwertePage() {
  const { isAuthenticated } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ["insights", "targets"],
    queryFn: async () => {
      const res = await fetch("/api/insights/targets");
      if (!res.ok) throw new Error("Fehler beim Laden");
      const json = await res.json();
      return json.data as TargetsResponse;
    },
    enabled: isAuthenticated,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-muted-foreground py-20 text-center">
        Keine Daten verfügbar.
      </div>
    );
  }

  const profileIncomplete = !data.profile.heightCm || !data.profile.age;
  const visibleTargets = data.targets.filter((target) => target.current != null);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Zielwerte</h1>
        <p className="text-muted-foreground text-sm">
          Persönliche Referenzbereiche basierend auf deinem Profil
        </p>
      </div>

      {/* Profile incomplete hint */}
      {profileIncomplete && (
        <Card className="border-l-4 border-l-orange-500">
          <CardContent className="flex gap-3 py-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
            <div>
              <p className="text-sm font-medium">Profil unvollständig</p>
              <p className="text-muted-foreground text-sm">
                {!data.profile.heightCm && !data.profile.age
                  ? "Hinterlege deine Größe und dein Geburtsdatum im Profil, um personalisierte Zielbereiche zu erhalten."
                  : !data.profile.heightCm
                    ? "Hinterlege deine Größe im Profil, um den Gewichts-Zielbereich zu berechnen."
                    : "Hinterlege dein Geburtsdatum im Profil, um altersbasierte Zielbereiche zu erhalten."}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Target cards grid */}
      {visibleTargets.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {visibleTargets.map((target) => (
            <TargetCard
              key={target.type}
              target={target}
              bpDiastolic={
                target.type === "BLOOD_PRESSURE" ? data.bpDiastolic : undefined
              }
            />
          ))}
        </div>
      ) : (
        <div className="text-muted-foreground border-border rounded-xl border p-6 text-sm">
          Noch keine Messdaten vorhanden.
        </div>
      )}
    </div>
  );
}
