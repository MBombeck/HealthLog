"use client";

import { useCallback, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Loader2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Progress } from "@/components/ui/progress";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { ImportCardShell } from "./import-card-shell";
import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";
import { classifyWrittenOutcome } from "@/lib/outcome/written-outcome";

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
    /** HK types deferred by design — read but not (yet) imported. */
    deferred?: Record<string, number>;
    /** Per-key drop counters — plain HK types are unsupported-by-design,
     *  `key::reason`-tagged entries are genuine refusals. */
    unknown?: Record<string, number>;
    cycle?: {
      samplesConsumed?: number;
      samplesSkippedModuleDisabled?: number;
      daysUpserted?: number;
      daysFailed?: number;
      firstFailureReason?: string | null;
    };
    ecg?: {
      discovered?: number;
      imported?: number;
      updated?: number;
      skipped?: number;
      failed?: number;
    };
  } | null;
  failureReason: string | null;
}

/** One skip line for the result breakdown. */
export interface AppleHealthSkipEntry {
  key: string;
  count: number;
}

export interface AppleHealthSkipSummary {
  /** Samples of data types HealthLog does not import (deliberate). */
  unsupported: number;
  /** Samples that SHOULD have landed but were refused (unreadable value,
   *  out-of-range, upsert failure, unmapped cycle value, …). */
  refused: number;
  /** Per-key counts behind both totals, largest first. */
  breakdown: AppleHealthSkipEntry[];
}

/**
 * Fold the worker's drop counters into the three numbers the card renders.
 *
 * The split is deliberate: an Apple export always carries types HealthLog
 * does not import, so "unsupported" is information, not a warning — while a
 * tagged refusal (`::unparseable`, `::out_of_range`, `::upsert_failed`, …)
 * means a sample that SHOULD have landed did not, and that is what tips the
 * outcome tone. `element::` counters are structural XML elements, not
 * samples, and are excluded entirely. Exported for the unit contract.
 */
export function summarizeAppleHealthSkips(
  result: JobStatus["result"],
): AppleHealthSkipSummary {
  const unknown = result?.unknown ?? {};
  const deferred = result?.deferred ?? {};
  let unsupported = 0;
  let refused = 0;
  const breakdown: AppleHealthSkipEntry[] = [];
  for (const [key, count] of Object.entries(unknown)) {
    if (typeof count !== "number" || count <= 0) continue;
    if (key.startsWith("element::")) continue;
    if (key.includes("::")) refused += count;
    else unsupported += count;
    breakdown.push({ key, count });
  }
  for (const [key, count] of Object.entries(deferred)) {
    if (typeof count !== "number" || count <= 0) continue;
    unsupported += count;
    breakdown.push({ key, count });
  }
  breakdown.sort((a, b) => b.count - a.count);
  return { unsupported, refused, breakdown };
}

/**
 * Classify a worker `failureReason` for display. The worker writes two
 * machine-readable reasons — the reconcile's bare `interrupted_by_restart`
 * code and the memory preflight's `insufficient_memory`-prefixed string
 * (issue #775) — which must surface as translated, actionable copy
 * instead of a raw code. Anything else is honest English free text from
 * the parse and passes through verbatim. Exported for the SSR contract
 * suite.
 */
export function appleHealthFailureKind(
  reason: string | null,
): "interrupted" | "insufficientMemory" | "raw" | null {
  if (reason === null || reason.length === 0) return null;
  if (reason === "interrupted_by_restart") return "interrupted";
  if (reason.startsWith("insufficient_memory")) return "insufficientMemory";
  return "raw";
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

/** How many per-type lines the breakdown shows before folding the rest. */
const SKIP_BREAKDOWN_MAX_LINES = 15;

/**
 * The grouped skip lines under the outcome sentence — modeled on the
 * medication intake import's result: every drop class the worker counts
 * is rendered, none is silently swallowed into an unexplained
 * read-vs-imported gap.
 */
export function AppleHealthSkipLines({
  skips,
  cycle,
}: {
  skips: AppleHealthSkipSummary;
  cycle: NonNullable<JobStatus["result"]>["cycle"] | undefined;
}) {
  const { t } = useTranslations();
  const cycleDays = cycle?.daysUpserted ?? 0;
  const cycleSamples = cycle?.samplesConsumed ?? 0;
  const cycleModuleOff = cycle?.samplesSkippedModuleDisabled ?? 0;
  const cycleFailed = cycle?.daysFailed ?? 0;
  const hasAnything =
    skips.unsupported > 0 ||
    skips.refused > 0 ||
    cycleDays > 0 ||
    cycleModuleOff > 0 ||
    cycleFailed > 0;
  if (!hasAnything) return null;

  const shown = skips.breakdown.slice(0, SKIP_BREAKDOWN_MAX_LINES);
  const omitted = skips.breakdown.length - shown.length;

  return (
    <div
      data-testid="apple-health-skip-lines"
      className="text-muted-foreground space-y-0.5 text-xs"
    >
      {cycleDays > 0 && (
        <p data-testid="apple-health-cycle-summary">
          {t("settings.sections.export.import.appleHealth.cycleSummary", {
            samples: cycleSamples,
            days: cycleDays,
          })}
        </p>
      )}
      {cycleModuleOff > 0 && (
        <p data-testid="apple-health-cycle-module-off">
          {t("settings.sections.export.import.appleHealth.cycleModuleOff", {
            count: cycleModuleOff,
          })}
        </p>
      )}
      {cycleFailed > 0 && (
        <p
          data-testid="apple-health-cycle-days-failed"
          className="text-destructive"
        >
          {t("settings.sections.export.import.appleHealth.cycleDaysFailed", {
            count: cycleFailed,
            reason: cycle?.firstFailureReason ?? "—",
          })}
        </p>
      )}
      {skips.unsupported > 0 && (
        <p data-testid="apple-health-skip-unsupported">
          {t("settings.sections.export.import.appleHealth.skipUnsupported", {
            count: skips.unsupported,
          })}
        </p>
      )}
      {skips.refused > 0 && (
        <p data-testid="apple-health-skip-refused">
          {t("settings.sections.export.import.appleHealth.skipRefused", {
            count: skips.refused,
          })}
        </p>
      )}
      {skips.breakdown.length > 0 && (
        <details data-testid="apple-health-skip-breakdown">
          <summary className="cursor-pointer">
            {t("settings.sections.export.import.appleHealth.skipBreakdown", {
              count: skips.breakdown.length,
            })}
          </summary>
          <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto pl-4">
            {shown.map((entry) => (
              <li key={entry.key}>
                {entry.key}: {entry.count}
              </li>
            ))}
          </ul>
          {omitted > 0 && (
            <p className="mt-1">
              {t(
                "settings.sections.export.import.appleHealth.skipBreakdownMore",
                { count: omitted },
              )}
            </p>
          )}
        </details>
      )}
    </div>
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
  const failureText = (() => {
    const reason = status?.failureReason ?? null;
    switch (appleHealthFailureKind(reason)) {
      case "interrupted":
        return t(
          "settings.sections.export.import.appleHealth.failureInterrupted",
        );
      case "insufficientMemory":
        return t(
          "settings.sections.export.import.appleHealth.failureInsufficientMemory",
        );
      case "raw":
        return reason;
      default:
        return null;
    }
  })();
  const ecg = status?.result?.ecg;
  const ecgWritten = (ecg?.imported ?? 0) + (ecg?.updated ?? 0);
  const skips = summarizeAppleHealthSkips(status?.result ?? null);
  const cycleStats = status?.result?.cycle;

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
          <WrittenOutcomeLine
            outcome={classifyWrittenOutcome({
              written: (status?.result?.totals?.rowsUpserted ?? 0) + ecgWritten,
              // Deliberate exclusions (clinical records, unsupported /
              // deferred types, a disabled cycle module) are information
              // and must not tip the archive into a warning. Genuine
              // refusals — samples that SHOULD have landed (unparseable,
              // out of range, upsert failure) plus failed cycle days — do.
              skipped: skips.refused + (cycleStats?.daysFailed ?? 0),
            })}
            message={
              (status?.result?.totals?.rowsUpserted ?? 0) > 0
                ? t("settings.sections.export.import.appleHealth.doneSummary", {
                    imported: status?.result?.totals?.rowsUpserted ?? 0,
                    read: status?.result?.totals?.recordsRead ?? 0,
                    skipped: status?.result?.clinical?.skipped ?? 0,
                  })
                : t("settings.sections.export.import.appleHealth.doneNothing", {
                    read: status?.result?.totals?.recordsRead ?? 0,
                  })
            }
            testId="import-apple-health-result"
          />
        )}
        {isDone && <AppleHealthSkipLines skips={skips} cycle={cycleStats} />}
        {isDone && (ecg?.discovered ?? 0) > 0 && (
          <p
            data-testid="import-apple-health-ecg-result"
            className="text-muted-foreground text-xs"
          >
            {t("settings.sections.export.import.appleHealth.ecgResult", {
              discovered: ecg?.discovered ?? 0,
              imported: ecg?.imported ?? 0,
              updated: ecg?.updated ?? 0,
              skipped: ecg?.skipped ?? 0,
              failed: ecg?.failed ?? 0,
            })}
          </p>
        )}
        {isDone && (status?.result?.cumulativeEstimates?.days ?? 0) > 0 && (
          <AppleHealthEstimateWarning
            days={status?.result?.cumulativeEstimates?.days ?? 0}
          />
        )}
        {(isFailed || uploadError) && (
          <p
            data-testid="import-apple-health-error"
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
                t("settings.sections.export.import.appleHealth.failed")}
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
          data-testid="import-action-apple-health"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          {t("settings.sections.export.import.appleHealth.choose")}
        </Button>
      </SettingsCardActions>
    </ImportCardShell>
  );
}
