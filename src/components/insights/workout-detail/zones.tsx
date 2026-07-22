"use client";

import { Gauge } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { useTranslations } from "@/lib/i18n/context";
import type { WorkoutDetailPayload } from "@/hooks/use-workouts";

const ZONE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

function formatMinutes(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export interface WorkoutDetailZonesProps {
  workout: WorkoutDetailPayload;
}

/**
 * Effort-zone distribution — a single horizontal stacked bar (%HRmax
 * zones) with minutes per zone underneath. Descriptive only: "how the
 * effort was distributed", never a training prescription or cardiac
 * read (non-diagnostic standard). Returns `null` when zones could not
 * be derived (no profile age and no device zones).
 */
export function WorkoutDetailZones({ workout }: WorkoutDetailZonesProps) {
  const { t } = useTranslations();
  const zones = workout.zones;
  if (!zones) return null;

  const total = zones.zones.reduce((sum, z) => sum + z.seconds, 0);
  if (total <= 0) return null;

  return (
    <Card data-slot="workout-detail-zones">
      <CardHeader className="gap-1">
        <TileHeader
          icon={Gauge}
          title={t("insights.workouts.detail.zonesTitle")}
          titleAs="h2"
        />
        <p className="text-muted-foreground text-xs">
          {zones.model === "whoop"
            ? t("insights.workouts.detail.zonesCaptionDevice")
            : t("insights.workouts.detail.zonesCaption")}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          className="flex h-3 w-full overflow-hidden rounded-full"
          role="img"
          aria-label={t("insights.workouts.detail.zonesTitle")}
        >
          {zones.zones.map((z, i) =>
            z.seconds > 0 ? (
              <div
                key={z.zone}
                style={{
                  width: `${(z.seconds / total) * 100}%`,
                  backgroundColor: ZONE_COLORS[i],
                }}
              />
            ) : null,
          )}
        </div>
        <div className="grid grid-cols-5 gap-1 text-center">
          {zones.zones.map((z, i) => (
            <div key={z.zone} className="flex flex-col items-center gap-1">
              <span
                aria-hidden="true"
                className="size-2 rounded-full"
                style={{ backgroundColor: ZONE_COLORS[i] }}
              />
              <span className="text-xs font-medium">Z{z.zone}</span>
              <span className="text-muted-foreground text-xs tabular-nums">
                {formatMinutes(z.seconds)}
              </span>
              {z.lowBpm != null ? (
                <span className="text-muted-foreground text-[10px] tabular-nums">
                  {z.lowBpm}
                  {z.highBpm != null ? `–${z.highBpm}` : "+"}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
