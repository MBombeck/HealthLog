"use client";

/**
 * v1.42 (#972) — Settings → Export & Import → Health Connect export.
 *
 * Uploads the ZIP the Android Health Connect app writes and follows the
 * background import through `GET /api/import/health-connect-export/status`,
 * which answers the account's latest job, so the outcome is still there
 * after a reload. Health Connect only exports to a cloud storage app, never
 * to the phone's own storage; the card says so up front, because that is
 * where people get stuck.
 */
import { useCallback, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2, Smartphone, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/lib/measurements/type-label-keys";
import { classifyWrittenOutcome } from "@/lib/outcome/written-outcome";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type { MeasurementType } from "@/generated/prisma/client";
import { ImportCardShell } from "./import-card-shell";

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

export function HealthConnectImportCard() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const dropDescId = useId();

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

  return (
    <ImportCardShell
      testId="import-card-health-connect"
      icon={Smartphone}
      title={t("settings.sections.export.import.healthConnect.title")}
      description={t(
        "settings.sections.export.import.healthConnect.description",
      )}
    >
      <ol className="text-foreground list-decimal space-y-1 pl-4 text-xs">
        <li>
          {t("settings.sections.export.import.healthConnect.steps.export")}
        </li>
        <li>
          {t("settings.sections.export.import.healthConnect.steps.cloud")}
        </li>
        <li>
          {t("settings.sections.export.import.healthConnect.steps.upload")}
        </li>
      </ol>

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
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          const file = e.dataTransfer.files?.[0];
          if (file && !busy) void upload(file);
        }}
        className={cn(
          "border-border bg-muted/20 hover:bg-muted/40 focus-visible:ring-ring/50 flex min-h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-4 text-center transition-colors focus-visible:ring-2 focus-visible:outline-none",
          dragActive && "border-primary bg-primary/5",
          busy && "pointer-events-none opacity-60",
        )}
      >
        <Upload className="text-muted-foreground h-5 w-5" aria-hidden="true" />
        <span className="text-foreground text-sm font-medium">
          {t("settings.sections.export.import.healthConnect.dropLabel")}
        </span>
        <span id={dropDescId} className="text-muted-foreground text-xs">
          {t("settings.sections.export.import.healthConnect.dropHint")}
        </span>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,application/zip"
        className="sr-only"
        aria-label={t(
          "settings.sections.export.import.healthConnect.fileInputLabel",
        )}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
          e.target.value = "";
        }}
      />

      <p className="text-muted-foreground text-xs">
        {t("settings.sections.export.import.healthConnect.privacyNote")}
      </p>

      <div aria-live="polite" className="space-y-2">
        {uploading && (
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            {t("settings.sections.export.import.healthConnect.uploading")}
          </p>
        )}
        {isRunning && (
          <div
            data-testid="import-health-connect-progress"
            className="space-y-1"
          >
            <p className="text-muted-foreground flex items-center gap-2 text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              {t(
                `settings.sections.export.import.healthConnect.phase.${job?.status ?? "queued"}`,
              )}
            </p>
            {typeof job?.progress?.rowsUpserted === "number" && (
              <p className="text-muted-foreground text-xs">
                {t("settings.sections.export.import.healthConnect.rowsSoFar", {
                  count: job.progress.rowsUpserted,
                })}
              </p>
            )}
          </div>
        )}
        {isDone && (
          <WrittenOutcomeLine
            outcome={classifyWrittenOutcome({
              written: summary.written,
              skipped: summary.refused,
            })}
            message={
              summary.written > 0
                ? t(
                    "settings.sections.export.import.healthConnect.doneSummary",
                    { count: summary.written },
                  )
                : t("settings.sections.export.import.healthConnect.doneNothing")
            }
            testId="import-health-connect-result"
          />
        )}
        {isDone && summary.types.length > 0 && (
          <ul
            data-testid="import-health-connect-types"
            className="text-muted-foreground space-y-0.5 text-xs"
          >
            {summary.types.map(({ type, written }) => (
              <li key={type} className="flex justify-between gap-2">
                <span className="text-foreground">
                  {MEASUREMENT_TYPE_LABEL_KEYS[type as MeasurementType]
                    ? t(MEASUREMENT_TYPE_LABEL_KEYS[type as MeasurementType])
                    : type}
                </span>
                <span className="tabular-nums">{written}</span>
              </li>
            ))}
            {(job?.result?.workouts?.inserted ?? 0) > 0 && (
              <li className="flex justify-between gap-2">
                <span className="text-foreground">
                  {t("settings.sections.export.import.healthConnect.workouts")}
                </span>
                <span className="tabular-nums">
                  {job?.result?.workouts?.inserted}
                </span>
              </li>
            )}
          </ul>
        )}
        {isDone && summary.leftOutRecords > 0 && (
          <p className="text-muted-foreground text-xs">
            {t(
              "settings.sections.export.import.healthConnect.leftOutConnected",
              { count: summary.leftOutRecords },
            )}
          </p>
        )}
        {isDone && job?.result?.nutrients?.moduleOff && (
          <p className="text-muted-foreground text-xs">
            {t(
              "settings.sections.export.import.healthConnect.nutrientsModuleOff",
            )}
          </p>
        )}
        {isDone && job?.result?.cycle?.moduleOff && (
          <p className="text-muted-foreground text-xs">
            {t("settings.sections.export.import.healthConnect.cycleModuleOff")}
          </p>
        )}
        {(isFailed || uploadError) && (
          <p
            data-testid="import-health-connect-error"
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
                t("settings.sections.export.import.healthConnect.uploadFailed")}
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
          data-testid="import-action-health-connect"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          {t("settings.sections.export.import.healthConnect.choose")}
        </Button>
      </SettingsCardActions>
    </ImportCardShell>
  );
}
