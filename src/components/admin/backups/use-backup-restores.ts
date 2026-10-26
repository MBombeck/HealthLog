import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";

import type { useRecentProof } from "@/components/settings/security-section/use-recent-proof";
import { ReproofCancelledError } from "@/components/settings/security-section/use-recent-proof";
import { ApiError, apiGet, apiPost } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import type {
  MissingBackupSection,
  RestoreSkipSummary,
} from "@/lib/export/restore-skips";
import type { BackupRestoreJobView } from "@/lib/jobs/backup-restore-view";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { randomId } from "@/lib/random-id";
import type { BackupRow } from "@/types/backups";

import { isActiveRestore } from "../backup-restore-status";
import { missingSectionsOf } from "./restore-notices";

const DISMISSED_RESTORES_KEY = "healthlog.admin.backups.dismissedRestores";

/** Dismissed restore panels, from this browser. Empty when storage is off. */
function readDismissedRestores(): string[] {
  try {
    if (typeof window === "undefined") return [];
    const raw = window.localStorage.getItem(DISMISSED_RESTORES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function writeDismissedRestores(ids: string[]): void {
  try {
    // The list only ever shows a day of jobs; fifty ids is weeks of them.
    window.localStorage.setItem(
      DISMISSED_RESTORES_KEY,
      JSON.stringify(ids.slice(-50)),
    );
  } catch {
    // A private window: the panel comes back on reload, nothing else breaks.
  }
}

/**
 * The restores: the server's job list (polled while one runs), what this page
 * saw finish, the panels the operator dismissed, the refusal and skip reports
 * held on screen, and the typed-confirmation request that queues a restore.
 */
export function useBackupRestores(
  recentProof: ReturnType<typeof useRecentProof>,
) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  // What the last restore could not put back. Held in state rather than left
  // to the toast: a toast for "twelve symptom links are gone" disappears in
  // four seconds and the operator has no way to get it back. This panel stays
  // until they dismiss it.
  const [skipped, setSkipped] = useState<RestoreSkipSummary | null>(null);

  // Why the last restore was refused before it touched anything. Same reason
  // the skip report is held rather than toasted: the operator has to be able to
  // read it after the four seconds are up.
  const [refusedSections, setRefusedSections] = useState<
    MissingBackupSection[]
  >([]);

  // A job this page watched while it ran, and has now seen finish. Only those
  // raise a toast and refresh the page's data: a job that had already finished
  // when the page opened is shown in its panel and nothing more. Read in the
  // poll's own callback, where each answer arrives, rather than in an effect.
  const watched = useRef<Map<string, string>>(new Map());
  function noticeFinishedRestores(jobs: readonly BackupRestoreJobView[]) {
    for (const job of jobs) {
      const before = watched.current.get(job.id);
      watched.current.set(job.id, job.status);
      if (before !== "queued" && before !== "running") continue;
      if (job.status === "succeeded") {
        setRefusedSections([]);
        const report = job.result?.skipped;
        if (report && report.links > 0) {
          setSkipped(report as RestoreSkipSummary);
          toast.warning(
            t("admin.section.backups.restoreSkippedToast", {
              links: String(report.links),
            }),
          );
        } else {
          setSkipped(null);
          toast.success(t("admin.section.backups.restoreSuccess"));
        }
        // Restore touches every personal-data table; nuke the broader cache
        // so dashboards / lists rebuild against the new state.
        void queryClient.invalidateQueries();
      } else if (job.status === "failed") {
        setRefusedSections(missingSectionsOf(job.failure));
        showErrorToast(t("admin.section.backups.restoreFailed"));
      }
    }
  }

  // The restore jobs, read from the server so a reload during a restore finds
  // it again. Polled every two seconds while any is queued or running, and
  // not at all otherwise. A poll that fails keeps the last answer on screen:
  // a network blip is not a failed restore.
  const restores = useQuery({
    queryKey: queryKeys.adminBackupRestores(),
    queryFn: async () => {
      const data = await apiGet<{ jobs: BackupRestoreJobView[] }>(
        "/api/admin/backups/restores",
      );
      noticeFinishedRestores(data.jobs);
      return data;
    },
    refetchInterval: (query) =>
      query.state.data?.jobs.some(isActiveRestore) ? 2000 : false,
  });
  const restoreJobs = restores.data?.jobs ?? [];
  const activeOwners = new Set(
    restoreJobs.filter(isActiveRestore).map((job) => job.userId),
  );

  // Finished restores the operator dismissed. Remembered in this browser only,
  // for convenience; the list itself forgets a job after a day.
  const [dismissedRestores, setDismissedRestores] = useState<Set<string>>(
    () => new Set(readDismissedRestores()),
  );
  function dismissRestore(id: string) {
    setDismissedRestores((previous) => {
      const next = new Set(previous);
      next.add(id);
      writeDismissedRestores([...next]);
      return next;
    });
  }

  // Restore: typed-confirmation dialog. The request only queues the restore;
  // the panel above the list follows it from there.
  const restore = useMutation({
    mutationFn: async ({
      row,
      restoreInstanceSettings,
    }: {
      row: BackupRow;
      restoreInstanceSettings: boolean;
    }) => {
      // Idempotency-Key prevents a double-click from queuing a second
      // restore. Include the row id so two different backups can both be
      // restored independently in the same minute.
      const idempotencyKey = `restore-${row.id}-${randomId()}`;
      return recentProof.run(() =>
        apiPost<{ jobId: string; status: "queued" }>(
          `/api/admin/backups/${row.id}/restore`,
          { confirm: "RESTORE", restoreInstanceSettings },
          { headers: { "Idempotency-Key": idempotencyKey } },
        ),
      );
    },
    onSuccess: (data) => {
      setRefusedSections([]);
      setSkipped(null);
      watched.current.set(data.jobId, "queued");
      // Neutral, not a success: nothing has been restored yet.
      toast.info(t("admin.section.backups.restoreStarted"));
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminBackupRestores(),
      });
    },
    onError: (err) => {
      if (err instanceof ReproofCancelledError) return;
      if (
        err instanceof ApiError &&
        err.meta?.errorCode === "backup.restore.active"
      ) {
        showErrorToast(t("admin.section.backups.restoreActive"), {
          cause: err,
        });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.adminBackupRestores(),
        });
        return;
      }
      setRefusedSections([]);
      showErrorToast(
        err instanceof Error && err.message
          ? err.message
          : t("admin.section.backups.restoreFailed"),
        { cause: err },
      );
    },
  });

  return {
    restoreJobs,
    dismissedRestores,
    dismissRestore,
    restore,
    /** Whether a row's restore control waits: its request or its owner's job. */
    restorePending: (row: BackupRow) =>
      (restore.isPending && restore.variables?.row.id === row.id) ||
      activeOwners.has(row.userId),
    skipped,
    setSkipped,
    refusedSections,
    setRefusedSections,
  };
}
