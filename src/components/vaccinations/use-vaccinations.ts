"use client";

/**
 * v1.38.0 — immunization-log read hooks.
 *
 * Reads unwrap the envelope `data` (via `apiGet`) per the project rule, and
 * every key is factory-routed through `queryKeys.vaccination*`. The list
 * arrives with each dose's `series` already resolved per component antigen —
 * this client renders text from those numbers and never re-derives "N von M".
 *
 * Writes and the booster mint land with the capture form; they invalidate
 * `vaccinationDependentKeys`, which evicts the preventive-care root alongside
 * the dose list because logging a dose re-anchors the booster it answers.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { invalidateReminderReads } from "@/hooks/use-measurement-reminders";
import {
  invalidateKeys,
  queryKeys,
  refetchInactiveDailyReads,
  vaccinationDependentKeys,
} from "@/lib/query-keys";
import type {
  VaccinationDTO,
  VaccinationListDTO,
} from "@/lib/vaccinations/dto";
import type { VaccinationSuggestionResult } from "@/lib/vaccinations/document-suggestion";

export type Vaccination = VaccinationDTO;

/**
 * The write body — every field optional but the identity pair and the date.
 * `userId` is never here; the route narrows it from the session.
 */
export interface VaccinationWriteBody {
  occurredAt?: string;
  antigenSlug?: string | null;
  vaccineName?: string | null;
  doseNumber?: number | null;
  seriesDoses?: number | null;
  lotNumber?: string | null;
  site?: string | null;
  practitionerId?: string | null;
  encounterId?: string | null;
  note?: string | null;
  documentIds?: string[];
}

const BASE = "/api/vaccinations";

/**
 * The account's immunization log, newest dose first.
 *
 * `antigenSlug` filters the server query to one antigen's history; the series
 * numbers are still derived over the whole live set on the server, so a
 * filtered view never reports the oldest visible dose as the first ever given.
 */
export function useVaccinations(antigenSlug?: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.vaccinationList(antigenSlug ?? null),
    enabled,
    queryFn: () =>
      apiGet<VaccinationListDTO>(
        antigenSlug
          ? `${BASE}?antigenSlug=${encodeURIComponent(antigenSlug)}`
          : BASE,
      ),
  });
}

/**
 * One dose with its links. The list omits each dose's documents, so an edit
 * reads them here before it shows or sends them.
 */
export function useVaccination(id: string | null) {
  return useQuery({
    queryKey: queryKeys.vaccination(id ?? ""),
    enabled: id !== null,
    queryFn: () =>
      apiGet<Vaccination>(`${BASE}/${encodeURIComponent(id ?? "")}`),
  });
}

/**
 * Create / edit / soft-delete / restore a dose.
 *
 * Every write fans out through `vaccinationDependentKeys` AND the reminder
 * reads: logging a dose runs the server's satisfy matcher, which re-anchors any
 * booster the dose answers, so the preventive-care list must repaint in the
 * same tick — the exact pairing the encounter mutations use, through the same
 * helper rather than a second sweep that could drift from it.
 */
export function useVaccinationMutations() {
  const qc = useQueryClient();
  const invalidate = () =>
    Promise.all([
      invalidateKeys(qc, vaccinationDependentKeys),
      invalidateReminderReads(qc),
    ]);

  const create = useMutation({
    mutationKey: queryKeys.vaccinationCreate(),
    mutationFn: (body: VaccinationWriteBody) =>
      apiPost<Vaccination>(BASE, body),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationKey: queryKeys.vaccinationUpdate(),
    mutationFn: ({ id, body }: { id: string; body: VaccinationWriteBody }) =>
      apiPatch<Vaccination>(`${BASE}/${id}`, body),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationKey: queryKeys.vaccinationDelete(),
    mutationFn: (id: string) =>
      apiDelete<{ deleted: boolean }>(`${BASE}/${id}`),
    onSuccess: invalidate,
  });

  const restore = useMutation({
    mutationKey: queryKeys.vaccinationRestore(),
    mutationFn: (id: string) =>
      apiPost<Vaccination>(`${BASE}/${id}/restore`, {}),
    onSuccess: invalidate,
  });

  return { create, update, remove, restore };
}

/**
 * Which dose a document dated `anchor` most plausibly belongs to.
 *
 * The verdict is server-resolved through the shared ±7-day window, so the
 * browser never re-derives which dose a scan belongs to — and the "many"
 * verdict carries no pre-selection, so a caller cannot pre-select one of two.
 */
export function useVaccinationSuggestion(
  anchor: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.vaccinationSuggestion(anchor ?? ""),
    enabled: enabled && Boolean(anchor),
    queryFn: () =>
      apiGet<VaccinationSuggestionResult>(
        `${BASE}/suggest?anchor=${encodeURIComponent(anchor ?? "")}`,
      ),
  });
}

/** Link a document to a dose from the document side (the upload suggestion). */
export function useLinkDocumentToVaccination() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.vaccinationLink(),
    mutationFn: ({
      vaccinationId,
      documentId,
    }: {
      vaccinationId: string;
      documentId: string;
    }) =>
      apiPost(`${BASE}/${vaccinationId}/links`, {
        targetKind: "document",
        targetIds: [documentId],
      }),
    onSuccess: () =>
      Promise.all([
        invalidateKeys(qc, vaccinationDependentKeys),
        // The document's own sheet lists the doses it is filed against, so
        // a link made from the suggestion there has to repaint it.
        invalidateKeys(qc, [queryKeys.documents()]),
        // The linked-document badge can surface on the daily reads' checkup
        // items; force the unmounted snapshot/digest to refetch like the
        // sibling mutations do (via `invalidateReminderReads`).
        refetchInactiveDailyReads(qc),
      ]),
  });
}

/** What the booster confirm carries — the user's accepted-or-edited values. */
export interface BoosterMintBody {
  intervalMonths: number;
  label: string;
  notifyHour?: number;
}

/**
 * Mint (or re-anchor) the booster reminder a dose suggests.
 *
 * The response is an ordinary Vorsorge reminder; the write fans out through the
 * dose dependent-keys and the reminder reads so the new checkup appears on
 * `/checkups` the instant it is confirmed.
 */
export function useBoosterMint() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.vaccinationBooster(),
    mutationFn: ({ id, body }: { id: string; body: BoosterMintBody }) =>
      apiPost<{ reminder: unknown; minted: boolean }>(
        `${BASE}/${id}/booster`,
        body,
      ),
    onSuccess: () =>
      Promise.all([
        invalidateKeys(qc, vaccinationDependentKeys),
        invalidateReminderReads(qc),
      ]),
  });
}
