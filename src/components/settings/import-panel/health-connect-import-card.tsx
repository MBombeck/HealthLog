"use client";

/**
 * v1.42 (#972) — Settings → Export & Import → Health Connect export.
 *
 * Uploads the ZIP the Android Health Connect app writes and follows the
 * background import through `GET /api/import/health-connect-export/status`,
 * which answers the account's latest job, so the outcome is still there
 * after a reload. Health Connect only exports to a cloud storage app, never
 * to the phone's own storage; the (i) says so, because that is
 * where people get stuck. Fetching the same export from a WebDAV folder is
 * a connection under Settings › Integrations; the sheet has a row to it.
 */
import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Smartphone } from "lucide-react";

import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";
import { classifyWrittenOutcome } from "@/lib/outcome/written-outcome";
import { useTranslations } from "@/lib/i18n/context";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/lib/measurements/type-label-keys";
import { queryKeys } from "@/lib/query-keys";
import type { MeasurementType } from "@/generated/prisma/client";
import { ListGroup, ListItem } from "@/components/ui/list-row";
import {
  ImportDetails,
  ImportPickerRow,
  ImportSource,
  useFinishedJobMeta,
} from "./import-card-shell";

/** The folder source's sheet on the integrations page. */
const HEALTH_CONNECT_FOLDER_HREF =
  "/settings/integrations#health-connect-remote";

const TERMINAL_STATES: readonly string[] = ["done", "failed"];

interface TypeStat {
  inserted?: number;
  updated?: number;
  skipped?: number;
}

/** The job as the status route answers it. Counts only. */
export interface HealthConnectJob {
  jobId: string;
  status: string;
  progress: { rowsUpserted?: number; recordsRead?: number } | null;
  result: {
    perType?: Record<string, TypeStat>;
    perApp?: Record<string, { records?: number; leftOut?: boolean }>;
    workouts?: { inserted?: number };
    cycle?: { written?: number; moduleOff?: boolean };
    nutrients?: { written?: number; moduleOff?: boolean };
    totals?: { rowsUpserted?: number; recordsRead?: number };
    warnings?: string[];
    skipped?: Record<string, number>;
  } | null;
  failureReason: string | null;
  completedAt?: string | null;
}

/** The failure code at the front of a worker reason, when there is one. */
export function healthConnectFailureKind(
  reason: string | null,
):
  | "unsupportedVersion"
  | "notHealthConnect"
  | "unsafeSchema"
  | "tooLarge"
  | "stagingMissing"
  | "interrupted"
  | "raw"
  | null {
  if (!reason) return null;
  if (reason === "interrupted_by_restart") return "interrupted";
  if (reason.startsWith("unsupported_version")) return "unsupportedVersion";
  if (reason.startsWith("not_health_connect")) return "notHealthConnect";
  if (reason.startsWith("unsafe_schema")) return "unsafeSchema";
  if (reason.startsWith("too_large")) return "tooLarge";
  if (reason.startsWith("staging_missing")) return "stagingMissing";
  return "raw";
}

/** What the result line and the per-type list show. */
export function summarizeHealthConnectResult(
  result: HealthConnectJob["result"],
): {
  written: number;
  refused: number;
  types: Array<{ type: string; written: number }>;
  leftOutRecords: number;
} {
  const types: Array<{ type: string; written: number }> = [];
  let refused = 0;
  for (const [type, stat] of Object.entries(result?.perType ?? {})) {
    const written = (stat.inserted ?? 0) + (stat.updated ?? 0);
    if (written > 0) types.push({ type, written });
  }
  types.sort((a, b) => b.written - a.written);
  let leftOutRecords = 0;
  for (const app of Object.values(result?.perApp ?? {})) {
    if (app.leftOut) leftOutRecords += app.records ?? 0;
  }
  for (const [reason, count] of Object.entries(result?.skipped ?? {})) {
    if (/::(out_of_range|write_failed|unreadable_record)$/.test(reason)) {
      refused += count;
    }
  }
  return {
    written: result?.totals?.rowsUpserted ?? 0,
    refused,
    types,
    leftOutRecords,
  };
}

export function HealthConnectImportSource() {
  const { t } = useTranslations();
  const finishedMeta = useFinishedJobMeta();
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: queryKeys.healthConnectImportStatus(),
    refetchInterval: (query) => {
      const job = (
        query.state.data as { job: HealthConnectJob | null } | undefined
      )?.job;
      return job && !TERMINAL_STATES.includes(job.status) ? 2000 : false;
    },
    queryFn: () =>
      apiGet<{ job: HealthConnectJob | null }>(
        "/api/import/health-connect-export/status",
        { credentials: "include" },
      ),
  });

  const upload = useCallback(
    async (file: File) => {
      setUploadError(null);
      setUploading(true);
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await apiFetchRaw("/api/import/health-connect-export", {
          method: "POST",
          credentials: "include",
          body: form,
        });
        if (res.status === 429)
          return setUploadError(
            t("settings.sections.export.import.healthConnect.rateLimited"),
          );
        if (res.status === 413)
          return setUploadError(
            t("settings.sections.export.import.healthConnect.tooLarge"),
          );
        if (res.status === 409)
          return setUploadError(
            t("settings.sections.export.import.healthConnect.busy"),
          );
        if (!res.ok)
          return setUploadError(
            t("settings.sections.export.import.healthConnect.uploadFailed"),
          );
        await queryClient.invalidateQueries({
          queryKey: queryKeys.healthConnectImportStatus(),
        });
      } catch {
        setUploadError(
          t("settings.sections.export.import.healthConnect.uploadFailed"),
        );
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
  const summary = summarizeHealthConnectResult(job?.result ?? null);

  const failureText = (() => {
    const reason = job?.failureReason ?? null;
    const kind = healthConnectFailureKind(reason);
    if (kind === null) return null;
    if (kind === "raw")
      return t("settings.sections.export.import.healthConnect.failed", {
        reason: reason ?? "",
      });
    return t(`settings.sections.export.import.healthConnect.failure.${kind}`);
  })();

  // The picker row's meta says where things stand; with nothing running it
  // says what the row takes.
  const pickerMeta: React.ReactNode =
    uploadError || isFailed ? (
      <span
        data-testid="import-health-connect-error"
        role="alert"
        className="text-destructive"
      >
        {uploadError ??
          failureText ??
          t("settings.sections.export.import.healthConnect.uploadFailed")}
      </span>
    ) : uploading ? (
      t("settings.sections.export.import.healthConnect.uploading")
    ) : isRunning ? (
      <span data-testid="import-health-connect-progress">
        {typeof job?.progress?.rowsUpserted === "number"
          ? t("settings.sections.export.import.healthConnect.rowsSoFar", {
              count: job.progress.rowsUpserted,
            })
          : t(
              `settings.sections.export.import.healthConnect.phase.${job?.status ?? "queued"}`,
            )}
      </span>
    ) : isDone ? (
      <WrittenOutcomeLine
        outcome={classifyWrittenOutcome({
          written: summary.written,
          skipped: summary.refused,
        })}
        message={
          summary.written > 0
            ? t("settings.sections.export.import.healthConnect.doneSummary", {
                count: summary.written,
              })
            : t("settings.sections.export.import.healthConnect.doneNothing")
        }
        testId="import-health-connect-result"
      />
    ) : (
      t("settings.sections.export.import.healthConnect.fileHint")
    );
  const workouts = job?.result?.workouts?.inserted ?? 0;
  const notes = isDone
    ? [
        summary.leftOutRecords > 0 &&
          t("settings.sections.export.import.healthConnect.leftOutConnected", {
            count: summary.leftOutRecords,
          }),
        job?.result?.nutrients?.moduleOff &&
          t("settings.sections.export.import.healthConnect.nutrientsModuleOff"),
        job?.result?.cycle?.moduleOff &&
          t("settings.sections.export.import.healthConnect.cycleModuleOff"),
      ].filter((note): note is string => typeof note === "string")
    : [];

  const rowMeta = uploading
    ? t("settings.sections.export.import.healthConnect.uploading")
    : isRunning
      ? t(
          `settings.sections.export.import.healthConnect.phase.${job?.status ?? "queued"}`,
        )
      : (finishedMeta(job ? { ...job, written: summary.written } : null) ??
        t("settings.sections.export.import.healthConnect.fileHint"));

  return (
    <ImportSource
      testId="import-card-health-connect"
      anchor="import-health-connect"
      icon={Smartphone}
      title={t("settings.sections.export.import.healthConnect.title")}
      info={[
        t("settings.sections.export.import.healthConnect.description"),
        t("settings.sections.export.import.healthConnect.steps.export"),
        t("settings.sections.export.import.healthConnect.steps.cloud"),
        t("settings.sections.export.import.healthConnect.steps.upload"),
        t("settings.sections.export.import.healthConnect.privacyNote"),
      ]}
      meta={rowMeta}
      status={busy ? "running" : uploadError || isFailed ? "failed" : null}
      open={open}
      onOpenChange={setOpen}
      query={statusQuery}
      chooseTestId="import-choose-health-connect"
      fileInputRef={fileInputRef}
      file={{
        accept: ".zip,application/zip",
        inputLabel: t(
          "settings.sections.export.import.healthConnect.fileInputLabel",
        ),
        onFiles: ([file]) => void upload(file!),
      }}
    >
      <ListGroup aria-live="polite">
        <ImportPickerRow
          busy={busy}
          inputRef={fileInputRef}
          meta={pickerMeta}
          actionTestId="import-action-health-connect"
          onFiles={([file]) => void upload(file!)}
        />
        {isDone &&
          summary.types.map(({ type, written }) => (
            <ListItem
              key={type}
              data-testid="import-health-connect-type"
              title={
                MEASUREMENT_TYPE_LABEL_KEYS[type as MeasurementType]
                  ? t(MEASUREMENT_TYPE_LABEL_KEYS[type as MeasurementType])
                  : type
              }
              trailing={written}
            />
          ))}
        {isDone && workouts > 0 && (
          <ListItem
            title={t("settings.sections.export.import.healthConnect.workouts")}
            trailing={workouts}
          />
        )}
      </ListGroup>
      {notes.length > 0 && (
        <ImportDetails>
          {notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </ImportDetails>
      )}
      {/* The same export fetched from a WebDAV folder on a schedule is a
          connection, set up under Integrations; this row leads there. */}
      <ListGroup>
        <ListItem
          data-testid="import-health-connect-folder"
          href={HEALTH_CONNECT_FOLDER_HREF}
          title={t("settings.sections.export.import.healthConnect.folderRow")}
          meta={t("settings.sections.export.import.healthConnect.folderMeta")}
        />
      </ListGroup>
    </ImportSource>
  );
}
