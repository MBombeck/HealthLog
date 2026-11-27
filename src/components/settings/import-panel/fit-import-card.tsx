"use client";

/**
 * Settings → Export & Import → Activity file (FIT).
 *
 * Uploads activity files (`.fit`, `.fit.gz`, or the ZIP Garmin Connect's
 * "Export original" writes), up to 100 in one selection, one after the
 * other through the same route and job as a single file (`fit-batch.ts`).
 * While a selection runs, the sheet lists one row per file with its state.
 * Without one, it shows the account's latest job from
 * `GET /api/import/fit/status`, so the outcome is still there after a reload,
 * and the page row says the day and the count. Where the files come from and
 * what happens to a GPS track sit behind the (i).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertCircle, Check, Loader2 } from "lucide-react";

import { ListGroup, ListItem } from "@/components/ui/list-row";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { fitFailureCodeOf, type FitFailureCode } from "@/lib/fit/errors";
import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";
import { classifyWrittenOutcome } from "@/lib/outcome/written-outcome";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  ImportPickerRow,
  ImportSource,
  useFinishedJobMeta,
} from "./import-card-shell";
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
  completedAt?: string | null;
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

export function FitImportSource() {
  const { t } = useTranslations();
  const labels = useFitLabels();
  const finishedMeta = useFinishedJobMeta();
  const [open, setOpen] = useState(false);
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

  // The picker row's meta says where things stand: what it takes when idle,
  // "4 of 6" while a selection runs, the last job's phase or outcome without
  // one. Two text sizes in the body, the row's and the meta's.
  const finished = batch.filter(
    (row) => row.state.status !== "waiting" && row.state.status !== "uploading",
  ).length;
  const pickerMeta: React.ReactNode = !showJob ? (
    <span data-testid="import-fit-batch-progress" className="tabular-nums">
      {t("settings.sections.export.import.fit.batch.progress", {
        done: finished,
        total: batch.length,
      })}
      {capped && ` ${t("settings.sections.export.import.fit.batch.capped")}`}
    </span>
  ) : isRunning ? (
    <span data-testid="import-fit-progress">
      {labels.phases[job?.status ?? "queued"] ?? labels.phases.queued}
    </span>
  ) : isDone ? (
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
  ) : isFailed ? (
    <span
      data-testid="import-fit-error"
      role="alert"
      className="text-destructive"
    >
      {failureText ?? t("settings.sections.export.import.fit.uploadFailed")}
    </span>
  ) : null;

  // The page row: progress while a selection or a job runs, the last
  // finished job with its day, or what the source takes.
  const rowMeta =
    !showJob && batchRunning
      ? t("settings.sections.export.import.fit.batch.progress", {
          done: finished,
          total: batch.length,
        })
      : isRunning
        ? (labels.phases[job?.status ?? "queued"] ?? labels.phases.queued)
        : (finishedMeta(
            job ? { ...job, written: summary.written } : null,
          ) ?? t("settings.sections.export.import.fit.fileHint"));

  return (
    <ImportSource
      testId="import-card-fit"
      anchor="import-fit"
      icon={Activity}
      title={t("settings.sections.export.import.fit.title")}
      info={[
        t("settings.sections.export.import.fit.description"),
        t("settings.sections.export.import.fit.steps.garmin"),
        t("settings.sections.export.import.fit.steps.other"),
        t("settings.sections.export.import.fit.privacyNote"),
      ]}
      meta={rowMeta}
      status={
        busy
          ? "running"
          : (
                showJob
                  ? isFailed
                  : batch.some((row) => row.state.status === "failed")
              )
            ? "failed"
            : null
      }
      open={open}
      onOpenChange={setOpen}
      query={statusQuery}
      chooseTestId="import-choose-fit"
      file={{
        inputRef: fileInputRef,
        multiple: true,
        accept:
          ".fit,.gz,.zip,application/zip,application/gzip,application/octet-stream",
        inputLabel: t("settings.sections.export.import.fit.fileInputLabel"),
        onFiles: (files) => void start(files),
      }}
    >
      <ListGroup aria-live="polite" data-testid="import-fit-rows">
        <ImportPickerRow
          multiple
          busy={busy}
          inputRef={fileInputRef}
          meta={pickerMeta ?? t("settings.sections.export.import.fit.fileHint")}
          actionTestId="import-action-fit"
        />
        {!showJob &&
          batch.map((row) => (
            <ListItem
              key={row.key}
              data-testid="import-fit-file"
              data-status={row.state.status}
              title={<span title={row.name}>{row.name}</span>}
              trailing={<FitFileStatus state={row.state} labels={labels} />}
            />
          ))}
        {showJob &&
          isDone &&
          summary.rows.map(({ key, count }) => (
            <ListItem
              key={key}
              data-testid="import-fit-count"
              title={labels.rows[key]}
              trailing={count}
            />
          ))}
      </ListGroup>
    </ImportSource>
  );
}

/** The trailing value: a mark for imported and failed, words otherwise. */
function FitFileStatus({
  state,
  labels,
}: {
  state: FitFileState;
  labels: ReturnType<typeof useFitLabels>;
}) {
  if (state.status === "imported") {
    const label = labels.fileStatus.imported;
    return (
      <span className="text-foreground" title={label}>
        <Check className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  if (state.status === "failed")
    return (
      <span className="text-destructive flex items-center gap-1 text-xs font-normal">
        <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
        {labels.fileFailures[state.reason]}
      </span>
    );
  if (state.status === "uploading") {
    const label = labels.fileStatus.uploading;
    return (
      <span className="text-muted-foreground" title={label}>
        <Loader2
          className="h-4 w-4 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return (
    <span className="text-muted-foreground text-xs font-normal">
      {labels.fileStatus[state.status]}
    </span>
  );
}
