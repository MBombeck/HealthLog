"use client";

/**
 * Settings → Export & Import → Activity file (FIT).
 *
 * Uploads one activity file (`.fit`, `.fit.gz`, or the ZIP Garmin Connect's
 * "Export original" writes) and follows the background import through
 * `GET /api/import/fit/status`, which answers the account's latest job, so
 * the outcome is still there after a reload. Built like the Health Connect
 * card: the same shell, drop zone, phase line and result list.
 */
import { useCallback, useId, useRef, useState, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertCircle, Loader2, Upload } from "lucide-react";

import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { fitFailureCodeOf, type FitFailureCode } from "@/lib/fit/errors";
import { useTranslations } from "@/lib/i18n/context";
import { classifyWrittenOutcome } from "@/lib/outcome/written-outcome";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { ImportCardShell } from "./import-card-shell";

const TERMINAL_STATES: readonly string[] = ["done", "failed"];

/** The job as the status route answers it. Counts only. */
export interface FitImportJob {
  jobId: string;
  status: string;
  result: {
    sessions?: number;
    sessionsSkipped?: number;
    imported?: number;
    merged?: number;
    alreadyPresent?: number;
    withSeries?: number;
    withRoute?: number;
  } | null;
  failureReason: string | null;
}

/** The result rows the card lists, in order, without the zero ones. */
export function summarizeFitResult(result: FitImportJob["result"]): {
  written: number;
  rows: Array<{
    key:
      | "imported"
      | "merged"
      | "alreadyPresent"
      | "sessionsSkipped"
      | "withSeries"
      | "withRoute";
    count: number;
  }>;
} {
  const n = (v: number | undefined) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  const rows = (
    [
      ["imported", n(result?.imported)],
      ["merged", n(result?.merged)],
      ["alreadyPresent", n(result?.alreadyPresent)],
      ["sessionsSkipped", n(result?.sessionsSkipped)],
      ["withSeries", n(result?.withSeries)],
      ["withRoute", n(result?.withRoute)],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({ key, count }));
  return { written: n(result?.imported) + n(result?.merged), rows };
}

/**
 * Plain-language label per result row and per refusal code. Literal `t(...)`
 * calls so the i18n call-site coverage guard sees every key.
 */
function useFitLabels() {
  const { t } = useTranslations();
  const rows: Record<
    ReturnType<typeof summarizeFitResult>["rows"][number]["key"],
    string
  > = {
    imported: t("settings.sections.export.import.fit.result.imported"),
    merged: t("settings.sections.export.import.fit.result.merged"),
    alreadyPresent: t(
      "settings.sections.export.import.fit.result.alreadyPresent",
    ),
    sessionsSkipped: t(
      "settings.sections.export.import.fit.result.sessionsSkipped",
    ),
    withSeries: t("settings.sections.export.import.fit.result.withSeries"),
    withRoute: t("settings.sections.export.import.fit.result.withRoute"),
  };
  const failures: Record<FitFailureCode | "interrupted", string> = {
    unsupported_file: t(
      "settings.sections.export.import.fit.failure.unsupportedFile",
    ),
    archive_invalid: t(
      "settings.sections.export.import.fit.failure.archiveInvalid",
    ),
    too_large: t("settings.sections.export.import.fit.failure.tooLarge"),
    not_fit: t("settings.sections.export.import.fit.failure.notFit"),
    crc_mismatch: t("settings.sections.export.import.fit.failure.crcMismatch"),
    malformed: t("settings.sections.export.import.fit.failure.malformed"),
    too_complex: t("settings.sections.export.import.fit.failure.tooComplex"),
    not_activity: t("settings.sections.export.import.fit.failure.notActivity"),
    no_session: t("settings.sections.export.import.fit.failure.noSession"),
    staging_missing: t(
      "settings.sections.export.import.fit.failure.stagingMissing",
    ),
    interrupted: t("settings.sections.export.import.fit.failure.interrupted"),
  };
  const phases: Record<string, string> = {
    queued: t("settings.sections.export.import.fit.phase.queued"),
    parsing: t("settings.sections.export.import.fit.phase.parsing"),
    upserting: t("settings.sections.export.import.fit.phase.upserting"),
  };
  return { rows, failures, phases };
}

export function FitImportCard() {
  const { t } = useTranslations();
  const labels = useFitLabels();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: queryKeys.fitImportStatus(),
    refetchInterval: (query) => {
      const job = (query.state.data as { job: FitImportJob | null } | undefined)
        ?.job;
      return job && !TERMINAL_STATES.includes(job.status) ? 2000 : false;
    },
    queryFn: () =>
      apiGet<{ job: FitImportJob | null }>("/api/import/fit/status", {
        credentials: "include",
      }),
  });

  const upload = useCallback(
    async (file: File) => {
      setUploadError(null);
      setUploading(true);
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await apiFetchRaw("/api/import/fit", {
          method: "POST",
          credentials: "include",
          body: form,
        });
        if (res.status === 429)
          return setUploadError(
            t("settings.sections.export.import.fit.rateLimited"),
          );
        if (res.status === 413)
          return setUploadError(
            t("settings.sections.export.import.fit.tooLarge"),
          );
        if (res.status === 409)
          return setUploadError(t("settings.sections.export.import.fit.busy"));
        if (!res.ok)
          return setUploadError(
            t("settings.sections.export.import.fit.uploadFailed"),
          );
        await queryClient.invalidateQueries({
          queryKey: queryKeys.fitImportStatus(),
        });
      } catch {
        setUploadError(t("settings.sections.export.import.fit.uploadFailed"));
      } finally {
        setUploading(false);
      }
    },
    [t, queryClient],
  );

  const job = statusQuery.data?.job ?? null;
  const isRunning = job !== null && !TERMINAL_STATES.includes(job.status);
  const isDone = job?.status === "done";
  const isFailed = job?.status === "failed";
  const busy = uploading || isRunning;
  const summary = summarizeFitResult(job?.result ?? null);

  const failureText = (() => {
    const reason = job?.failureReason ?? null;
    if (!reason) return null;
    if (reason === "interrupted_by_restart") return labels.failures.interrupted;
    const code = fitFailureCodeOf(reason);
    return code
      ? labels.failures[code]
      : t("settings.sections.export.import.fit.failed");
  })();

  return (
    <ImportCardShell
      testId="import-card-fit"
      anchor="import-fit"
      icon={Activity}
      title={t("settings.sections.export.import.fit.title")}
      description={t("settings.sections.export.import.fit.description")}
    >
      <ol className="text-foreground list-decimal space-y-1 pl-4 text-xs">
        <li>{t("settings.sections.export.import.fit.steps.garmin")}</li>
        <li>{t("settings.sections.export.import.fit.steps.other")}</li>
      </ol>

      <FitDropZone
        busy={busy}
        inputRef={fileInputRef}
        onFile={(file) => void upload(file)}
      />

      <p className="text-muted-foreground text-xs">
        {t("settings.sections.export.import.fit.privacyNote")}
      </p>

      <div aria-live="polite" className="space-y-2">
        {statusQuery.isError && (
          // The last import's state could not be read; say so rather than
          // look like nothing ever ran. Uploading stays possible.
          <QueryErrorRow
            inset
            error={statusQuery.error}
            onRetry={() => void statusQuery.refetch()}
          />
        )}
        {uploading && (
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            {t("settings.sections.export.import.fit.uploading")}
          </p>
        )}
        {isRunning && (
          <p
            data-testid="import-fit-progress"
            className="text-muted-foreground flex items-center gap-2 text-xs"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            {labels.phases[job?.status ?? "queued"] ?? labels.phases.queued}
          </p>
        )}
        {isDone && (
          <WrittenOutcomeLine
            outcome={classifyWrittenOutcome({
              written: summary.written,
              skipped: job?.result?.sessionsSkipped ?? 0,
            })}
            message={
              summary.written > 0
                ? t("settings.sections.export.import.fit.doneSummary")
                : t("settings.sections.export.import.fit.doneNothing")
            }
            testId="import-fit-result"
          />
        )}
        {isDone && summary.rows.length > 0 && (
          <ul
            data-testid="import-fit-rows"
            className="text-muted-foreground space-y-0.5 text-xs"
          >
            {summary.rows.map(({ key, count }) => (
              <li key={key} className="flex justify-between gap-2">
                <span className="text-foreground">{labels.rows[key]}</span>
                <span className="tabular-nums">{count}</span>
              </li>
            ))}
          </ul>
        )}
        {(isFailed || uploadError) && (
          <p
            data-testid="import-fit-error"
            role="alert"
            className="text-destructive flex items-start gap-2 text-sm"
          >
            <AlertCircle
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
            <span>
              {uploadError ??
                failureText ??
                t("settings.sections.export.import.fit.uploadFailed")}
            </span>
          </p>
        )}
      </div>

      <SettingsCardActions className="mt-auto" align="start">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
          data-testid="import-action-fit"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          {t("settings.sections.export.import.fit.choose")}
        </Button>
      </SettingsCardActions>
    </ImportCardShell>
  );
}

/** The drop target and the hidden file input, as on the other import cards. */
function FitDropZone({
  busy,
  inputRef,
  onFile,
}: {
  busy: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onFile: (file: File) => void;
}) {
  const { t } = useTranslations();
  const [dragActive, setDragActive] = useState(false);
  const dropDescId = useId();
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-describedby={dropDescId}
        aria-disabled={busy}
        onClick={() => !busy && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !busy) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          const file = e.dataTransfer.files?.[0];
          if (file && !busy) onFile(file);
        }}
        className={cn(
          "border-border bg-muted/20 hover:bg-muted/40 focus-visible:ring-ring/50 flex min-h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-4 text-center transition-colors focus-visible:ring-2 focus-visible:outline-none",
          dragActive && "border-primary bg-primary/5",
          busy && "pointer-events-none opacity-60",
        )}
      >
        <Upload className="text-muted-foreground h-5 w-5" aria-hidden="true" />
        <span className="text-foreground text-sm font-medium">
          {t("settings.sections.export.import.fit.dropLabel")}
        </span>
        <span id={dropDescId} className="text-muted-foreground text-xs">
          {t("settings.sections.export.import.fit.dropHint")}
        </span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".fit,.gz,.zip,application/zip,application/gzip,application/octet-stream"
        className="sr-only"
        aria-label={t("settings.sections.export.import.fit.fileInputLabel")}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
    </>
  );
}
