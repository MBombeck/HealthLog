"use client";

import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";

/**
 * v1.4.32 — TanStack Query wrapper for `GET /api/workouts`.
 *
 * Consumers:
 *   - `/insights/workouts` — the workout list page reads the most
 *     recent N workouts and renders them as one-line rows.
 *   - `<RecentWorkoutsTile>` — the dashboard tile reads the top 3.
 *
 * Cache key shape:
 *   - `["workouts", "recent", { limit, since }]` — keyed on the
 *     pagination + filter inputs so the recent-tile and the list page
 *     keep separate cache slots without colliding.
 *   - `["workouts", id]` — single-workout detail (the workout-detail
 *     page consumes this separately via `useWorkoutDetail`).
 */

export interface WorkoutListEntry {
  id: string;
  sportType: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  distanceM: number | null;
  activeEnergyKcal: number | null;
  avgHr: number | null;
  maxHr: number | null;
  source: string;
  externalId: string | null;
}

export interface WorkoutListMeta {
  total: number;
  limit: number;
  offset: number;
  droppedDuplicates: number;
}

export interface WorkoutListPayload {
  workouts: WorkoutListEntry[];
  meta: WorkoutListMeta;
}

export interface UseWorkoutsOptions {
  /** Page size — defaults to 50, capped at 200 by the server. */
  limit?: number;
  /** Page offset — defaults to 0. */
  offset?: number;
  /**
   * ISO timestamp — only workouts with `startedAt >= since` are
   * returned. The dashboard tile passes a 7-day window; the list page
   * leaves it open so the user can scroll back through history.
   */
  since?: string;
  /** Optional sport-type filter. Pass through the canonical string. */
  sportType?: string;
}

async function fetchWorkouts(
  opts: UseWorkoutsOptions,
): Promise<WorkoutListPayload> {
  const params = new URLSearchParams();
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.offset != null) params.set("offset", String(opts.offset));
  if (opts.since) params.set("since", opts.since);
  if (opts.sportType) params.set("sportType", opts.sportType);
  const query = params.toString();
  const url = query ? `/api/workouts?${query}` : "/api/workouts";

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load workouts (${res.status})`);
  }
  const json = (await res.json()) as { data: WorkoutListPayload };
  return json.data;
}

export interface UseWorkoutsResult {
  data: WorkoutListPayload | undefined;
  isLoading: boolean;
  isEmpty: boolean;
  error: Error | null;
}

export function useWorkouts(opts: UseWorkoutsOptions = {}): UseWorkoutsResult {
  const { isAuthenticated } = useAuth();

  const query = useQuery({
    queryKey: queryKeys.workoutsRecentList({
      limit: opts.limit,
      offset: opts.offset,
      since: opts.since,
      sportType: opts.sportType,
    }),
    queryFn: () => fetchWorkouts(opts),
    enabled: isAuthenticated,
    staleTime: 60 * 1000,
  });

  const isEmpty =
    Boolean(isAuthenticated) &&
    query.data !== undefined &&
    query.data.workouts.length === 0;

  return {
    data: query.data,
    isLoading: query.isLoading,
    isEmpty,
    error: query.error as Error | null,
  };
}

export interface WorkoutDetailPayload extends WorkoutListEntry {
  minHr: number | null;
  stepCount: number | null;
  elevationM: number | null;
  pauseDurationSec: number | null;
  metadata: unknown;
  route:
    | {
        geometry: unknown;
        sampleTimestamps: string[] | null;
      }
    | null;
  canonicalId: string;
}

async function fetchWorkoutDetail(id: string): Promise<WorkoutDetailPayload> {
  const res = await fetch(`/api/workouts/${encodeURIComponent(id)}`);
  if (!res.ok) {
    throw new Error(`Failed to load workout (${res.status})`);
  }
  const json = (await res.json()) as { data: WorkoutDetailPayload };
  return json.data;
}

export interface UseWorkoutDetailResult {
  data: WorkoutDetailPayload | undefined;
  isLoading: boolean;
  error: Error | null;
}

export function useWorkoutDetail(id: string): UseWorkoutDetailResult {
  const { isAuthenticated } = useAuth();
  const query = useQuery({
    queryKey: queryKeys.workoutDetail(id),
    queryFn: () => fetchWorkoutDetail(id),
    enabled: isAuthenticated && id.length > 0,
    staleTime: 60 * 1000,
  });
  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}
