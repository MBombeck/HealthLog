"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { ApiError, apiGetList, apiPost } from "@/lib/api/api-fetch";
import { DOCUMENT_BULK_MAX_IDS } from "@/lib/documents/inbound-constants";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, queryKeys } from "@/lib/query-keys";
import type {
  DeletedDocumentListDto,
  DocumentBulkResultDto,
} from "@/lib/validations/inbound-documents";

/**
 * Recently deleted: the list, and the three ways out of it. Restore brings a
 * document back (one at a time, or all through the bulk route); "Delete now"
 * removes one for good ahead of the grace window. Every write invalidates the
 * `["documents"]` prefix, so the vault, its usage figures and this list repaint
 * together.
 */
export function useRecentlyDeleted({ enabled }: { enabled: boolean }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const router = useRouter();

  const list = useQuery({
    queryKey: queryKeys.inboundDocumentsDeleted(),
    queryFn: () =>
      apiGetList<DeletedDocumentListDto>("/api/documents/inbound/deleted"),
    enabled,
  });

  const refresh = useCallback(
    () => void invalidateKeys(queryClient, [queryKeys.documents()]),
    [queryClient],
  );

  const restore = useMutation({
    mutationFn: (id: string) =>
      apiPost(`/api/documents/inbound/${id}/restore`, {}),
    onSuccess: (_data, id) => {
      refresh();
      toast.success(t("documents.trash.restored"), {
        action: {
          label: t("documents.trash.openRestored"),
          onClick: () =>
            router.push(`/documents?doc=${encodeURIComponent(id)}`),
        },
      });
    },
    onError: (error) => {
      refresh();
      const reason =
        error instanceof ApiError && typeof error.meta?.reason === "string"
          ? error.meta.reason
          : "";
      if (reason === "purged") {
        showErrorToast(t("documents.error.purged"), { cause: error });
      } else if (reason === "duplicateExists") {
        showErrorToast(t("documents.trash.restoreDuplicate"), {
          cause: error,
        });
      } else {
        showErrorToast(t("documents.toast.restoreFailed"), { cause: error });
      }
    },
  });

  const restoreAll = useMutation({
    mutationFn: async (ids: string[]) => {
      const results: DocumentBulkResultDto[] = [];
      for (let i = 0; i < ids.length; i += DOCUMENT_BULK_MAX_IDS) {
        const page = await apiPost<{ results: DocumentBulkResultDto[] }>(
          "/api/documents/inbound/bulk",
          { ids: ids.slice(i, i + DOCUMENT_BULK_MAX_IDS), action: "restore" },
        );
        results.push(...page.results);
      }
      return results;
    },
    onSuccess: (results) => {
      const restored = results.filter((r) => r.ok).length;
      const failed = results.length - restored;
      toastWrittenOutcome(
        failed === 0 ? "success" : restored > 0 ? "partial" : "failed",
        failed === 0
          ? t("documents.bulk.restored", { count: restored })
          : t("documents.trash.restorePartial", {
              failed,
              total: results.length,
            }),
      );
    },
    onError: (error) =>
      showErrorToast(t("documents.toast.restoreFailed"), { cause: error }),
    onSettled: refresh,
  });

  const purge = useMutation({
    mutationFn: (id: string) =>
      apiPost(`/api/documents/inbound/${id}/purge`, {}),
    onSuccess: () =>
      toastWrittenOutcome("success", t("documents.trash.purged")),
    onError: (error) =>
      showErrorToast(t("documents.trash.purgeFailed"), { cause: error }),
    onSettled: refresh,
  });

  return { list, restore, restoreAll, purge };
}
