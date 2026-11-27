"use client";

/**
 * Settings → Export & Import → Activity file (FIT).
 *
 * Uploads activity files (`.fit`, `.fit.gz`, or the ZIP Garmin Connect's
 * "Export original" writes), up to 100 in one selection, one after the
 * other through the same route and job as a single file (`fit-batch.ts`).
 * While a selection runs, one row per file shows its state. Without one, the
 * card shows the account's latest job from `GET /api/import/fit/status`, so
 * the outcome is still there after a reload. Built like the Health Connect
 * card: the same shell, drop zone, phase line and result list.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertCircle, Check, Loader2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { fitFailureCodeOf, type FitFailureCode } from "@/lib/fit/errors";
import { useTranslations } from "@/lib/i18n/context";
import { classifyWrittenOutcome } from "@/lib/outcome/written-outcome";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { ImportCardShell, ImportStatusRegion } from "./import-card-shell";
import { FileInput } from "@/components/ui/file-picker";
import {
  FIT_BATCH_MAX_FILES,
  runFitBatch,
  type FitFileFailure,
  type FitFileState,
} from "./fit-batch";

interface FitBatchRow {
  key: string;
  name: string;
  state: FitFileState;
}

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
  const fileStatus: Record<
    Exclude<FitFileState["status"], "failed">,
    string
  > = {
    waiting: t("settings.sections.export.import.fit.batch.waiting"),
    uploading: t("settings.sections.export.import.fit.uploading"),
    imported: t("settings.sections.export.import.fit.batch.imported"),
    duplicate: t("settings.sections.export.import.fit.batch.duplicate"),
  };
  const fileFailures: Record<FitFileFailure, string> = {
    tooLarge: t("settings.sections.export.import.fit.batch.reason.tooLarge"),
    unsupported: t(
      "settings.sections.export.import.fit.batch.reason.unsupported",
    ),
    damaged: t("settings.sections.export.import.fit.batch.reason.damaged"),
    notActivity: t(
      "settings.sections.export.import.fit.batch.reason.notActivity",
    ),
    noWorkout: t("settings.sections.export.import.fit.batch.reason.noWorkout"),
    busy: t("settings.sections.export.import.fit.batch.reason.busy"),
    retry: t("settings.sections.export.import.fit.batch.reason.retry"),
  };
  return { rows, failures, phases, fileStatus, fileFailures };
}

export function FitImportCard() {
  const { t } = useTranslations();
  const labels = useFitLabels();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [batch, setBatch] = useState<FitBatchRow[]>([]);
  const [capped, setCapped] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

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

  const start = useCallback(
    async (picked: readonly File[]) => {
      if (picked.length === 0) return;
      const files = picked.slice(0, FIT_BATCH_MAX_FILES);
      const stamp = Date.now();
      setCapped(picked.length > files.length);
      setBatch(
        files.map((file, i) => ({
          key: `${stamp}-${i}`,
          name: file.name,
          state: { status: "waiting" },
        })),
      );
      setBatchRunning(true);
      try {
        await runFitBatch(
          files,
          {
            upload: (file) => {
              const form = new FormData();
              form.append("file", file);
              return apiFetchRaw("/api/import/fit", {
                method: "POST",
                credentials: "include",
                body: form,
              });
            },
            status: () =>
              apiGet<{ job: FitImportJob | null }>("/api/import/fit/status", {
                credentials: "include",
              }),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            cancelled: () => unmounted.current,
          },
          (index, state) =>
            setBatch((rows) =>
              rows.map((row, i) => (i === index ? { ...row, state } : row)),
            ),
        );
      } finally {
        if (!unmounted.current) setBatchRunning(false);
        void queryClient.invalidateQueries({
          queryKey: queryKeys.fitImportStatus(),
        });
      }
    },
    [queryClient],
  );

  const job = statusQuery.data?.job ?? null;
  const isRunning = job !== null && !TERMINAL_STATES.includes(job.status);
  const isDone = job?.status === "done";
  const isFailed = job?.status === "failed";
  const busy = batchRunning || isRunning;
  const showJob = batch.length === 0;
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
        onFiles={(files) => void start(files)}
      />

      <p className="text-muted-foreground text-xs">
        {t("settings.sections.export.import.fit.privacyNote")}
      </p>

      <ImportStatusRegion query={statusQuery}>
        {!showJob && (
          <FitBatchList rows={batch} capped={capped} labels={labels} />
        )}
        {showJob && isRunning && (
          <p
            data-testid="import-fit-progress"
            className="text-muted-foreground flex items-center gap-2 text-xs"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            {labels.phases[job?.status ?? "queued"] ?? labels.phases.queued}
          </p>
        )}
        {showJob && isDone && (
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
        {showJob && isDone && summary.rows.length > 0 && (
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
        {showJob && isFailed && (
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
              {failureText ??
                t("settings.sections.export.import.fit.uploadFailed")}
            </span>
          </p>
        )}
      </ImportStatusRegion>

      <SettingsCardActions className="mt-auto">
        <Button
          type="button"
          variant="outline"
          size="sm"
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
  onFiles,
}: {
  busy: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onFiles: (files: File[]) => void;
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
          const files = Array.from(e.dataTransfer.files ?? []);
          if (files.length > 0 && !busy) onFiles(files);
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
      <FileInput
        ref={inputRef}
        accept=".fit,.gz,.zip,application/zip,application/gzip,application/octet-stream"
        multiple
        className="sr-only"
        aria-label={t("settings.sections.export.import.fit.fileInputLabel")}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) onFiles(files);
          e.target.value = "";
        }}
      />
    </>
  );
}

/** One row per file: its name and where it stands. */
function FitBatchList({
  rows,
  capped,
  labels,
}: {
  rows: FitBatchRow[];
  capped: boolean;
  labels: ReturnType<typeof useFitLabels>;
}) {
  const { t } = useTranslations();
  const finished = rows.filter(
    (row) => row.state.status !== "waiting" && row.state.status !== "uploading",
  ).length;
  return (
    <div className="space-y-1.5">
      <p
        data-testid="import-fit-batch-progress"
        className="text-muted-foreground text-xs tabular-nums"
      >
        {t("settings.sections.export.import.fit.batch.progress", {
          done: finished,
          total: rows.length,
        })}
        {capped && ` ${t("settings.sections.export.import.fit.batch.capped")}`}
      </p>
      <ul
        data-testid="import-fit-files"
        className="divide-border max-h-72 divide-y overflow-y-auto rounded-lg border text-xs"
      >
        {rows.map((row) => (
          <li
            key={row.key}
            data-testid="import-fit-file"
            data-status={row.state.status}
            className="flex items-center justify-between gap-3 px-3 py-2"
          >
            <span
              className="text-foreground min-w-0 flex-1 truncate"
              title={row.name}
            >
              {row.name}
            </span>
            <FitFileStatus state={row.state} labels={labels} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function FitFileStatus({
  state,
  labels,
}: {
  state: FitFileState;
  labels: ReturnType<typeof useFitLabels>;
}) {
  if (state.status === "failed")
    return (
      <span className="text-destructive flex shrink-0 items-center gap-1">
        <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
        {labels.fileFailures[state.reason]}
      </span>
    );
  // A finished import and a running upload read from their icon alone, so a
  // narrow card leaves the room to the file name; the word stays for screen
  // readers and as the tooltip.
  if (state.status === "imported" || state.status === "uploading") {
    const label = labels.fileStatus[state.status];
    return (
      <span
        className={cn(
          "flex shrink-0 items-center",
          state.status === "imported"
            ? "text-foreground"
            : "text-muted-foreground",
        )}
        title={label}
      >
        {state.status === "imported" ? (
          <Check className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Loader2
            className="h-4 w-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        )}
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return (
    <span className="text-muted-foreground shrink-0">
      {labels.fileStatus[state.status]}
    </span>
  );
}
