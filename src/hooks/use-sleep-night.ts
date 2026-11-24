"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { SleepSourceDiscrepancyDto } from "@/components/insights/sleep-source-discrepancy-marker";
import type { NightOverlayKind } from "@/lib/sleep/night-overlay-kinds";

/**
 * One reconstructed night from `GET /api/sleep/night?date=YYYY-MM-DD`.
 *
 * The date is the WAKE day: the night a person woke from into that day.
 * The server owns the reconstruction (stage folding, cross-source pick,
 * WHOOP timeline synthesis) and the day keying, so this hook only carries
 * the resolved figures across.
 *
 * The route is gated on the `sleep` module and answers 403 when it is off.
 * Callers gate the mount on `useModuleEnabled("sleep")` so a switched-off
 * module never paints as a failed read.
 */
export interface SleepNightSegment {
  stage: string;
  start: string;
  end: string;
  minutes: number;
}

export interface SleepNightSession {
  /** `YYYY-MM-DD` wake-day key. */
  night: string;
  /** The night's own zone when it is not the profile zone. */
  timeZone?: string | null;
  source: string | null;
  start: string;
  end: string;
  asleepMinutes: number;
  inBedMinutes: number | null;
  awakeMinutes: number | null;
  /** Mid-sleep awakenings. `0` is a real answer, not an absence. */
  awakenings: number;
  reconstructed: boolean;
  stages: Record<string, number>;
  segments: SleepNightSegment[];
  /** Two writers reported clearly different totals; observational only. */
  sourceDiscrepancy?: SleepSourceDiscrepancyDto | null;
}

/** One night metric over the timeline (#1419), resolved by the server. */
export interface SleepNightOverlayMetric {
  kind: NightOverlayKind;
  /** The measurement type drawn: says SDNN vs RMSSD, wrist vs deviation. */
  type: string;
  unit: string;
  source: string;
  /** Bucket starts on the shared grid; empty when the night has one value. */
  points: Array<{ at: string; value: number; min: number; max: number }>;
  nightValue: number | null;
  summary: { min: number; max: number; avg: number } | null;
}

export interface SleepNightOverlays {
  from: string;
  to: string;
  bucketMinutes: number;
  metrics: SleepNightOverlayMetric[];
}

export interface SleepNightPayload {
  night: string | null;
  /** `null` when nothing scorable was recorded for that night. */
  main: SleepNightSession | null;
  naps: SleepNightSession[];
  /**
   * Night metrics to draw over the main night's timeline. `null` without a
   * main night and on a night of stage totals. Optional: an older server
   * does not send it.
   */
  overlays?: SleepNightOverlays | null;
}

export interface UseSleepNightResult {
  /** `undefined` until the route has answered — never confuse it with a
   *  night that carried nothing. */
  data: SleepNightPayload | undefined;
  isError: boolean;
  /** The failed read's error, for the error row to read. */
  error: unknown;
  refetch: () => void;
}

/**
 * Reads the night a person woke from into `date`. `date` undefined reads the
 * most recent night with a main sleep (the sleep page's opening night).
 *
 * `enabled` is the caller's gate — pass `false` when the user is signed
 * out or the sleep module is disabled, and nothing is fetched.
 */
export function useSleepNight(
  date: string | undefined,
  enabled: boolean,
): UseSleepNightResult {
  const { data, isError, error, refetch } = useQuery({
    queryKey: queryKeys.sleepNight(date),
    queryFn: () =>
      apiGet<SleepNightPayload>(
        date === undefined
          ? "/api/sleep/night"
          : `/api/sleep/night?date=${encodeURIComponent(date)}`,
      ),
    enabled,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  return { data, isError, error, refetch: () => void refetch() };
}
