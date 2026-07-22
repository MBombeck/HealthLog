"use client";

import { useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";

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
  /**
   * #67 list glyphs — whether the workout opens into a rich detail with
   * a map / HR curve. Optional so pre-#67 fixtures (and the dashboard
   * recent-tile) still satisfy the type; the list endpoint always sends
   * them.
   */
  hasRoute?: boolean;
  hasHrSeries?: boolean;
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

  return apiGet<WorkoutListPayload>(url);
}

export interface UseWorkoutsResult {
  data: WorkoutListPayload | undefined;
  isLoading: boolean;
  isEmpty: boolean;
  error: Error | null;
  /** True once the query has exhausted retries and settled on a failure. */
  isError: boolean;
  /** Re-runs the query — the retry action for a failed fetch. */
  refetch: () => void;
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
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}

export type UseInfiniteWorkoutsOptions = Omit<UseWorkoutsOptions, "offset">;

/**
 * Resolves the next canonical offset from the rows already accumulated by the
 * infinite query. A short page is terminal even when a stale server `total`
 * claims more rows remain, which prevents an empty-page fetch loop.
 */
export function getNextWorkoutPageOffset(
  lastPage: WorkoutListPayload,
  allPages: WorkoutListPayload[],
): number | undefined {
  const accumulatedRows = allPages.reduce(
    (count, page) => count + page.workouts.length,
    0,
  );
  const pageIsFull =
    lastPage.meta.limit > 0 && lastPage.workouts.length >= lastPage.meta.limit;

  return pageIsFull && accumulatedRows < lastPage.meta.total
    ? accumulatedRows
    : undefined;
}

/** Flattens loaded pages while defending the rendered list from duplicate ids. */
export function flattenWorkoutPages(
  pages: WorkoutListPayload[],
): WorkoutListEntry[] {
  const seen = new Set<string>();
  const workouts: WorkoutListEntry[] = [];

  for (const page of pages) {
    for (const workout of page.workouts) {
      if (seen.has(workout.id)) continue;
      seen.add(workout.id);
      workouts.push(workout);
    }
  }

  return workouts;
}

export interface UseInfiniteWorkoutsResult {
  workouts: WorkoutListEntry[];
  total: number;
  isLoading: boolean;
  isEmpty: boolean;
  error: Error | null;
  /** True when the first page failed and there is no history to preserve. */
  isError: boolean;
  /** True when an appended page failed while earlier pages remain visible. */
  isFetchNextPageError: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  refetch: () => void;
}

/**
 * Offset-paginated workout history. The first page deliberately uses the same
 * central key shape as the former `useWorkouts({ limit })` page query so the
 * RSC wrapper can hydrate it as an InfiniteData value.
 */
export function useInfiniteWorkouts(
  opts: UseInfiniteWorkoutsOptions = {},
): UseInfiniteWorkoutsResult {
  const { isAuthenticated } = useAuth();
  const query = useInfiniteQuery({
    queryKey: queryKeys.workoutsRecentList({
      limit: opts.limit,
      offset: undefined,
      since: opts.since,
      sportType: opts.sportType,
    }),
    queryFn: ({ pageParam }) => fetchWorkouts({ ...opts, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: getNextWorkoutPageOffset,
    enabled: isAuthenticated,
    staleTime: 60 * 1000,
  });
  const pages = query.data?.pages;
  const workouts = useMemo(
    () => (pages ? flattenWorkoutPages(pages) : []),
    [pages],
  );
  const total = query.data?.pages[0]?.meta.total ?? 0;
  const isEmpty =
    Boolean(isAuthenticated) &&
    query.data !== undefined &&
    workouts.length === 0;

  return {
    workouts,
    total,
    isLoading: query.isLoading,
    isEmpty,
    error: query.error as Error | null,
    isError: query.isError && query.data === undefined,
    isFetchNextPageError: query.isFetchNextPageError,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: Boolean(query.hasNextPage),
    fetchNextPage: () => void query.fetchNextPage(),
    refetch: () => void query.refetch(),
  };
}

export interface WorkoutHrSeriesPoint {
  tSec: number;
  mean: number;
  min: number;
  max: number;
}

export interface WorkoutHrSeriesDto {
  source: "workout_series" | "pulse_window";
  bucketSec: number;
  points: WorkoutHrSeriesPoint[];
  envelope: boolean;
}

export interface WorkoutZoneBandDto {
  zone: number;
  lowBpm: number | null;
  highBpm: number | null;
  seconds: number;
}

export interface WorkoutZonesDto {
  model: "whoop" | "tanaka";
  hrMax: number | null;
  zones: WorkoutZoneBandDto[];
}

export interface WorkoutSplitDto {
  km: number;
  durationSec: number;
  paceSecPerKm: number;
}

export interface WorkoutSportContextDto {
  count: number;
  avgDurationSec: number;
  avgDistanceM: number | null;
  avgAvgHr: number | null;
}

/**
 * The per-workout Activity Insight, or `null`.
 *
 * The seam shape is unchanged from when it was reserved — the union widened,
 * nothing else. `null` remains the overwhelmingly common case and is not an
 * error state: a paragraph exists only for a workout that LANDED while the
 * feature was live, in a session over ten minutes, under the day's cap, with a
 * provider reachable. Every historical workout, every re-synced one, and every
 * workout on a provider-less install reads `null` and renders no card. Nothing
 * on this read path can ever trigger a generation.
 */
export type WorkoutActivityInsight = {
  /** Plain text. Rendered as React text children — there is no markdown here. */
  paragraph: string;
  generatedAt: string;
} | null;

export interface WorkoutDetailPayload extends WorkoutListEntry {
  minHr: number | null;
  stepCount: number | null;
  elevationM: number | null;
  pauseDurationSec: number | null;
  metadata: unknown;
  route: {
    geometry: unknown;
    sampleTimestamps: string[] | null;
  } | null;
  /**
   * Raw per-workout HR sample envelope. `samples.samples` is dropped
   * (null) under `compact=1` — the web curve reads `hrSeries` instead —
   * but `sampleCount` is retained. Finally declared as of #67.
   */
  samples: { sampleCount: number; samples: unknown } | null;
  hrSeries: WorkoutHrSeriesDto | null;
  zones: WorkoutZonesDto | null;
  splits: WorkoutSplitDto[] | null;
  sportContext: WorkoutSportContextDto | null;
  aiInsight: WorkoutActivityInsight;
  canonicalId: string;
}

async function fetchWorkoutDetail(id: string): Promise<WorkoutDetailPayload> {
  // Web always sends `compact=1`: the SVG needs geometry, not the raw
  // 30k-sample / route-timestamp blobs (those ride the iOS path only).
  return apiGet<WorkoutDetailPayload>(
    `/api/workouts/${encodeURIComponent(id)}?compact=1`,
  );
}

export interface UseWorkoutDetailResult {
  data: WorkoutDetailPayload | undefined;
  isLoading: boolean;
  error: Error | null;
  /** Re-runs the query — the retry action for the detail error card. */
  refetch: () => void;
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
    refetch: () => void query.refetch(),
  };
}
