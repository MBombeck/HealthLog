"use client";

/**
 * v1.40 — person-defined symptoms: read and write hooks.
 *
 * Reads unwrap the envelope through `apiGet`; every key comes from the
 * factory (`queryKeys.symptom*`, under the `["illness"]` root). Every write
 * evicts the whole illness tree, because the episode detail lists the
 * occurrences filed against it and the definition summaries count them, and
 * the day and timeline roots, which show each occurrence.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { useIdempotentPost } from "@/lib/api/use-idempotent-post";
import { invalidateKeys, queryKeys } from "@/lib/query-keys";
import type {
  SymptomDefinitionDTO,
  SymptomEventDTO,
} from "@/lib/symptoms/shared";

export interface SymptomDefinitionList {
  definitions: SymptomDefinitionDTO[];
  limit: number;
}

export interface SymptomEventList {
  events: SymptomEventDTO[];
  limit: number;
  hasMore: boolean;
}

export interface SymptomEventCreateInput {
  definitionId: string;
  intensity: number;
  occurredAt?: string;
  note?: string | null;
  episodeId?: string | null;
}

export interface SymptomEventUpdateInput {
  occurredAt?: string;
  intensity?: number;
  note?: string | null;
  episodeId?: string | null;
}

/** The record's symptom list; `includeHidden` adds the hidden ones. */
export function useSymptomDefinitions(includeHidden = false, enabled = true) {
  return useQuery({
    queryKey: queryKeys.symptomDefinitions(includeHidden),
    enabled,
    queryFn: () =>
      apiGet<SymptomDefinitionList>(
        `/api/symptoms/definitions?includeHidden=${includeHidden}`,
      ),
  });
}

/** Occurrences per request while walking a window. */
const SYMPTOM_EVENTS_PAGE_SIZE = 500;

/**
 * Every occurrence inside `[from, to]` (ISO instants), newest first, read page
 * by page. The route answers at most one page and says `hasMore`; each
 * further page asks up to the oldest instant already read (`to` is
 * inclusive, so the boundary instant comes back and is dropped by id). A
 * chronic episode can hold more than one page, and a single capped read
 * showed only its newest part.
 */
export async function loadSymptomEvents(
  from: string,
  to: string,
  episodeId: string | null,
  fetchPage: (url: string) => Promise<SymptomEventList> = (url) =>
    apiGet<SymptomEventList>(url),
): Promise<SymptomEventList> {
  const seen = new Set<string>();
  const events: SymptomEventDTO[] = [];
  let upTo = to;
  for (;;) {
    const params = new URLSearchParams({
      from,
      to: upTo,
      limit: String(SYMPTOM_EVENTS_PAGE_SIZE),
    });
    if (episodeId) params.set("episodeId", episodeId);
    const page = await fetchPage(`/api/symptoms/events?${params}`);
    let added = 0;
    for (const event of page.events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      events.push(event);
      added += 1;
    }
    const oldest = page.events[page.events.length - 1];
    // A page that adds nothing (a full page of one instant) cannot move the
    // bound, so it ends the walk rather than repeating forever.
    if (!page.hasMore || !oldest || added === 0) {
      return { events, limit: SYMPTOM_EVENTS_PAGE_SIZE, hasMore: false };
    }
    upTo = oldest.occurredAt;
  }
}

/**
 * Occurrences inside `[from, to]` (ISO instants), optionally only those filed
 * against one episode. Every one of them, newest first.
 */
export function useSymptomEvents(
  from: string,
  to: string,
  options: { episodeId?: string | null; enabled?: boolean } = {},
) {
  const episodeId = options.episodeId ?? null;
  return useQuery({
    queryKey: queryKeys.symptomEvents(from, to, episodeId),
    enabled: options.enabled ?? true,
    queryFn: () => loadSymptomEvents(from, to, episodeId),
  });
}

/**
 * What a symptom write reaches: the illness tree its keys live under, and the
 * day and the timeline, which list every occurrence. Nothing on the dashboard
 * or the Today digest reads symptoms.
 */
export function invalidateSymptomReads(qc: QueryClient) {
  return invalidateKeys(qc, [
    queryKeys.illness(),
    queryKeys.dayRoot(),
    queryKeys.timelineRoot(),
  ]);
}

// Not returned, so a save reports as soon as it lands rather than after
// every read it touches has refetched.
function useInvalidateSymptoms() {
  const qc = useQueryClient();
  return () => void invalidateSymptomReads(qc);
}

export function useCreateSymptomDefinition() {
  const invalidate = useInvalidateSymptoms();
  return useMutation({
    mutationFn: (input: { label: string; icon?: string | null }) =>
      apiPost<SymptomDefinitionDTO>("/api/symptoms/definitions", input),
    onSuccess: invalidate,
  });
}

export function useUpdateSymptomDefinition() {
  const invalidate = useInvalidateSymptoms();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: {
        label?: string;
        icon?: string | null;
        isActive?: boolean;
        sortOrder?: number;
      };
    }) =>
      apiPatch<SymptomDefinitionDTO>(`/api/symptoms/definitions/${id}`, input),
    onSuccess: invalidate,
  });
}

export function useDeleteSymptomDefinition() {
  const invalidate = useInvalidateSymptoms();
  return useMutation({
    mutationFn: ({ id, purge }: { id: string; purge: boolean }) =>
      apiDelete<{ deleted: true; purged: boolean; eventsDeleted: number }>(
        `/api/symptoms/definitions/${id}${purge ? "?purge=true" : ""}`,
      ),
    onSuccess: invalidate,
  });
}

/** Under one key for as long as the entry form that mounts it is open. */
export function useLogSymptomEvent() {
  const invalidate = useInvalidateSymptoms();
  const post = useIdempotentPost();
  return useMutation({
    mutationFn: (input: SymptomEventCreateInput) =>
      post<SymptomEventDTO>("/api/symptoms/events", input),
    onSuccess: invalidate,
  });
}

export function useUpdateSymptomEvent() {
  const invalidate = useInvalidateSymptoms();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: SymptomEventUpdateInput;
    }) => apiPatch<SymptomEventDTO>(`/api/symptoms/events/${id}`, input),
    onSuccess: invalidate,
  });
}

export function useDeleteSymptomEvent() {
  const invalidate = useInvalidateSymptoms();
  return useMutation({
    mutationFn: (id: string) =>
      apiDelete<{ deleted: true }>(`/api/symptoms/events/${id}`),
    onSuccess: invalidate,
  });
}
