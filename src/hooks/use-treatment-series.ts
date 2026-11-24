"use client";

/**
 * Data hooks for treatment series (v1.50).
 *
 * Everything a surface shows arrives resolved: the status, the counts, the
 * session dates. Writes evict the visit roots (`encounterDependentKeys`)
 * because the visit cards name the series they belong to, and the series
 * keys sit under the visits root, so a visit write evicts them in turn.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { useIdempotentPost } from "@/lib/api/use-idempotent-post";
import {
  encounterDependentKeys,
  invalidateKeys,
  queryKeys,
  refetchInactiveDailyReads,
} from "@/lib/query-keys";
import type { TreatmentSeriesDTO } from "@/lib/treatment-series/dto";

export type TreatmentSeries = TreatmentSeriesDTO;

export interface TreatmentSeriesWriteBody {
  title?: string;
  kind?: string;
  plannedSessions?: number | null;
  startsOn?: string;
  validUntil?: string | null;
  endedOn?: string | null;
  prescriberId?: string | null;
  performerId?: string | null;
  episodeId?: string | null;
  note?: string | null;
}

const BASE = "/api/treatment-series";

export function useTreatmentSeriesList(enabled = true) {
  return useQuery({
    queryKey: queryKeys.treatmentSeriesList(),
    queryFn: async () =>
      (await apiGet<{ series: TreatmentSeries[] }>(BASE)).series,
    enabled,
  });
}

export function useTreatmentSeries(id: string | null) {
  return useQuery({
    queryKey: queryKeys.treatmentSeries(id ?? ""),
    queryFn: () =>
      apiGet<TreatmentSeries>(`${BASE}/${encodeURIComponent(id ?? "")}`),
    enabled: Boolean(id),
  });
}

export function useTreatmentSeriesMutations() {
  const qc = useQueryClient();
  // The Today digest is among the visit roots and usually unmounted here,
  // so the inactive daily reads are refetched too.
  const invalidate = () =>
    void Promise.all([
      invalidateKeys(qc, encounterDependentKeys),
      refetchInactiveDailyReads(qc),
    ]);
  const post = useIdempotentPost();

  const create = useMutation({
    mutationKey: queryKeys.treatmentSeriesCreate(),
    mutationFn: (body: TreatmentSeriesWriteBody) =>
      post<TreatmentSeries>(BASE, body),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationKey: queryKeys.treatmentSeriesUpdate(),
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: TreatmentSeriesWriteBody;
    }) => apiPatch<TreatmentSeries>(`${BASE}/${id}`, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationKey: queryKeys.treatmentSeriesDelete(),
    mutationFn: (id: string) =>
      apiDelete<{ deleted: boolean }>(`${BASE}/${id}`),
    onSuccess: invalidate,
  });
  const restore = useMutation({
    mutationKey: queryKeys.treatmentSeriesRestore(),
    mutationFn: (id: string) =>
      apiPost<TreatmentSeries>(`${BASE}/${id}/restore`, {}),
    onSuccess: invalidate,
  });
  return { create, update, remove, restore };
}
