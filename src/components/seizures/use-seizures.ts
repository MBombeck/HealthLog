"use client";

/**
 * Seizure-diary reads and writes (#1368).
 *
 * One read feeds the page: `GET /api/seizures` answers the types, the cluster
 * rule, the period's seizures and the summary, all derived on the server, so
 * this client renders figures and never re-derives a cluster or a streak.
 * Every write evicts `seizureDependentKeys` (the diary, and the medications a
 * rescue dose writes an intake on). Creates go through `useIdempotentPost`,
 * so a retry on a flaky phone connection cannot record a seizure twice.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { useIdempotentPost } from "@/lib/api/use-idempotent-post";
import {
  invalidateKeys,
  queryKeys,
  seizureDependentKeys,
} from "@/lib/query-keys";
import type {
  SeizureDiaryDTO,
  SeizureEventDTO,
  SeizureRescueDoseDTO,
  SeizureSettingsDTO,
  SeizureTypeDTO,
} from "@/lib/seizures/shared";

const BASE = "/api/seizures";

export interface DiaryPeriod {
  from: string;
  to: string;
}

/** The diary; the default period (the last 90 days) when none is given. */
export function useSeizureDiary(period?: DiaryPeriod, enabled = true) {
  const key = period ? `${period.from}|${period.to}` : "default";
  return useQuery({
    queryKey: queryKeys.seizureDiary(key),
    enabled,
    queryFn: () => {
      const sp = new URLSearchParams(period ? { ...period } : {});
      const qs = sp.toString();
      return apiGet<SeizureDiaryDTO>(qs ? `${BASE}?${qs}` : BASE);
    },
  });
}

/** What a rescue dose write carries; the medication is the record's own. */
export interface RescueDoseBody {
  medicationId?: string | null;
  medicationName?: string | null;
  doseAmount?: number | null;
  doseUnit?: string | null;
  route?: string | null;
  givenAt: string;
  givenBy?: string | null;
  effect?: string;
  seizureEndedAt?: string | null;
}

/** What an event write carries. `userId` is never here. */
export type SeizureEventBody = Partial<{
  typeProfileId: string | null;
  ilaeType: string | null;
  onsetAt: string;
  onsetPrecision: string;
  durationSec: number | null;
  durationSource: string;
  count: number;
  certainty: string;
  sleepState: string;
  observableManifestations: string | null;
  responsiveness: string | null;
  recall: string | null;
  semiology: string[];
  semiologyNote: string | null;
  aura: string | null;
  triggers: string[];
  postictalMinutes: number | null;
  postictal: string[];
  injuries: string[];
  incontinence: boolean | null;
  emergency: string;
  witnessed: boolean | null;
  witnessRole: string | null;
  witnessNote: string | null;
  note: string | null;
  rescueDoses: RescueDoseBody[];
}>;

export type SeizureTypeBody = Partial<{
  label: string;
  ilaeType: string;
  usualDurationSec: number | null;
  rescuePlan: string | null;
  rescueMedicationId: string | null;
  rescueDoseAmount: number | null;
  rescueDoseUnit: string | null;
  rescueRoute: string | null;
  archived: boolean;
  sortOrder: number;
}>;

function useInvalidate() {
  const qc = useQueryClient();
  // Not awaited: a sheet would otherwise hold its spinner until every
  // dependent read had refetched.
  return () => void invalidateKeys(qc, seizureDependentKeys);
}

export function useSeizureEventMutations() {
  const invalidate = useInvalidate();
  const post = useIdempotentPost();
  const create = useMutation({
    mutationKey: queryKeys.seizureEventCreate(),
    mutationFn: (body: SeizureEventBody) =>
      post<SeizureEventDTO>(`${BASE}/events`, body),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationKey: queryKeys.seizureEventUpdate(),
    mutationFn: ({ id, body }: { id: string; body: SeizureEventBody }) =>
      apiPatch<SeizureEventDTO>(`${BASE}/events/${id}`, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationKey: queryKeys.seizureEventDelete(),
    mutationFn: (id: string) =>
      apiDelete<{ deleted: boolean }>(`${BASE}/events/${id}`),
    onSuccess: invalidate,
  });
  return { create, update, remove };
}

export function useRescueDoseMutations() {
  const invalidate = useInvalidate();
  const post = useIdempotentPost();
  const create = useMutation({
    mutationKey: queryKeys.seizureRescueCreate(),
    mutationFn: ({
      eventId,
      body,
    }: {
      eventId: string;
      body: RescueDoseBody;
    }) => post<SeizureRescueDoseDTO>(`${BASE}/events/${eventId}/rescue`, body),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationKey: queryKeys.seizureRescueUpdate(),
    mutationFn: ({
      eventId,
      doseId,
      body,
    }: {
      eventId: string;
      doseId: string;
      body: Partial<RescueDoseBody>;
    }) =>
      apiPatch<SeizureRescueDoseDTO>(
        `${BASE}/events/${eventId}/rescue/${doseId}`,
        body,
      ),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationKey: queryKeys.seizureRescueDelete(),
    mutationFn: ({ eventId, doseId }: { eventId: string; doseId: string }) =>
      apiDelete<{ deleted: boolean }>(
        `${BASE}/events/${eventId}/rescue/${doseId}`,
      ),
    onSuccess: invalidate,
  });
  return { create, update, remove };
}

export function useSeizureTypeMutations() {
  const invalidate = useInvalidate();
  const create = useMutation({
    mutationKey: queryKeys.seizureTypeCreate(),
    mutationFn: (body: SeizureTypeBody) =>
      apiPost<SeizureTypeDTO>(`${BASE}/types`, body),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationKey: queryKeys.seizureTypeUpdate(),
    mutationFn: ({ id, body }: { id: string; body: SeizureTypeBody }) =>
      apiPatch<SeizureTypeDTO>(`${BASE}/types/${id}`, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationKey: queryKeys.seizureTypeDelete(),
    mutationFn: (id: string) =>
      apiDelete<{ deleted: boolean }>(`${BASE}/types/${id}`),
    onSuccess: invalidate,
  });
  return { create, update, remove };
}

export function useSeizureSettingsMutation() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationKey: queryKeys.seizureSettingsUpdate(),
    mutationFn: (body: { clusterCount: number; clusterWindowHours: number }) =>
      apiPatch<SeizureSettingsDTO>(`${BASE}/settings`, body),
    onSuccess: invalidate,
  });
}

/** The fields of a medication the rescue-plan picker reads. */
export interface RescueMedicationOption {
  id: string;
  name: string;
  dose: string | null;
  asNeeded?: boolean;
  trackIntake?: boolean;
  active?: boolean;
}

/**
 * The record's as-needed medications, from the medication list read every
 * other surface shares (same key, same fetch, so the cache holds one shape).
 */
export function useRescueMedications(enabled = true) {
  const query = useQuery({
    queryKey: queryKeys.medications(),
    enabled,
    queryFn: () => apiGet<RescueMedicationOption[]>("/api/medications"),
  });
  const options = (Array.isArray(query.data) ? query.data : []).filter(
    (m) => m.asNeeded === true && m.trackIntake !== false,
  );
  return { ...query, options };
}
