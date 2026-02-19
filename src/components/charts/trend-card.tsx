"use client";

import { ArrowDown, ArrowRight, ArrowUp, Minus } from "lucide-react";
import type { TrendSlope } from "@/lib/analytics/trends";

interface TrendCardProps {
  label: string;
  latest: number | null;
  unit: string;
  avg7: number | null;
  avg30: number | null;
  slope30: TrendSlope | null;
  icon: React.ComponentType<{ className?: string }>;
}

export function TrendCard({
  label,
  latest,
  unit,
  avg7,
  avg30,
  slope30,
  icon: Icon,
}: TrendCardProps) {
  const TrendIcon =
    slope30?.direction === "up"
      ? ArrowUp
      : slope30?.direction === "down"
        ? ArrowDown
        : slope30
          ? ArrowRight
          : Minus;

  const trendColor =
    slope30?.direction === "up"
      ? "text-dracula-orange"
      : slope30?.direction === "down"
        ? "text-dracula-cyan"
        : "text-muted-foreground";

  return (
    <div className="bg-card border-border rounded-xl border p-4">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-sm font-medium">
          {label}
        </span>
        <Icon className="text-muted-foreground h-4 w-4" />
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-bold">
          {latest !== null ? latest : "—"}
        </span>
        <span className="text-muted-foreground text-sm">{unit}</span>
        {slope30 && <TrendIcon className={`h-4 w-4 ${trendColor}`} />}
      </div>
      <div className="text-muted-foreground mt-1 flex gap-3 text-xs">
        {avg7 !== null && <span>7T: {avg7}</span>}
        {avg30 !== null && <span>30T: {avg30}</span>}
      </div>
    </div>
  );
}
