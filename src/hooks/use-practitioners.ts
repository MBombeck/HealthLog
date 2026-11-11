"use client";

/**
 * Data hooks for the account's own address book of doctors and practices.
 *
 * The search runs in SQL over the two plaintext columns rather than in the
 * browser over a downloaded list: the columns are plaintext precisely so the
 * picker can search and sort them there, and a client-side filter would need
 * the whole book in memory to do it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiDelete, apiGetList, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { useIdempotentPost } from "@/lib/api/use-idempotent-post";
import {
  encounterDependentKeys,
  invalidateKeys,
  queryKeys,
  refetchInactiveDailyReads,
} from "@/lib/query-keys";
import type { PractitionerDTO } from "@/lib/practitioners/dto";

export type Practitioner = PractitionerDTO;

export interface PractitionerWriteBody {
  name?: string;
  specialty?: string | null;
  practice?: string | null;
  location?: string | null;
  phone?: string | null;
  note?: string | null;
}

const BASE = "/api/practitioners";
const PRACTITIONER_PAGE_SIZE = 200;

export function usePractitioners(q?: string, enabled = true) {
  const term = q?.trim() || undefined;
  return useQuery({
    queryKey: queryKeys.practitionerList(term),
    // The route pages and says whether another page exists; the pickers and
    // the address book read this as the whole list, so it walks to the end.
    queryFn: async () => {
      const all: Practitioner[] = [];
      for (let offset = 0; ; offset += PRACTITIONER_PAGE_SIZE) {
        const sp = new URLSearchParams({
          limit: String(PRACTITIONER_PAGE_SIZE),
          offset: String(offset),
        });
        if (term) sp.set("q", term);
        const { data: page, cap } = await apiGetList<Practitioner[]>(
          `/api/practitioners?${sp.toString()}`,
        );
        all.push(...page);
        if (!cap?.truncated) return all;
      }
    },
    enabled,
  });
}

export function usePractitionerMutations() {
  const qc = useQueryClient();
  // Renaming a practice changes the label a rail appointment renders under,
  // and the daily reads are unmounted from the address book — pair the
  // bundle invalidation with the forced inactive refetch. Not returned, so the
  // sheet closes without waiting for the refetches.
  const invalidate = () =>
    void Promise.all([
      invalidateKeys(qc, encounterDependentKeys),
      refetchInactiveDailyReads(qc),
    ]);

  // One key for as long as the sheet that mounts this is open.
  const post = useIdempotentPost();
  const create = useMutation({
    mutationKey: queryKeys.practitionerCreate(),
    mutationFn: (body: PractitionerWriteBody) => post<Practitioner>(BASE, body),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationKey: queryKeys.practitionerUpdate(),
    mutationFn: ({ id, body }: { id: string; body: PractitionerWriteBody }) =>
      apiPatch<Practitioner>(`${BASE}/${id}`, body),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationKey: queryKeys.practitionerDelete(),
    mutationFn: (id: string) =>
      apiDelete<{ deleted: boolean }>(`${BASE}/${id}`),
    onSuccess: invalidate,
  });

  // The Undo of a delete. It brings the entry back, not the links the
  // delete cleared on the visits that named it.
  const restore = useMutation({
    mutationKey: queryKeys.practitionerRestore(),
    mutationFn: (id: string) =>
      apiPost<Practitioner>(`${BASE}/${id}/restore`, {}),
    onSuccess: invalidate,
  });

  return { create, update, remove, restore };
}
