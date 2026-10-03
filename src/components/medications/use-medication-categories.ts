"use client";

/**
 * v1.40 (#1041) — the record's own medication categories: read, create,
 * rename / hide, delete. A rename or a delete changes what every card and the
 * insights medication tiles show (a delete moves medications to Other), so
 * both refetch the medication reads and the insights reads. Neither touches a
 * dose, so the daily reads the intake bundle refreshes stay as they are.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  ApiError,
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
} from "@/lib/api/api-fetch";
import { invalidateKeys, queryKeys } from "@/lib/query-keys";

const CATEGORY_DEPENDENT_KEYS = [
  queryKeys.medications(),
  queryKeys.insightsRoot(),
] as const;

export interface MedicationCategoryLabelDTO {
  key: string;
  label: string;
  sortOrder: number;
  isActive: boolean;
  medicationCount: number;
}

/** The `errorCode` the create POST answers when the per-account cap is hit. */
export const MEDICATION_CATEGORY_LIMIT_ERROR_CODE =
  "medications.category.limitReached";

/** Whether a failed create hit the cap rather than anything transient. */
export function isCategoryLimitError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.meta?.errorCode === MEDICATION_CATEGORY_LIMIT_ERROR_CODE
  );
}

export function useMedicationCategories(options?: { enabled?: boolean }) {
  return useQuery({
    enabled: options?.enabled ?? true,
    queryKey: queryKeys.medicationCategories(),
    queryFn: () =>
      apiGet<{ categories: MedicationCategoryLabelDTO[] }>(
        "/api/medications/categories",
      ),
    staleTime: 5 * 60_000,
    select: (data) => data.categories,
  });
}

export function useCreateMedicationCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { label: string }) =>
      apiPost<MedicationCategoryLabelDTO>("/api/medications/categories", input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: queryKeys.medicationCategories() }),
  });
}

export function useUpdateMedicationCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      key: string;
      label?: string;
      isActive?: boolean;
      sortOrder?: number;
    }) => {
      const { key, ...body } = input;
      return apiPatch<MedicationCategoryLabelDTO>(
        `/api/medications/categories/${encodeURIComponent(key)}`,
        body,
      );
    },
    onSuccess: () => invalidateKeys(qc, CATEGORY_DEPENDENT_KEYS),
  });
}

export function useDeleteMedicationCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      apiDelete<{ key: string; movedCount: number }>(
        `/api/medications/categories/${encodeURIComponent(key)}`,
      ),
    onSuccess: () => invalidateKeys(qc, CATEGORY_DEPENDENT_KEYS),
  });
}
