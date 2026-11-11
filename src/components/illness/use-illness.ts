"use client";

/**
 * v1.18.1 — illness / condition-journal read + write hooks.
 *
 * Reads unwrap the envelope `data` (via `apiGet`/`apiPost`) per the project
 * rule; every key is factory-routed through `queryKeys.illness*`. Writes
 * invalidate the whole `["illness"]` prefix so the episode history list and
 * an open day-log sheet repaint in lockstep after a log.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  apiDelete,
  apiGet,
  apiGetList,
  apiPatch,
  apiPost,
} from "@/lib/api/api-fetch";
import { useIdempotentPost } from "@/lib/api/use-idempotent-post";
import {
  illnessDependentKeys,
  invalidateKeys,
  queryKeys,
  refetchInactiveDailyReads,
} from "@/lib/query-keys";

import type {
  IllnessCorrelationResponse,
  IllnessDayLogDTO,
  IllnessDayLogInput,
  IllnessDayLogListResponse,
  IllnessEpisodeCreateInput,
  IllnessEpisodeDTO,
  IllnessEpisodeUpdateInput,
  IllnessInsightsResponse,
} from "./types";

/** The list route's largest page. */
const EPISODE_PAGE_SIZE = 100;

/**
 * Every episode, newest first. The list route pages (50 by default, 100 at
 * most), and the journal, its settings and every picker read this as the
 * whole record; a single unpaged call dropped the oldest episodes once there
 * were more than one page of them, and a person then found an old condition
 * only through search. So this reads page after page until the route says
 * nothing is left.
 */
export function useIllnessEpisodes(includeResolved = true, enabled = true) {
  return useQuery({
    queryKey: queryKeys.illnessEpisodes(includeResolved),
    enabled,
    queryFn: async () => {
      const all: IllnessEpisodeDTO[] = [];
      for (let offset = 0; ; offset += EPISODE_PAGE_SIZE) {
        const { data: page, cap } = await apiGetList<IllnessEpisodeDTO[]>(
          `/api/illness/episodes?includeResolved=${includeResolved}&limit=${EPISODE_PAGE_SIZE}&offset=${offset}`,
        );
        all.push(...page);
        // The route says whether a row past this page exists, so a last page
        // that is exactly full ends the walk without one more request.
        if (!cap?.truncated) return all;
      }
    },
  });
}

/** One episode by id. */
export function useIllnessEpisode(id: string | null) {
  return useQuery({
    queryKey: queryKeys.illnessEpisode(id ?? "none"),
    enabled: id !== null,
    queryFn: () => apiGet<IllnessEpisodeDTO>(`/api/illness/episodes/${id}`),
  });
}

/**
 * The per-episode retrospective correlation (recovery-gap / red-flag /
 * pre-onset / nadir). Server-authoritative + coverage-gated — the surface
 * pattern-matches `status` ("insufficient" → "still learning"), never
 * recomputes.
 */
export function useIllnessCorrelation(episodeId: string | null) {
  return useQuery({
    queryKey: queryKeys.illnessCorrelation(episodeId ?? "none"),
    enabled: episodeId !== null,
    queryFn: () =>
      apiGet<IllnessCorrelationResponse>(
        `/api/illness/episodes/${episodeId}/correlation`,
      ),
  });
}

/**
 * The cross-episode retrospective summary over a trailing window in days.
 *
 * `includeRecoveryGap` is OFF by default: the count breakdown is served by a
 * single fast query and the recovery-gap stays null. The illness list mounts
 * this lightweight read; only the explicit "Analyse" expansion opts into the
 * expensive per-episode correlation (`includeRecoveryGap: true`), which caches
 * under its own key. `enabled` lets a caller defer the heavy read until opened.
 */
export function useIllnessInsights(
  windowDays = 365,
  options: { includeRecoveryGap?: boolean; enabled?: boolean } = {},
) {
  const includeRecoveryGap = options.includeRecoveryGap ?? false;
  return useQuery({
    queryKey: queryKeys.illnessInsights(windowDays, includeRecoveryGap),
    enabled: options.enabled ?? true,
    queryFn: () =>
      apiGet<IllnessInsightsResponse>(
        `/api/illness/insights?windowDays=${windowDays}&includeRecoveryGap=${includeRecoveryGap}`,
      ),
  });
}

/** One episode's day-log for a given date (null when nothing is logged). */
export function useIllnessDayLog(episodeId: string | null, date: string) {
  return useQuery({
    queryKey: queryKeys.illnessDayLog(episodeId ?? "none", date),
    enabled: episodeId !== null,
    queryFn: () =>
      apiGet<IllnessDayLogDTO | null>(
        `/api/illness/episodes/${episodeId}/day-logs?date=${date}`,
      ),
  });
}

/**
 * v1.18.3 — the episode's full day-log history, newest-first (date-less list).
 * Powers the detail timeline's historical scroll instead of anchoring on
 * today. Server-authoritative; the response carries `meta.total` for paging.
 */
export function useIllnessDayLogList(
  episodeId: string | null,
  sortDir: "asc" | "desc" = "desc",
) {
  return useQuery({
    queryKey: queryKeys.illnessDayLogList(episodeId ?? "none", sortDir),
    enabled: episodeId !== null,
    queryFn: () =>
      apiGet<IllnessDayLogListResponse>(
        `/api/illness/episodes/${episodeId}/day-logs?sortDir=${sortDir}`,
      ),
  });
}

function useInvalidateIllness() {
  const qc = useQueryClient();
  // An episode write can flip Rest Mode, which frames the dashboard hero and
  // the Today digest — both unmounted from here, so the bundle invalidation
  // is paired with the forced inactive refetch. The write routes hard-evict
  // the server analytics bucket, so the refetch returns post-write context.
  // Not returned: a mutation waits for what `onSuccess` returns, and the
  // sheet would stay open until every read had refetched.
  return () => {
    void invalidateKeys(qc, illnessDependentKeys).then(() =>
      refetchInactiveDailyReads(qc),
    );
  };
}

/** Create an episode. */
export function useCreateEpisode() {
  const invalidate = useInvalidateIllness();
  // One key until a save lands, so a retry after a timeout is not a second
  // episode.
  const post = useIdempotentPost();
  return useMutation({
    mutationFn: (input: IllnessEpisodeCreateInput) =>
      post<IllnessEpisodeDTO>("/api/illness/episodes", input),
    onSuccess: invalidate,
  });
}

/** Edit an episode (partial). */
export function useUpdateEpisode() {
  const invalidate = useInvalidateIllness();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: IllnessEpisodeUpdateInput;
    }) => apiPatch<IllnessEpisodeDTO>(`/api/illness/episodes/${id}`, input),
    onSuccess: invalidate,
  });
}

/** Mark an episode recovered. */
export function useResolveEpisode() {
  const invalidate = useInvalidateIllness();
  return useMutation({
    mutationFn: (id: string) =>
      apiPatch<IllnessEpisodeDTO>(`/api/illness/episodes/${id}/resolve`, {}),
    onSuccess: invalidate,
  });
}

/** Soft-delete an episode. */
export function useDeleteEpisode() {
  const invalidate = useInvalidateIllness();
  return useMutation({
    mutationFn: (id: string) => apiDelete<void>(`/api/illness/episodes/${id}`),
    onSuccess: invalidate,
  });
}

/**
 * Restore a soft-deleted episode (the delete-Undo affordance). Clears
 * `deletedAt` server-side, bringing the episode and its preserved day-logs
 * back. Idempotent + owner-scoped.
 */
export function useRestoreEpisode() {
  const invalidate = useInvalidateIllness();
  return useMutation({
    mutationFn: (id: string) =>
      apiPost<IllnessEpisodeDTO>(`/api/illness/episodes/${id}/restore`, {}),
    onSuccess: invalidate,
  });
}

/** Upsert one day-log on an episode. */
export function useUpsertDayLog(episodeId: string) {
  const invalidate = useInvalidateIllness();
  return useMutation({
    mutationFn: (input: IllnessDayLogInput) =>
      apiPost<IllnessDayLogDTO>(
        `/api/illness/episodes/${episodeId}/day-logs`,
        input,
      ),
    onSuccess: invalidate,
  });
}
