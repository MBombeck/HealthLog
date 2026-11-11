"use client";

/**
 * Reads and writes behind the timeline (v1.42, #613).
 *
 * Every key comes from the factory (`queryKeys.timeline*`), every read
 * unwraps the envelope through `apiGet`. A life-event write changes the
 * lanes, the readiness inventory, the event list and any open day, so it
 * evicts the timeline root and the day root together.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPatch } from "@/lib/api/api-fetch";
import { useIdempotentPost } from "@/lib/api/use-idempotent-post";
import type {
  LifeEventCreateInput,
  LifeEventDTO,
  LifeEventListResponse,
  LifeEventUpdateInput,
  TimelineReadinessResponse,
  TimelineResponse,
  TimelineZoom,
} from "@/lib/day/contract";
import { invalidateKeys, queryKeys } from "@/lib/query-keys";

/** The query string for `GET /api/timeline`. */
export function timelinePath(
  zoom: TimelineZoom,
  from: string | null,
  to: string | null,
  values: readonly string[],
): string {
  const params = new URLSearchParams({ zoom });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (values.length > 0) params.set("values", values.join(","));
  return `/api/timeline?${params.toString()}`;
}

export function useTimeline(
  zoom: TimelineZoom,
  from: string | null,
  to: string | null,
  values: readonly string[],
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.timeline(zoom, from, to, values.join(",")),
    enabled,
    queryFn: () =>
      apiGet<TimelineResponse>(timelinePath(zoom, from, to, values)),
    // Moving between zoom levels keeps the last answer on screen until the
    // next one arrives, rather than blanking the chart.
    placeholderData: (previous) => previous,
  });
}

export function useTimelineReadiness(enabled = true) {
  return useQuery({
    queryKey: queryKeys.timelineReadiness(),
    enabled,
    queryFn: () => apiGet<TimelineReadinessResponse>("/api/timeline/readiness"),
  });
}

export function useLifeEvents(enabled = true) {
  return useQuery({
    queryKey: queryKeys.lifeEvents(),
    enabled,
    queryFn: () => apiGet<LifeEventListResponse>("/api/life-events"),
  });
}

export function useLifeEventMutations() {
  const qc = useQueryClient();
  const invalidate = () =>
    invalidateKeys(qc, [queryKeys.timelineRoot(), queryKeys.dayRoot()]);

  // One key until a save lands, so a retry after a timeout is not a second
  // event.
  const post = useIdempotentPost();
  const create = useMutation({
    mutationFn: (body: LifeEventCreateInput) =>
      post<LifeEventDTO>("/api/life-events", body),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: LifeEventUpdateInput }) =>
      apiPatch<LifeEventDTO>(
        `/api/life-events/${encodeURIComponent(id)}`,
        body,
      ),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiDelete<unknown>(`/api/life-events/${encodeURIComponent(id)}`),
    onSuccess: invalidate,
  });
  return { create, update, remove };
}
