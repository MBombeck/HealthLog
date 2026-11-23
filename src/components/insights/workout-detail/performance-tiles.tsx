import {
  Activity,
  Droplets,
  Footprints,
  Gauge,
  Hourglass,
  TrendingUp,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";

import { formatDurationMinutes as formatMinutesDuration } from "@/lib/i18n/duration";
import type { WorkoutPerformance } from "@/lib/workouts/performance-metrics";

import { formatNumber } from "./format";

export interface PerformanceTile {
  icon: ReactNode;
  label: string;
  value: string;
}

type T = (key: string, params?: Record<string, string | number>) => string;

const K = "insights.workouts.detail";

/**
 * The watch's own figures for the session (#1343), as stat tiles beside
 * duration and heart rate. Only figures the source computed get a tile.
 * Values are the server's; this only formats them.
 */
export function performanceTiles(
  p: WorkoutPerformance | null | undefined,
  t: T,
  locale: string,
): PerformanceTile[] {
  if (!p) return [];
  const tiles: PerformanceTile[] = [];
  const add = (icon: ReactNode, key: string, value: string) =>
    tiles.push({ icon, label: t(`${K}.${key}`), value });
  if (p.aerobicTrainingEffect != null) {
    add(
      <TrendingUp className="size-4" />,
      "statsAerobicEffect",
      formatNumber(p.aerobicTrainingEffect, locale, 1),
    );
  }
  if (p.anaerobicTrainingEffect != null) {
    add(
      <TrendingUp className="size-4" />,
      "statsAnaerobicEffect",
      formatNumber(p.anaerobicTrainingEffect, locale, 1),
    );
  }
  if (p.trainingLoad != null) {
    add(
      <Activity className="size-4" />,
      "statsTrainingLoad",
      formatNumber(p.trainingLoad, locale),
    );
  }
  if (p.recoveryTimeMin != null) {
    add(
      <Hourglass className="size-4" />,
      "statsRecoveryTime",
      formatMinutesDuration(p.recoveryTimeMin, t),
    );
  }
  if (p.sweatLossMl != null) {
    add(
      <Droplets className="size-4" />,
      "statsSweatLoss",
      `${formatNumber(p.sweatLossMl, locale)} ml`,
    );
  }
  if (p.avgPowerW != null) {
    add(
      <Zap className="size-4" />,
      "statsAvgPower",
      `${formatNumber(p.avgPowerW, locale)} W`,
    );
  }
  if (p.avgVerticalOscillationMm != null) {
    add(
      <Gauge className="size-4" />,
      "statsVerticalOscillation",
      `${formatNumber(p.avgVerticalOscillationMm / 10, locale, 1)} cm`,
    );
  }
  if (p.avgGroundContactTimeMs != null) {
    add(
      <Footprints className="size-4" />,
      "statsGroundContactTime",
      `${formatNumber(p.avgGroundContactTimeMs, locale)} ms`,
    );
  }
  if (p.avgGroundContactBalancePct != null) {
    add(
      <Footprints className="size-4" />,
      "statsGroundContactBalance",
      t(`${K}.statsGroundContactBalanceValue`, {
        left: formatNumber(p.avgGroundContactBalancePct, locale, 1),
        right: formatNumber(100 - p.avgGroundContactBalancePct, locale, 1),
      }),
    );
  }
  return tiles;
}
