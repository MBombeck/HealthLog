"use client";

import { Flag } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { useTranslations } from "@/lib/i18n/context";
import type { WorkoutDetailPayload } from "@/hooks/use-workouts";

import { formatPaceSeconds } from "./format";

function formatSplitTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export interface WorkoutDetailSplitsProps {
  workout: WorkoutDetailPayload;
}

/**
 * Per-kilometre splits table, derived server-side from the route
 * geometry + timestamps. Returns `null` when the workout has no
 * split data (hide, don't render empty). The fastest km is marked
 * with a discreet muted accent — descriptive, not a verdict.
 */
export function WorkoutDetailSplits({ workout }: WorkoutDetailSplitsProps) {
  const { t } = useTranslations();
  const splits = workout.splits;
  if (!splits || splits.length === 0) return null;

  const fastest = Math.min(...splits.map((s) => s.paceSecPerKm));

  return (
    <Card data-slot="workout-detail-splits">
      <CardHeader>
        <TileHeader
          icon={Flag}
          title={t("insights.workouts.detail.splitsTitle")}
          titleAs="h2"
        />
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground text-left text-xs">
              <th className="pb-2 font-medium">
                {t("insights.workouts.detail.splitsKm")}
              </th>
              <th className="pb-2 text-right font-medium">
                {t("insights.workouts.detail.splitsTime")}
              </th>
              <th className="pb-2 text-right font-medium">
                {t("insights.workouts.detail.splitsPace")}
              </th>
            </tr>
          </thead>
          <tbody>
            {splits.map((s) => (
              <tr key={s.km} className="border-t">
                <td className="py-1.5 tabular-nums">{s.km}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {formatSplitTime(s.durationSec)}
                </td>
                <td
                  className={
                    s.paceSecPerKm === fastest
                      ? "py-1.5 text-right font-semibold tabular-nums"
                      : "py-1.5 text-right tabular-nums"
                  }
                >
                  {formatPaceSeconds(s.paceSecPerKm)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
