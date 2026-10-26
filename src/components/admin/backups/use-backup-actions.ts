import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import type { useRecentProof } from "@/components/settings/security-section/use-recent-proof";
import {
  ReproofCancelledError,
  throwIfReproofRequired,
} from "@/components/settings/security-section/use-recent-proof";
import { apiFetchRaw, apiPost } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { BackupRow } from "@/types/backups";

import { getApiErrorMessage } from "../_shared";

/** "Run backup now": enqueues the pg-boss `data-backup` job. */
export function useRunBackup() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      return apiPost<{ jobId: string | null }>("/api/admin/backups/run");
    },
    onSuccess: () => {
      toast.success(t("admin.section.backups.runEnqueued"));
      // The job runs async; refetch after a short delay so the new row
      // shows up without leaving the user wondering whether the click
      // did anything.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: queryKeys.adminBackups() });
      }, 2000);
    },
    onError: (err) => {
      showErrorToast(
        err instanceof Error && err.message
          ? err.message
          : t("admin.section.backups.runFailed"),
        { cause: err },
      );
    },
  });
}

/** One backup file to the browser, after a fresh proof when one is due. */
export function useBackupDownload(
  recentProof: ReturnType<typeof useRecentProof>,
) {
  const { t } = useTranslations();
  // Per-row download in-flight state — keyed by backup id so two
  // parallel clicks on different rows don't share a single spinner.
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  async function handleDownload(row: BackupRow) {
    setDownloadingId(row.id);
    try {
      // apiFetchRaw: the download needs the raw Response for the blob +
      // the Content-Disposition filename header.
      const res = await recentProof.run(async () =>
        throwIfReproofRequired(
          await apiFetchRaw(`/api/admin/backups/${row.id}/download`),
        ),
      );
      if (!res.ok) {
        throw new Error(await getApiErrorMessage(res));
      }
      // Use the server-provided Content-Disposition filename if present,
      // otherwise fall back to a deterministic client-side name. The
      // server filename is more accurate (uses the actual createdAt).
      const cd = res.headers.get("content-disposition") ?? "";
      const match = cd.match(/filename="?([^";]+)"?/i);
      const fallback = `healthlog-backup-${row.userId}-${row.createdAt.slice(0, 10)}.json`;
      const filename = match?.[1] ?? fallback;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(t("admin.section.backups.downloadStarted"));
    } catch (err) {
      if (err instanceof ReproofCancelledError) return;
      showErrorToast(
        err instanceof Error && err.message
          ? err.message
          : t("admin.section.backups.downloadFailed"),
        { cause: err },
      );
    } finally {
      setDownloadingId(null);
    }
  }

  return { downloadingId, handleDownload };
}
