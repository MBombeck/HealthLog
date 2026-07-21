"use client";

import { useCallback, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Loader2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { ImportCardShell } from "./import-card-shell";

/** Terminal states the status poll stops on. */
const TERMINAL_STATES: readonly string[] = ["done", "failed"];

interface JobStatus {
  jobId: string;
  status: string;
  progress: {
    currentPhase?: string;
    recordsRead?: number;
    rowsUpserted?: number;
    percent?: number | null;
  } | null;
  result: {
    totals?: { recordsRead?: number; rowsUpserted?: number };
    clinical?: { skipped?: number };
    cumulativeEstimates?: { days?: number; rows?: number };
  } | null;
  failureReason: string | null;
}

export function AppleHealthEstimateWarning({ days }: { days: number }) {
  const { t } = useTranslations();
  return (
    <p
      data-testid="apple-health-estimate-warning"
      className="text-foreground flex items-start gap-2 text-xs"
    >
      <AlertCircle
        className="text-warning mt-0.5 size-3.5 shrink-0"
        aria-hidden="true"
      />
      <span>
        {t("settings.sections.export.import.appleHealth.estimateWarning", {
          count: days,
        })}
      </span>
    </p>
  );
}

export function AppleHealthImportCard() {
  const { t } = useTranslations();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const dropDescId = useId();

  const statusQuery = useQuery({
    queryKey: queryKeys.importJobStatus(jobId ?? "none"),
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const data = query.state.data as JobStatus | undefined;
      if (data && TERMINAL_STATES.includes(data.status)) return false;
      return 2000;
    },
    queryFn: async (): Promise<JobStatus> => {
      return apiGet<JobStatus>(
        `/api/import/apple-health-export/${jobId}/status`,
        { credentials: "include" },
      );
    },
  });

  const upload = useCallback(
    async (file: File) => {
      setUploadError(null);
      setUploading(true);
      setJobId(null);
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await apiFetchRaw("/api/import/apple-health-export", {
          method: "POST",
          credentials: "include",
          body: form,
        });
        if (res.status === 429) {
          setUploadError(
            t("settings.sections.export.import.appleHealth.rateLimited"),
          );
          return;
        }
        if (res.status === 413) {
          setUploadError(
            t("settings.sections.export.import.appleHealth.tooLarge"),
          );
          return;
        }
        if (!res.ok) {
          setUploadError(
            t("settings.sections.export.import.appleHealth.uploadFailed"),
          );
          return;
        }
        const body = (await res.json()).data as {
          jobId: string;
          status: string;
        };
        if (!body?.jobId) {
          setUploadError(
            t("settings.sections.export.import.appleHealth.uploadFailed"),
          );
          return;
        }
        setJobId(body.jobId);
      } catch {
        setUploadError(
          t("settings.sections.export.import.appleHealth.uploadFailed"),
        );
      } finally {
        setUploading(false);
      }
    },
    [t],
  );

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void upload(file);
    // Reset so picking the same file twice re-fires the change event.
    e.target.value = "";
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void upload(file);
  }

  const status = statusQuery.data ?? null;
  const isRunning = status !== null && !TERMINAL_STATES.includes(status.status);
  const isDone = status?.status === "done";
  const isFailed = status?.status === "failed";
  const busy = uploading || isRunning;
  const percent = status?.progress?.percent ?? null;

  return (
    <ImportCardShell
      testId="import-card-apple-health"
      icon={Upload}
      title={t("settings.sections.export.import.appleHealth.title")}
      description={t("settings.sections.export.import.appleHealth.description")}
    >
      {/* Keyboard-operable drop area. The hidden file input does the
          actual file selection; the div forwards Enter/Space to it. */}
      <div
        role="button"
        tabIndex={0}
        aria-describedby={dropDescId}
        aria-disabled={busy}
        onClick={() => !busy && fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !busy) {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => !busy && onDrop(e)}
        className={cn(
          "border-border bg-muted/20 hover:bg-muted/40 focus-visible:ring-ring/50 flex min-h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-4 text-center transition-colors focus-visible:ring-2 focus-visible:outline-none",
          dragActive && "border-primary bg-primary/5",
          busy && "pointer-events-none opacity-60",
        )}
      >
        <Upload className="text-muted-foreground h-5 w-5" aria-hidden="true" />
        <span className="text-foreground text-sm font-medium">
          {t("settings.sections.export.import.appleHealth.dropLabel")}
        </span>
        <span id={dropDescId} className="text-muted-foreground text-xs">
          {t("settings.sections.export.import.appleHealth.dropHint")}
        </span>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,application/zip"
        className="sr-only"
        aria-label={t(
          "settings.sections.export.import.appleHealth.fileInputLabel",
        )}
        onChange={onFileChange}
      />

      <p className="text-muted-foreground text-xs">
        {t("settings.sections.export.import.appleHealth.idempotencyNote")}
      </p>

      {/* Live progress / outcome — announced to assistive tech. */}
      <div aria-live="polite" className="space-y-2">
        {uploading && (
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            {t("settings.sections.export.import.appleHealth.uploading")}
          </p>
        )}
        {isRunning && (
          <div
            data-testid="import-apple-health-progress"
            className="space-y-1.5"
          >
            <p className="text-muted-foreground flex items-center gap-2 text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              {t(
                `settings.sections.export.import.appleHealth.phase.${status?.status ?? "queued"}`,
              )}
            </p>
            {typeof percent === "number" && <Progress value={percent} />}
            {typeof status?.progress?.rowsUpserted === "number" && (
              <p className="text-muted-foreground text-xs">
                {t("settings.sections.export.import.appleHealth.rowsImported", {
                  count: status.progress.rowsUpserted,
                })}
              </p>
            )}
          </div>
        )}
        {isDone && (
          <div
            data-testid="import-apple-health-result"
            className="text-foreground flex items-start gap-2 text-xs"
          >
            <CheckCircle2
              className="text-success mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
            <span>
              {t("settings.sections.export.import.appleHealth.doneSummary", {
                imported: status?.result?.totals?.rowsUpserted ?? 0,
                read: status?.result?.totals?.recordsRead ?? 0,
                skipped: status?.result?.clinical?.skipped ?? 0,
              })}
            </span>
          </div>
        )}
        {isDone && (status?.result?.cumulativeEstimates?.days ?? 0) > 0 && (
          <AppleHealthEstimateWarning
            days={status?.result?.cumulativeEstimates?.days ?? 0}
          />
        )}
        {(isFailed || uploadError) && (
          <p
            role="alert"
            className="text-destructive flex items-start gap-2 text-sm"
          >
            <AlertCircle
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
            <span>
              {uploadError ??
                status?.failureReason ??
                t("settings.sections.export.import.appleHealth.failed")}
            </span>
          </p>
        )}
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-3 pt-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
          data-testid="import-action-apple-health"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          {t("settings.sections.export.import.appleHealth.choose")}
        </Button>
      </div>
    </ImportCardShell>
  );
}
