import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";

import type { useRecentProof } from "@/components/settings/security-section/use-recent-proof";
import { ReproofCancelledError } from "@/components/settings/security-section/use-recent-proof";
import { ApiError, apiFetch, apiGet } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  BACKUP_OWNER_MISSING_CODE,
  backupUploadTargetQuery,
  type BackupUploadTarget,
} from "@/lib/validations/backup-upload-target";

/**
 * The upload body for a backup file: the file itself when it is already
 * gzip, otherwise the file compressed in the browser. The server accepts
 * both; compressing keeps a large export well inside the request size limit.
 */
async function uploadBody(file: File): Promise<Blob> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (head[0] === 0x1f && head[1] === 0x8b) return file;
  return new Response(
    file.stream().pipeThrough(new CompressionStream("gzip")),
  ).blob();
}

/**
 * Send a backup file to the admin upload route. Sent as the raw body,
 * compressed on the way unless it already is: the server reads it as a stream,
 * and a large export (hundreds of MB of JSON) shrinks about tenfold. No request
 * timeout, because a file of that size takes longer to check and store than
 * the default allows. The body is built here, per call, so a retry after a
 * re-proof sends the file again rather than a spent stream. With a target, the
 * copy goes into that account instead of the one the file names, which is
 * how the copy of an account no longer on this server comes back.
 */
async function uploadOnce(file: File, target?: BackupUploadTarget) {
  const body = await uploadBody(file);
  return apiFetch<{
    id: string;
    valid: true;
    summary: {
      measurements: number;
      medications: number;
      intakeEvents: number;
      moodEntries: number;
      // Optional for the same reason as the keys below: a file written
      // before side effects rode the wire carries no key at all.
      medicationSideEffects?: number;
      cycles?: number;
      cycleDayLogs?: number;
      // Backup-completeness — optional so an older-schema upload
      // (pre-v1.28) still totals correctly without these keys.
      labResults?: number;
      biomarkers?: number;
      illnessEpisodes?: number;
      illnessDayLogs?: number;
      allergies?: number;
      familyHistory?: number;
      workouts?: number;
      documents?: number;
      // Optional for the same reason: a file written before each of these
      // rode the wire carries no key, and an absent key must total as
      // nothing rather than break the count.
      nutrientDays?: number;
      healthProfile?: number;
      healthProfileFactRevisions?: number;
      customMetrics?: number;
      customMetricEntries?: number;
      intradayProfiles?: number;
    };
  }>(
    target
      ? `/api/admin/backups/upload?${backupUploadTargetQuery(target)}`
      : "/api/admin/backups/upload",
    {
      method: "POST",
      body,
      headers: { "Content-Type": "application/gzip" },
      signal: null,
    },
  );
}

export type UploadSummary = Awaited<ReturnType<typeof uploadOnce>>["summary"];

/** How many records an accepted upload carries, every section counted. */
export function uploadedRecordCount(summary: UploadSummary): number {
  return (
    summary.measurements +
    summary.medications +
    summary.intakeEvents +
    summary.moodEntries +
    (summary.medicationSideEffects ?? 0) +
    (summary.cycles ?? 0) +
    (summary.cycleDayLogs ?? 0) +
    (summary.labResults ?? 0) +
    (summary.biomarkers ?? 0) +
    (summary.illnessEpisodes ?? 0) +
    (summary.illnessDayLogs ?? 0) +
    (summary.allergies ?? 0) +
    (summary.familyHistory ?? 0) +
    (summary.workouts ?? 0) +
    (summary.documents ?? 0) +
    // The count the admin is shown has to be the count the file carries.
    // The nutrient day totals were added to the payload and never to this
    // sum, so an upload that restored them reported fewer records than it
    // held — a smaller version of the same defect, on the reporting side.
    (summary.nutrientDays ?? 0) +
    (summary.healthProfile ?? 0) +
    (summary.healthProfileFactRevisions ?? 0) +
    (summary.customMetrics ?? 0) +
    (summary.customMetricEntries ?? 0) +
    (summary.intradayProfiles ?? 0)
  );
}

/** Whether an upload was refused because the file's account is not here. */
export function isOwnerMissing(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.meta?.errorCode === BACKUP_OWNER_MISSING_CODE
  );
}

/**
 * The single-file upload flow: a fresh proof first, then the file, and the
 * file input reset after either outcome. A file whose account is not on this
 * server is kept (`orphan`) for the target dialog, which sends it again into
 * the account the admin picks (`uploadInto`).
 */
export function useBackupUpload(
  recentProof: ReturnType<typeof useRecentProof>,
) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  // Upload state — single-file flow, drives the file input + button.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [orphan, setOrphan] = useState<File | null>(null);

  /** A stored copy, said once: for its own account, or for the one chosen. */
  function announceStored(summary: UploadSummary, username: string | null) {
    const count = String(uploadedRecordCount(summary));
    toast.success(
      username === null
        ? t("admin.section.backups.uploadSuccess", { count })
        : t("admin.section.backups.target.success", { count, username }),
    );
    queryClient.invalidateQueries({ queryKey: queryKeys.adminBackups() });
  }
  const upload = useMutation({
    mutationFn: async (file: File) => {
      // Ask first, so a large file is not sent once only to be refused.
      await recentProof.run(() => apiGet("/api/auth/reproof"));
      return uploadOnce(file);
    },
    onSuccess: (data) => announceStored(data.summary, null),
    onError: (err, file) => {
      if (err instanceof ReproofCancelledError) return;
      // Not a dead end: the dialog offers an account to restore it into.
      if (isOwnerMissing(err)) {
        setOrphan(file);
        return;
      }
      showErrorToast(
        err instanceof Error && err.message
          ? err.message
          : t("admin.section.backups.uploadFailed"),
        { cause: err },
      );
    },
    onSettled: () => {
      // Reset the file input so the same file can be re-selected after a
      // rejected upload (browsers keep the previous selection otherwise).
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
  });

  const uploadInto = useMutation({
    mutationFn: async (target: BackupUploadTarget) => {
      if (!orphan) throw new Error("No file to upload");
      await recentProof.run(() => apiGet("/api/auth/reproof"));
      return { data: await uploadOnce(orphan, target), target };
    },
    onSuccess: ({ data, target }) => {
      setOrphan(null);
      announceStored(
        data.summary,
        target.into === "new" ? target.username : target.confirm,
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers() });
    },
    // A refusal stays in the dialog, beside the choice it refuses.
  });

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) upload.mutate(file);
  }

  function closeOrphan() {
    setOrphan(null);
    uploadInto.reset();
  }

  return {
    upload,
    fileInputRef,
    handleFileChange,
    orphan,
    uploadInto,
    closeOrphan,
  };
}
