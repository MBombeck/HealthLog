"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Upload } from "lucide-react";

import {
  cycleDependentKeys,
  invalidateKeys,
  labDependentKeys,
  measurementDependentKeys,
  queryKeys,
  refetchInactiveDailyReads,
  workoutDependentKeys,
} from "@/lib/query-keys";
import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";
import { classifyWrittenOutcome } from "@/lib/outcome/written-outcome";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import {
  AppleHealthAuxiliaryLines,
  type AppleHealthEcgCounts,
  type AppleHealthLabCounts,
} from "./apple-health-auxiliary-lines";
import {
  ImportCardShell,
  ImportDetails,
  ImportInfo,
  ImportPickerRow,
  ImportQueryErrorRow,
  ImportRows,
} from "./import-card-shell";

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
    /** Records HealthLog wrote into Apple Health itself, left out here. */
    writtenByHealthLog?: {
      byMarker?: number;
      byExternalId?: number;
      matchedManual?: number;
    };
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
    ecg?: AppleHealthEcgCounts;
    labs?: AppleHealthLabCounts;
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

/** How many records the import left out because HealthLog wrote them. */
export function AppleHealthOwnRecordsNote({ count }: { count: number }) {
  const { tCount } = useTranslations();
  return (
    <p
      data-testid="import-apple-health-own-skipped"
      className="text-muted-foreground text-xs"
    >
      {tCount(
        "settings.sections.export.import.appleHealth.writtenByHealthLog",
        count,
      )}
    </p>
  );
}

/**
 * Which sentence heads a finished import. The archive's own samples decide
 * the "N of M imported" line; an archive whose only new data is lab results
 * or ECGs gets its own sentence instead of "0 of M imported" under a success
 * outcome; nothing written at all is the "nothing was imported" line.
 * Exported for the SSR contract suite.
 */
export function appleHealthDoneSummaryKind(
  rowsWritten: number,
  auxWritten: number,
): "samples" | "auxOnly" | "nothing" {
  if (rowsWritten > 0) return "samples";
  return auxWritten > 0 ? "auxOnly" : "nothing";
}

/** The sentence that heads a finished import (see `appleHealthDoneSummaryKind`). */
function appleHealthDoneMessage(
  counts: {
    rowsWritten: number;
    auxWritten: number;
    recordsRead: number;
    clinicalSkipped: number;
  },
  t: (key: string, params?: Record<string, string | number>) => string,
  fmt: { integer: (value: number) => string },
): string {
  const read = fmt.integer(counts.recordsRead);
  switch (appleHealthDoneSummaryKind(counts.rowsWritten, counts.auxWritten)) {
    case "samples":
      return t("settings.sections.export.import.appleHealth.doneSummary", {
        imported: fmt.integer(counts.rowsWritten),
        read,
        skipped: fmt.integer(counts.clinicalSkipped),
      });
    case "auxOnly":
      return t(
        "settings.sections.export.import.appleHealth.doneSummaryAuxOnly",
        {
          read,
        },
      );
    default:
      return t("settings.sections.export.import.appleHealth.doneNothing", {
        read,
      });
  }
}

/**
 * The job writes measurements, workouts, cycle days, lab results and ECGs
 * behind the session's back, so every read of those stays on its pre-import
 * answer until its stale time runs out. Once per finished job, evict them the
 * way a write from those surfaces does (the dose-history import card does the
 * same for medication reads).
 */
function useRefreshReadsAfterImport(finishedJobId: string | null): void {
  const queryClient = useQueryClient();
  const refreshedJobRef = useRef<string | null>(null);
  useEffect(() => {
    if (!finishedJobId || refreshedJobRef.current === finishedJobId) return;
    refreshedJobRef.current = finishedJobId;
    void invalidateKeys(queryClient, [
      ...measurementDependentKeys,
      ...workoutDependentKeys,
      ...cycleDependentKeys,
      ...labDependentKeys,
    ]).then(() => refetchInactiveDailyReads(queryClient));
  }, [finishedJobId, queryClient]);
}

export function AppleHealthImportCard() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

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

  const status = statusQuery.data ?? null;
  const isRunning = status !== null && !TERMINAL_STATES.includes(status.status);
  const isDone = status?.status === "done";

  useRefreshReadsAfterImport(isDone ? (status?.jobId ?? null) : null);
  const ownRecordsSkipped =
    (status?.result?.writtenByHealthLog?.byMarker ?? 0) +
    (status?.result?.writtenByHealthLog?.byExternalId ?? 0) +
    (status?.result?.writtenByHealthLog?.matchedManual ?? 0);
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
  const labs = status?.result?.labs;
  const rowsWritten = status?.result?.totals?.rowsUpserted ?? 0;
  const recordsRead = status?.result?.totals?.recordsRead ?? 0;
  const auxWritten =
    (ecg?.imported ?? 0) + (ecg?.updated ?? 0) + (labs?.imported ?? 0);
  const skips = summarizeAppleHealthSkips(status?.result ?? null);
  const clinicalSkipped = status?.result?.clinical?.skipped ?? 0;
  const cycleStats = status?.result?.cycle;

  const pickerMeta: React.ReactNode =
    uploadError || isFailed ? (
      <span
        data-testid="import-apple-health-error"
        role="alert"
        className="text-destructive"
      >
        {uploadError ??
          failureText ??
          t("settings.sections.export.import.appleHealth.failed")}
      </span>
    ) : uploading ? (
      t("settings.sections.export.import.appleHealth.uploading")
    ) : isRunning ? (
      <span data-testid="import-apple-health-progress" className="tabular-nums">
        {typeof status?.progress?.rowsUpserted === "number"
          ? t("settings.sections.export.import.appleHealth.rowsImported", {
              count: fmt.integer(status.progress.rowsUpserted),
            })
          : t(
              `settings.sections.export.import.appleHealth.phase.${status?.status ?? "queued"}`,
            )}
        {typeof percent === "number" && ` (${fmt.integer(percent)} %)`}
      </span>
    ) : isDone ? (
      <WrittenOutcomeLine
        outcome={classifyWrittenOutcome({
          written: rowsWritten + auxWritten,
          // Deliberate exclusions (clinical records, unsupported or deferred
          // types, a disabled cycle module) are information and must not
          // tip the archive into a warning. Genuine refusals, samples that
          // should have landed plus failed cycle days, do.
          skipped:
            skips.refused + (cycleStats?.daysFailed ?? 0) + (labs?.failed ?? 0),
        })}
        message={appleHealthDoneMessage(
          { rowsWritten, auxWritten, recordsRead, clinicalSkipped },
          t,
          fmt,
        )}
        testId="import-apple-health-result"
      />
    ) : (
      t("settings.sections.export.import.appleHealth.fileHint")
    );
  const estimateDays = status?.result?.cumulativeEstimates?.days ?? 0;

  return (
    <ImportCardShell
      testId="import-card-apple-health"
      anchor="import-apple-health"
      icon={Upload}
      title={t("settings.sections.export.import.appleHealth.title")}
      titleAccessory={
        <ImportInfo
          lines={[
            t("settings.sections.export.import.appleHealth.description"),
            t("settings.sections.export.import.appleHealth.idempotencyNote"),
          ]}
        />
      }
      rows
    >
      <ImportQueryErrorRow query={statusQuery} />
      <ImportRows aria-live="polite">
        <ImportPickerRow
          busy={busy}
          inputRef={fileInputRef}
          accept=".zip,application/zip"
          inputLabel={t(
            "settings.sections.export.import.appleHealth.fileInputLabel",
          )}
          meta={pickerMeta}
          actionTestId="import-action-apple-health"
          onFiles={([file]) => void upload(file!)}
        />
      </ImportRows>
      {isDone && (
        <AppleHealthDetails
          skips={skips}
          cycle={cycleStats}
          ecg={ecg}
          labs={labs}
          ownRecordsSkipped={ownRecordsSkipped}
          estimateDays={estimateDays}
        />
      )}
    </ImportCardShell>
  );
}

/** What a finished import adds under the picker row, at the meta size. */
function AppleHealthDetails({
  skips,
  cycle,
  ecg,
  labs,
  ownRecordsSkipped,
  estimateDays,
}: {
  skips: AppleHealthSkipSummary;
  cycle: NonNullable<JobStatus["result"]>["cycle"] | undefined;
  ecg: AppleHealthEcgCounts | undefined;
  labs: AppleHealthLabCounts | undefined;
  ownRecordsSkipped: number;
  estimateDays: number;
}) {
  const hasSkips =
    skips.unsupported > 0 ||
    skips.refused > 0 ||
    skips.breakdown.length > 0 ||
    (cycle?.daysUpserted ?? 0) > 0 ||
    (cycle?.samplesSkippedModuleDisabled ?? 0) > 0 ||
    (cycle?.daysFailed ?? 0) > 0;
  const hasAux = (ecg?.discovered ?? 0) > 0 || (labs?.discovered ?? 0) > 0;
  if (!hasSkips && !hasAux && ownRecordsSkipped === 0 && estimateDays === 0)
    return null;
  return (
    <ImportDetails>
      <AppleHealthSkipLines skips={skips} cycle={cycle} />
      <AppleHealthAuxiliaryLines ecg={ecg} labs={labs} />
      {ownRecordsSkipped > 0 && (
        <AppleHealthOwnRecordsNote count={ownRecordsSkipped} />
      )}
      {estimateDays > 0 && <AppleHealthEstimateWarning days={estimateDays} />}
    </ImportDetails>
  );
}
