"use client";

/**
 * Settings → Export & Import → Gadgetbridge database, FHIR Bundle.
 *
 * One card per kind, built like the FIT card: upload the file, follow the
 * background job through its status route, show what was imported per kind
 * of row and what the file held that was not, by table or resource type and
 * a closed reason. Nothing from inside the file is ever shown.
 */
import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, FileHeart, Loader2, Upload, Watch } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import {
  recordFileImportFailureCode,
  type RecordFileImportResult,
} from "@/lib/import/file-import/kinds";
import { classifyWrittenOutcome } from "@/lib/outcome/written-outcome";
import { queryKeys } from "@/lib/query-keys";
import { ImportCardShell } from "./import-card-shell";

const TERMINAL_STATES: readonly string[] = ["done", "failed"];

type CardKind = "gadgetbridge" | "fhir_bundle";

const ROUTE: Record<CardKind, string> = {
  gadgetbridge: "/api/import/gadgetbridge",
  fhir_bundle: "/api/import/fhir-bundle",
};

export interface RecordFileImportJob {
  jobId: string;
  status: string;
  result: RecordFileImportResult | null;
  failureReason: string | null;
}

/** Literal `t(...)` calls, so the i18n call-site guard sees every key. */
function useCopy(kind: CardKind) {
  const { t } = useTranslations();
  const k = "settings.sections.export.import.recordFile";
  const perKind =
    kind === "gadgetbridge"
      ? {
          title: t(`${k}.gadgetbridge.title`),
          description: t(`${k}.gadgetbridge.description`),
          steps: [
            t(`${k}.gadgetbridge.steps.export`),
            t(`${k}.gadgetbridge.steps.upload`),
          ],
          accept: "application/octet-stream,application/x-sqlite3,.db,.sqlite",
        }
      : {
          title: t(`${k}.fhirBundle.title`),
          description: t(`${k}.fhirBundle.description`),
          steps: [
            t(`${k}.fhirBundle.steps.export`),
            t(`${k}.fhirBundle.steps.upload`),
          ],
          accept: "application/json,application/fhir+json,.json",
        };
  const failures: Record<string, string> = {
    not_gadgetbridge: t(`${k}.failure.notGadgetbridge`),
    unsafe_schema: t(`${k}.failure.unsafeSchema`),
    not_fhir_bundle: t(`${k}.failure.notFhirBundle`),
    too_many_entries: t(`${k}.failure.tooManyEntries`),
    too_large: t(`${k}.failure.tooLarge`),
    time_budget: t(`${k}.failure.timeBudget`),
    staging_missing: t(`${k}.failure.stagingMissing`),
  };
  return {
    ...perKind,
    failures,
    choose: t(`${k}.choose`),
    uploading: t(`${k}.uploading`),
    running: t(`${k}.running`),
    doneSummary: t(`${k}.doneSummary`),
    doneNothing: t(`${k}.doneNothing`),
    skippedHeading: t(`${k}.skippedHeading`),
    failed: t(`${k}.failed`),
    uploadFailed: t(`${k}.uploadFailed`),
    rateLimited: t(`${k}.rateLimited`),
    tooLargeUpload: t(`${k}.tooLarge`),
    busy: t(`${k}.busy`),
    privacy: t(`${k}.privacyNote`),
    fileInputLabel: t(`${k}.fileInputLabel`),
    lineCounts: (imported: number, duplicates: number) =>
      t(`${k}.lineCounts`, { imported, duplicates }),
  };
}

export function RecordFileImportCard({ kind }: { kind: CardKind }) {
  const copy = useCopy(kind);
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const statusKey = queryKeys.recordFileImportStatus(kind);

  const statusQuery = useQuery({
    queryKey: statusKey,
    refetchInterval: (query) => {
      const job = (
        query.state.data as { job: RecordFileImportJob | null } | undefined
      )?.job;
      return job && !TERMINAL_STATES.includes(job.status) ? 2000 : false;
    },
    queryFn: () =>
      apiGet<{ job: RecordFileImportJob | null }>(`${ROUTE[kind]}/status`, {
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
        const res = await apiFetchRaw(ROUTE[kind], {
          method: "POST",
          credentials: "include",
          body: form,
        });
        if (res.status === 429) return setUploadError(copy.rateLimited);
        if (res.status === 413) return setUploadError(copy.tooLargeUpload);
        if (res.status === 409) return setUploadError(copy.busy);
        if (!res.ok) return setUploadError(copy.uploadFailed);
        await queryClient.invalidateQueries({ queryKey: statusKey });
      } catch {
        setUploadError(copy.uploadFailed);
      } finally {
        setUploading(false);
      }
    },
    [copy, kind, queryClient, statusKey],
  );

  const job = statusQuery.data?.job ?? null;
  const running = job !== null && !TERMINAL_STATES.includes(job.status);
  const busy = uploading || running;
  const result = job?.result ?? null;
  const failure =
    job?.status === "failed" && job.failureReason
      ? (copy.failures[recordFileImportFailureCode(job.failureReason) ?? ""] ??
        copy.failed)
      : null;
  const testId = `import-card-${kind.replace("_", "-")}`;

  return (
    <ImportCardShell
      testId={testId}
      anchor={`import-${kind.replace("_", "-")}`}
      icon={kind === "gadgetbridge" ? Watch : FileHeart}
      title={copy.title}
      description={copy.description}
    >
      <ol className="text-foreground list-decimal space-y-1 pl-4 text-xs">
        {copy.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="text-muted-foreground text-xs">{copy.privacy}</p>

      <div aria-live="polite" className="space-y-2">
        {(uploading || running) && (
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
            {uploading ? copy.uploading : copy.running}
          </p>
        )}
        {result && !running && (
          <ResultView result={result} copy={copy} testId={testId} />
        )}
        {(failure || uploadError) && (
          <p
            role="alert"
            data-testid={`${testId}-error`}
            className="text-destructive flex items-start gap-2 text-sm"
          >
            <AlertCircle
              className="mt-0.5 size-3.5 shrink-0"
              aria-hidden="true"
            />
            <span>{uploadError ?? failure}</span>
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
          onClick={() => inputRef.current?.click()}
          data-testid={`${testId}-choose`}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <Upload className="size-3.5" />
          )}
          {copy.choose}
        </Button>
      </SettingsCardActions>
      <input
        ref={inputRef}
        type="file"
        accept={copy.accept}
        className="sr-only"
        aria-label={copy.fileInputLabel}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
          e.target.value = "";
        }}
      />
    </ImportCardShell>
  );
}

function ResultView({
  result,
  copy,
  testId,
}: {
  result: RecordFileImportResult;
  copy: ReturnType<typeof useCopy>;
  testId: string;
}) {
  const lines = result.lines.filter((l) => l.imported + l.duplicates > 0);
  return (
    <div className="space-y-2">
      <WrittenOutcomeLine
        outcome={classifyWrittenOutcome({
          written: result.imported,
          skipped: result.failed,
        })}
        message={result.imported > 0 ? copy.doneSummary : copy.doneNothing}
        testId={`${testId}-result`}
      />
      {lines.length > 0 && (
        <ul className="text-muted-foreground space-y-0.5 text-xs">
          {lines.map((line) => (
            <li key={line.key} className="flex justify-between gap-2">
              <span className="text-foreground">{line.key}</span>
              <span className="tabular-nums">
                {copy.lineCounts(line.imported, line.duplicates)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {result.skips.length > 0 && (
        <details className="text-xs">
          <summary className="text-foreground cursor-pointer">
            {copy.skippedHeading}
          </summary>
          <ul className="text-muted-foreground mt-1 space-y-0.5">
            {result.skips.map((skip) => (
              <li
                key={`${skip.key}-${skip.reason}`}
                className="flex justify-between gap-2"
              >
                <span className="text-foreground break-all">
                  {skip.key}{" "}
                  <span className="text-muted-foreground">({skip.reason})</span>
                </span>
                <span className="tabular-nums">{skip.count}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
