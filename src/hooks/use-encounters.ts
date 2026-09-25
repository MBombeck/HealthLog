"use client";

/**
 * Data hooks for visits and the address book behind them.
 *
 * Every value the surfaces render arrives resolved from the server — the
 * practitioner as an object, the links with a label and a date, the
 * appointment's next-due instant computed. Nothing here re-derives one. A
 * client that recomputed a server-side derivation drifts from it the first
 * time the derivation changes on one side only.
 *
 * Writes reach two roots (`encounterDependentKeys`), because renaming a
 * practice changes the label every visit that names it renders.
 */
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { invalidateReminderReads } from "@/hooks/use-measurement-reminders";
import {
  encounterDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";
import type {
  EncounterDTO,
  EncounterListDTO,
  ProcedureListDTO,
} from "@/lib/encounters/dto";
import type { EncounterSuggestionResult } from "@/lib/encounters/suggest-window";

export type Encounter = EncounterDTO;
export type EncounterList = EncounterListDTO;

export interface EncounterWriteBody {
  occurredAt?: string;
  status?: "PLANNED" | "DONE" | "CANCELLED" | "NO_SHOW";
  kind?: string;
  practitionerId?: string | null;
  reason?: string | null;
  outcome?: string | null;
  bodySite?: string | null;
  laterality?: "LEFT" | "RIGHT" | "BOTH" | null;
  /** The checkup this visit closes, when it was filed from a due one. */
  reminderId?: string | null;
  documentIds?: string[];
  labResultIds?: string[];
  episodeIds?: string[];
}

const BASE = "/api/encounters";

export function useEncounters(
  enabled = true,
  window?: {
    from?: string;
    to?: string;
    status?: string;
    /** Only visits filed against this condition episode. */
    episodeId?: string;
  },
) {
  const from = window?.from ?? null;
  const to = window?.to ?? null;
  return useQuery({
    queryKey: queryKeys.encounterList(
      from,
      to,
      window?.status,
      window?.episodeId,
    ),
    queryFn: () => {
      const sp = new URLSearchParams();
      if (from) sp.set("from", from);
      if (to) sp.set("to", to);
      if (window?.status) sp.set("status", window.status);
      if (window?.episodeId) sp.set("episodeId", window.episodeId);
      const qs = sp.toString();
      return apiGet<EncounterList>(qs ? `${BASE}?${qs}` : BASE);
    },
    enabled,
  });
}

/**
 * The procedure and surgery history, searched server-side.
 *
 * The body site is ciphertext at rest, so the search runs on the server after
 * the decrypt, and the query is part of the key. The previous answer stays on
 * screen while the next one loads, so typing does not flash the list empty;
 * the body-site choices and the total arrive with every answer, computed over
 * the whole history.
 */
export function useProcedures(
  enabled: boolean,
  filter: { q: string; laterality: "LEFT" | "RIGHT" | "BOTH" | null },
) {
  return useQuery({
    queryKey: queryKeys.encounterProcedures(filter.q, filter.laterality),
    queryFn: () => {
      const sp = new URLSearchParams();
      if (filter.q.trim()) sp.set("q", filter.q.trim());
      if (filter.laterality) sp.set("laterality", filter.laterality);
      const qs = sp.toString();
      return apiGet<ProcedureListDTO>(
        qs ? `${BASE}/procedures?${qs}` : `${BASE}/procedures`,
      );
    },
    placeholderData: keepPreviousData,
    enabled,
  });
}

/**
 * "Does this belong to a visit?" for one anchor date.
 *
 * The verdict is resolved server-side so the document moment and the two lab
 * moments cannot answer the question differently. `anchor` being null means
 * the surface has no date yet and there is nothing to ask about.
 */
export function useEncounterSuggestion(anchor: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.encounterSuggestion(anchor ?? ""),
    queryFn: () =>
      apiGet<EncounterSuggestionResult>(
        `${BASE}/suggest?anchor=${encodeURIComponent(anchor ?? "")}`,
      ),
    enabled: enabled && Boolean(anchor),
  });
}

export function useEncounterMutations() {
  const qc = useQueryClient();
  /**
   * A visit write reaches further than the visit list.
   *
   * Filing one against a due checkup satisfies that reminder, which moves its
   * next-due date on the preventive-care list, on the dashboard card and on the
   * Today rail — three surfaces that read the reminder table and would
   * otherwise keep showing it due until their own poll. Booking one moves the
   * same reads the other way: a new appointment is a row the digest surfaces.
   *
   * So the fan-out is the visit roots PLUS the reminder reads, through the same
   * helper the Vorsorge surfaces use, rather than a second sweep that could
   * drift from it.
   */
  const invalidate = () =>
    Promise.all([
      invalidateKeys(qc, encounterDependentKeys),
      invalidateReminderReads(qc),
    ]);

  const create = useMutation({
    mutationKey: queryKeys.encounterCreate(),
    mutationFn: (body: EncounterWriteBody) => apiPost<Encounter>(BASE, body),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationKey: queryKeys.encounterUpdate(),
    mutationFn: ({ id, body }: { id: string; body: EncounterWriteBody }) =>
      apiPatch<Encounter>(`${BASE}/${id}`, body),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationKey: queryKeys.encounterDelete(),
    mutationFn: (id: string) =>
      apiDelete<{ deleted: boolean }>(`${BASE}/${id}`),
    onSuccess: invalidate,
  });

  return { create, update, remove };
}
