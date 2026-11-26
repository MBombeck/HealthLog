"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

/**
 * A device's own score, named by the device and kept apart from HealthLog's
 * proxy.
 *
 * `RECOVERY_SCORE` is written by WHOOP, Oura and Polar and by HealthLog's
 * nightly readiness job (`COMPUTED`); `SLEEP_SCORE` by Oura, Garmin and
 * Withings. The type alone does not say whose number it is, so the label
 * comes from the row's source: "WHOOP Recovery", "Polar Nightly Recharge",
 * "Oura sleep score". A vendor's number carries no HealthLog band.
 */

/** The last month of rows is enough for a two-week course of one source. */
const ROW_WINDOW_DAYS = 30;
/** Two sources a day (device and proxy) over the window, with room. */
const ROW_LIMIT = 90;
/** The course the recovery block draws. */
export const DEVICE_COURSE_DAYS = 14;

const DAY_MS = 86_400_000;

/** A stored row as the measurement list answers it. */
export interface ScoreRow {
  value: number;
  source: string;
  measuredAt: string;
}

/** Label key per device source for `RECOVERY_SCORE`. */
export const DEVICE_RECOVERY_LABEL_KEYS: Readonly<Record<string, string>> = {
  WHOOP: "measurements.typeRecoveryScoreWhoop",
  OURA: "measurements.typeRecoveryScoreOura",
  POLAR: "measurements.typeRecoveryScorePolar",
};

/** Label key per device source for `SLEEP_SCORE`. */
export const DEVICE_SLEEP_SCORE_LABEL_KEYS: Readonly<Record<string, string>> = {
  OURA: "measurements.typeSleepScoreOura",
  GARMIN: "measurements.typeSleepScoreGarmin",
  WITHINGS: "measurements.typeSleepScoreWithings",
};

/**
 * Polar's Nightly Recharge is a 1 to 6 status, stored rescaled to 0 to 100
 * (`polar/map.ts`). Shown on its own scale again.
 */
export const POLAR_RECHARGE_SCALE_MAX = 6;

export function polarRechargeStatus(stored: number): number {
  return Math.round(1 + (stored / 100) * (POLAR_RECHARGE_SCALE_MAX - 1));
}

/** The last month of one score type's rows, every source, newest first. */
export function useScoreRows(
  type: "RECOVERY_SCORE" | "SLEEP_SCORE",
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.measurementsScoreRows(type),
    queryFn: async () => {
      const to = new Date();
      const from = new Date(to.getTime() - ROW_WINDOW_DAYS * DAY_MS);
      const params = new URLSearchParams({
        type,
        sortBy: "measuredAt",
        sortDir: "desc",
        from: from.toISOString(),
        to: to.toISOString(),
        limit: String(ROW_LIMIT),
      });
      const data = await apiGet<{ measurements?: ScoreRow[] }>(
        `/api/measurements?${params}`,
      );
      return data?.measurements ?? [];
    },
    enabled,
    staleTime: 60_000,
  });
}

/** The newest device row's source, or null when only the proxy wrote. */
export function deviceSourceOf(
  rows: readonly ScoreRow[],
  labelKeys: Readonly<Record<string, string>>,
): string | null {
  const row = rows.find((r) => r.source in labelKeys);
  return row ? row.source : null;
}

export interface DeviceRecovery {
  source: string;
  labelKey: string;
  latest: ScoreRow;
  /** The source's values over the last two weeks, oldest first. */
  course: number[];
}

/**
 * The device recovery to show: the newest device source's latest row and its
 * two-week course. Never a proxy row, never two sources in one course.
 */
export function deviceRecoveryOf(
  rows: readonly ScoreRow[],
  now: Date = new Date(),
): DeviceRecovery | null {
  const source = deviceSourceOf(rows, DEVICE_RECOVERY_LABEL_KEYS);
  if (!source) return null;
  const since = now.getTime() - DEVICE_COURSE_DAYS * DAY_MS;
  const own = rows.filter((r) => r.source === source);
  const course = own
    .filter((r) => new Date(r.measuredAt).getTime() >= since)
    .map((r) => r.value)
    .reverse();
  return {
    source,
    labelKey: DEVICE_RECOVERY_LABEL_KEYS[source],
    latest: own[0],
    course,
  };
}
