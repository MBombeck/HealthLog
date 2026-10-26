"use client";

import { useCallback, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  selectAllState,
  selectedCountOnPage,
  selectedIdsOnPage,
  toggleId,
  toggleSelectAll,
} from "@/components/data-list";
import { apiDelete, apiGet, apiPost } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import {
  invalidateKeys,
  measurementDependentKeys,
  queryKeys,
  refetchInactiveDailyReads,
} from "@/lib/query-keys";

import { PAGE_SIZE, isGroupedRow, type Measurement } from "./list-model";
import type { MeasurementListFilters } from "./use-measurement-list-filters";

/**
 * The list's read and its deletes. Deletes are soft (tombstones), so each
 * success toast carries a real Undo that restores the ids and re-fires the
 * same dependent-key bundle, keeping the dashboard, insights and chart
 * caches in step.
 */
export function useMeasurementListData({
  filters,
  enabled,
  lockedType,
  onEmptyChange,
}: {
  filters: MeasurementListFilters;
  enabled: boolean;
  lockedType: string | undefined;
  onEmptyChange?: (empty: boolean) => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const {
    typeFilter,
    sourceEq,
    fromIso,
    toIso,
    valueMin,
    valueMax,
    isDayGroupedFilter,
    isCumulativeFilter,
    page,
    sortBy,
    sortDir,
    listMode,
    selectedIds,
    setSelectedIds,
    clearSelection,
  } = filters;

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.measurementsList({
      type: typeFilter === "ALL" ? undefined : typeFilter,
      sourceEq,
      from: fromIso,
      to: toIso,
      // Value range applies only to the raw per-sample list.
      valueMin: isDayGroupedFilter ? undefined : valueMin,
      valueMax: isDayGroupedFilter ? undefined : valueMax,
      page,
      sortBy,
      sortDir,
      mode: listMode,
    }),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (typeFilter !== "ALL") params.set("type", typeFilter);
      if (sourceEq) params.set("sourceEq", sourceEq);
      if (fromIso) params.set("from", fromIso);
      if (toIso) params.set("to", toIso);
      if (!isDayGroupedFilter && valueMin != null)
        params.set("valueMin", String(valueMin));
      if (!isDayGroupedFilter && valueMax != null)
        params.set("valueMax", String(valueMax));
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String((page - 1) * PAGE_SIZE));
      params.set("sortBy", sortBy);
      params.set("sortDir", sortDir);
      // The day-grouped modes page over days, 25 per page like the
      // per-sample list: `groupBy=day` folds each cumulative day to its sum,
      // and sleep collapses to one row per night without a param.
      if (isCumulativeFilter) params.set("groupBy", "day");
      return apiGet<{
        measurements: Measurement[];
        meta: { total: number };
      }>(`/api/measurements?${params}`);
    },
    enabled,
  });

  const listEmpty =
    !isLoading &&
    !isError &&
    !data?.measurements?.length &&
    (typeFilter === "ALL" || !!lockedType);
  useEffect(() => {
    onEmptyChange?.(listEmpty);
  }, [listEmpty, onEmptyChange]);

  const restoreMeasurements = useCallback(
    async (ids: string[]) => {
      try {
        await apiPost("/api/measurements/restore", { ids });
        await invalidateKeys(queryClient, measurementDependentKeys);
        await refetchInactiveDailyReads(queryClient);
        toast.success(t("measurements.restoredToast"));
      } catch (failure) {
        showErrorToast(t("measurements.restoreError"), { cause: failure });
      }
    },
    [queryClient, t],
  );

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiDelete(`/api/measurements/${id}`);
    },
    onSuccess: (_data, id) => {
      void invalidateKeys(queryClient, measurementDependentKeys);
      void refetchInactiveDailyReads(queryClient);
      toast.success(t("measurements.deletedToast"), {
        action: {
          label: t("common.undo"),
          onClick: () => void restoreMeasurements([id]),
        },
      });
    },
    // A failed row delete says so; it used to fail without a word.
    onError: (failure) => {
      showErrorToast(t("measurements.deleteError"), { cause: failure });
    },
  });

  // The page-scoped bulk delete: the selected ids intersected with the
  // painted page.
  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const data = await apiPost<{ deleted: number }>(
        "/api/measurements/bulk-delete",
        { ids },
      );
      return data.deleted;
    },
    onSuccess: async (deleted, ids) => {
      await invalidateKeys(queryClient, measurementDependentKeys);
      await refetchInactiveDailyReads(queryClient);
      clearSelection();
      toast.success(
        deleted === 1
          ? t("measurements.bulkDeleteSuccessOne")
          : t("measurements.bulkDeleteSuccess", { count: String(deleted) }),
        {
          action: {
            label: t("common.undo"),
            onClick: () => void restoreMeasurements(ids),
          },
        },
      );
    },
    onError: (failure) => {
      showErrorToast(t("measurements.bulkDeleteError"), { cause: failure });
    },
  });

  // Synthetic day and night rows collapse many raw rows behind a `dayKey`
  // and are not individually deletable, so they are not selectable.
  const pageIds = (data?.measurements ?? [])
    .filter((m) => !isGroupedRow(m))
    .map((m) => m.id);
  const selectAll = selectAllState(selectedIds, pageIds);
  const selectedOnPage = selectedCountOnPage(selectedIds, pageIds);

  const onToggleRow = (id: string) => {
    setSelectedIds((prev) => toggleId(prev, id));
  };
  const onToggleSelectAll = () => {
    setSelectedIds((prev) => toggleSelectAll(prev, pageIds));
  };
  const onConfirmBulkDelete = () => {
    const ids = selectedIdsOnPage(selectedIds, pageIds);
    if (ids.length === 0) return;
    bulkDeleteMutation.mutate(ids);
  };

  // Every mode pages server-side at PAGE_SIZE: rows, days or nights.
  const totalPages = data ? Math.ceil(data.meta.total / PAGE_SIZE) : 0;

  return {
    data,
    isLoading,
    isError,
    error,
    refetch,
    deleteMutation,
    bulkDeleteMutation,
    pageIds,
    selectAll,
    selectedOnPage,
    onToggleRow,
    onToggleSelectAll,
    onConfirmBulkDelete,
    totalPages,
  };
}

export type MeasurementListData = ReturnType<typeof useMeasurementListData>;
