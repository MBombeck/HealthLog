"use client";

/**
 * Imaging exams (#1672): the read and write hooks. Reads unwrap the envelope
 * through `apiGet`; every key comes from `queryKeys.imaging*`, and every write
 * evicts `imagingDependentKeys`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPatch } from "@/lib/api/api-fetch";
import { useIdempotentPost } from "@/lib/api/use-idempotent-post";
import {
  imagingDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";
import type {
  ImagingExamDTO,
  ImagingExamListDTO,
  ImagingModality,
  ImagingSide,
} from "@/lib/imaging/shared";

export type ImagingExam = ImagingExamDTO;

/** The write body. `userId` is never here; the route narrows it. */
export interface ImagingWriteBody {
  modality?: ImagingModality;
  performedAt?: string;
  side?: ImagingSide | null;
  bodyPart?: string | null;
  facility?: string | null;
  requestingDoctor?: string | null;
  conclusion?: string | null;
  documentIds?: string[];
}

const BASE = "/api/imaging";

export function useImagingExams(enabled = true) {
  return useQuery({
    queryKey: queryKeys.imagingList(),
    enabled,
    queryFn: () => apiGet<ImagingExamListDTO>(BASE),
  });
}

export function useImagingMutations() {
  const qc = useQueryClient();
  const invalidate = () => void invalidateKeys(qc, imagingDependentKeys);
  const post = useIdempotentPost();

  const create = useMutation({
    mutationKey: queryKeys.imagingCreate(),
    mutationFn: (body: ImagingWriteBody) => post<ImagingExam>(BASE, body),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationKey: queryKeys.imagingUpdate(),
    mutationFn: ({ id, body }: { id: string; body: ImagingWriteBody }) =>
      apiPatch<ImagingExam>(`${BASE}/${encodeURIComponent(id)}`, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationKey: queryKeys.imagingDelete(),
    mutationFn: (id: string) =>
      apiDelete<{ deleted: boolean }>(`${BASE}/${encodeURIComponent(id)}`),
    onSuccess: invalidate,
  });
  return { create, update, remove };
}
