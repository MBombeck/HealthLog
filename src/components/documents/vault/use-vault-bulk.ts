"use client";

import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiPost } from "@/lib/api/api-fetch";
import {
  DOCUMENT_BULK_MAX_IDS,
  DOCUMENT_PURGE_GRACE_DAYS,
} from "@/lib/documents/inbound-constants";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, queryKeys } from "@/lib/query-keys";
import type {
  DocumentBulkAction,
  DocumentBulkResultDto,
  InboundDocumentKindValue,
} from "@/lib/validations/inbound-documents";

/**
 * The bulk actions on a selection: re-file and link (one outcome toast), and
 * delete with one undo for the whole batch. Deleting is only ever reached
 * through the page's confirmation.
 */
export function useVaultBulk({
  selectedIds,
  clearSelection,
}: {
  selectedIds: ReadonlySet<string>;
  clearSelection: () => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  /**
   * One bulk POST per ≤100-id chunk (the endpoint's cap); per-id results
   * are merged so a partial failure in any chunk surfaces once. The
   * endpoint is no-op-success on already-in-state rows, so an undo toast
   * firing twice is safe by contract.
   */
  const bulk = useMutation({
    mutationFn: async (input: {
      ids: string[];
      action: DocumentBulkAction;
      kind?: InboundDocumentKindValue;
      episodeId?: string;
    }) => {
      const results: DocumentBulkResultDto[] = [];
      for (let i = 0; i < input.ids.length; i += DOCUMENT_BULK_MAX_IDS) {
        const chunk = input.ids.slice(i, i + DOCUMENT_BULK_MAX_IDS);
        const page = await apiPost<{ results: DocumentBulkResultDto[] }>(
          "/api/documents/inbound/bulk",
          {
            ids: chunk,
            action: input.action,
            ...(input.kind !== undefined && { kind: input.kind }),
            ...(input.episodeId !== undefined && {
              episodeId: input.episodeId,
            }),
          },
        );
        results.push(...page.results);
      }
      return results;
    },
    onSettled: () => {
      void invalidateKeys(queryClient, [queryKeys.documents()]);
    },
  });

  const reportBulkOutcome = useCallback(
    (results: DocumentBulkResultDto[], successMessage: string) => {
      const failed = results.filter((r) => !r.ok).length;
      if (failed > 0) {
        showErrorToast(
          t("documents.bulk.partialFailure", {
            failed,
            total: results.length,
          }),
        );
      } else {
        toast.success(successMessage);
      }
    },
    [t],
  );

  const runBulk = useCallback(
    (
      action: Exclude<DocumentBulkAction, "delete" | "restore">,
      extra: {
        kind?: InboundDocumentKindValue;
        episodeId?: string;
        encounterId?: string;
      },
    ) => {
      const ids = [...selectedIds];
      bulk.mutate(
        { ids, action, ...extra },
        {
          onSuccess: (results) => {
            reportBulkOutcome(
              results,
              t("documents.bulk.updated", {
                count: results.filter((r) => r.ok).length,
              }),
            );
            clearSelection();
          },
          onError: (failure) =>
            showErrorToast(t("documents.bulk.failed"), { cause: failure }),
        },
      );
    },
    [selectedIds, bulk, reportBulkOutcome, clearSelection, t],
  );

  const restoreBulk = useCallback(
    (ids: string[]) => {
      bulk.mutate(
        { ids, action: "restore" },
        {
          onSuccess: (results) =>
            reportBulkOutcome(
              results,
              t("documents.bulk.restored", {
                count: results.filter((r) => r.ok).length,
              }),
            ),
          onError: (failure) =>
            showErrorToast(t("documents.toast.restoreFailed"), {
              cause: failure,
            }),
        },
      );
    },
    [bulk, reportBulkOutcome, t],
  );

  const deleteBulk = useCallback(
    (ids: string[]) => {
      bulk.mutate(
        { ids, action: "delete" },
        {
          onSuccess: (results) => {
            const okIds = results.filter((r) => r.ok).map((r) => r.id);
            const failed = results.length - okIds.length;
            if (failed > 0) {
              showErrorToast(
                t("documents.bulk.partialFailure", {
                  failed,
                  total: results.length,
                }),
              );
            }
            if (okIds.length > 0) {
              // ONE aggregate undo for the whole batch (bulk restore).
              toast.success(
                t("documents.bulk.deleted", { count: okIds.length }),
                {
                  description: t("documents.toast.deletedHint", {
                    days: DOCUMENT_PURGE_GRACE_DAYS,
                  }),
                  action: {
                    label: t("common.undo"),
                    onClick: () => restoreBulk(okIds),
                  },
                },
              );
            }
            clearSelection();
          },
          onError: (failure) =>
            showErrorToast(t("documents.bulk.failed"), { cause: failure }),
        },
      );
    },
    [bulk, clearSelection, restoreBulk, t],
  );

  return { bulk, runBulk, deleteBulk };
}
