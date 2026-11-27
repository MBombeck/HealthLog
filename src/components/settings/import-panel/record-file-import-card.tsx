"use client";

/**
 * Settings → Export & Import → Gadgetbridge database, FHIR Bundle.
 *
 * One source row and sheet per kind, built like the FIT source: upload the
 * file, follow the background job through its status route, show what was
 * imported per kind of row and what the file held that was not, by table or
 * resource type and a closed reason. Nothing from inside the file is ever shown.
 */
import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileHeart, Watch } from "lucide-react";

import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";
import { classifyWrittenOutcome } from "@/lib/outcome/written-outcome";
import { useTranslations } from "@/lib/i18n/context";
import {
  recordFileImportFailureCode,
  type RecordFileImportResult,
} from "@/lib/import/file-import/kinds";
import { queryKeys } from "@/lib/query-keys";
import { ListGroup, ListItem } from "@/components/ui/list-row";
import {
  ImportDetails,
  ImportPickerRow,
  ImportSource,
  useFinishedJobMeta,
} from "./import-card-shell";

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
  completedAt?: string | null;
}

/**
 * The card's anchor per kind, written out so the search palette's anchor
 * check (`settings-cards.test.ts`) can find each one.
 */
const RECORD_FILE_IMPORT_ANCHORS: Record<CardKind, { anchor: string }> = {
  gadgetbridge: { anchor: "import-gadgetbridge" },
  fhir_bundle: { anchor: "import-fhir-bundle" },
};

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
          fileHint: t(`${k}.gadgetbridge.fileHint`),
          accept: "application/octet-stream,application/x-sqlite3,.db,.sqlite",
        }
      : {
          title: t(`${k}.fhirBundle.title`),
          description: t(`${k}.fhirBundle.description`),
          steps: [
            t(`${k}.fhirBundle.steps.export`),
            t(`${k}.fhirBundle.steps.upload`),
          ],
          fileHint: t(`${k}.fhirBundle.fileHint`),
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
    fileInputLabel: t(`${k}.fileInputLabel`),
    lineCounts: (imported: number, duplicates: number) =>
      t(`${k}.lineCounts`, { imported, duplicates }),
  };
}

export function RecordFileImportSource({ kind }: { kind: CardKind }) {
  const copy = useCopy(kind);
  const finishedMeta = useFinishedJobMeta();
  const [open, setOpen] = useState(false);
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

  const pickerMeta: React.ReactNode =
    failure || uploadError ? (
      <span
        role="alert"
        data-testid={`${testId}-error`}
        className="text-destructive"
      >
        {uploadError ?? failure}
      </span>
    ) : uploading ? (
      copy.uploading
    ) : running ? (
      copy.running
    ) : result ? (
      <WrittenOutcomeLine
        outcome={classifyWrittenOutcome({
          written: result.imported,
          skipped: result.failed,
        })}
        message={result.imported > 0 ? copy.doneSummary : copy.doneNothing}
        testId={`${testId}-result`}
      />
    ) : (
      copy.fileHint
    );
  const lines =
    result && !running
      ? result.lines.filter((l) => l.imported + l.duplicates > 0)
      : [];
  const skips = result && !running ? result.skips : [];

  const rowMeta = uploading
    ? copy.uploading
    : running
      ? copy.running
      : (finishedMeta(
          job ? { ...job, written: result?.imported ?? 0 } : null,
        ) ?? copy.fileHint);

  return (
    <ImportSource
      testId={testId}
      anchor={RECORD_FILE_IMPORT_ANCHORS[kind].anchor}
      icon={kind === "gadgetbridge" ? Watch : FileHeart}
      title={copy.title}
      info={[copy.description, ...copy.steps]}
      meta={rowMeta}
      status={busy ? "running" : failure || uploadError ? "failed" : null}
      open={open}
      onOpenChange={setOpen}
      query={statusQuery}
      chooseTestId={`${testId}-open`}
      fileInputRef={inputRef}
      file={{
        accept: copy.accept,
        inputLabel: copy.fileInputLabel,
        onFiles: ([file]) => void upload(file!),
      }}
    >
      <ListGroup aria-live="polite">
        <ImportPickerRow
          busy={busy}
          inputRef={inputRef}
          meta={pickerMeta}
          actionTestId={`${testId}-choose`}
          onFiles={([file]) => void upload(file!)}
        />
        {lines.map((line) => (
          <ListItem
            key={line.key}
            title={line.key}
            meta={copy.lineCounts(line.imported, line.duplicates)}
          />
        ))}
      </ListGroup>
      {skips.length > 0 && (
        <ImportDetails>
          <p>{copy.skippedHeading}</p>
          {skips.map((skip) => (
            <p key={`${skip.key}-${skip.reason}`} className="break-all">
              {skip.key} ({skip.reason}): {skip.count}
            </p>
          ))}
        </ImportDetails>
      )}
    </ImportSource>
  );
}
