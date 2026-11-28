"use client";

/**
 * Import a dose history exported from another medication tracker.
 *
 * Account-wide, because such a file covers a whole regimen — the per-medication
 * import dialog on a medication's own page stays what it is, a way to add dates
 * and times for that one medication.
 *
 * Preview first. The dry run returns the entire verdict — how many rows land, how
 * many are refused and under which reason, which medication names match nothing
 * on the record — before a single row is written. Importing years of history
 * unseen is not something to ask of anybody.
 *
 * The outcome renders through `IntakeImportResultView`, the same component the
 * per-medication dialog uses, so a run that wrote nothing cannot carry a success
 * tick here either and the skip reasons are grouped with a count rather than
 * repeated per row.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, PillBottle } from "lucide-react";

import {
  IntakeImportResultView,
  type IntakeImportResultState,
} from "@/components/medications/intake-import-result";
import { Button } from "@/components/ui/button";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import {
  MedicationIntakeImportTimeout,
  waitForMedicationIntakeImport,
} from "@/lib/medications/intake-import-poll";
import { invalidateMedicationReads } from "@/lib/query-keys";

import { DoseHistoryColumnRulings } from "./dose-history-columns";
import {
  DoseHistoryVerdictView,
  type DoseHistoryFileVerdict,
} from "./dose-history-verdict";
import { ImportSource } from "./import-card-shell";
import { ImportErrorLine, ImportPasteBody } from "./import-paste";

interface DoseHistoryKickoff {
  dryRun: boolean;
  jobId: string | null;
  statusUrl: string | null;
  file: DoseHistoryFileVerdict;
}

/** A final result supersedes the preflight counts so skips are stated once. */
export function shouldShowDoseHistoryVerdict(
  outcome: IntakeImportResultState | null,
): boolean {
  return outcome === null;
}

/**
 * Plain language per machine-readable file-level refusal. Literal `t()` calls so
 * the i18n call-site guard sees every one.
 */
function useFatalMessage(): (code: string | undefined) => string {
  const { t } = useTranslations();
  const messages: Record<string, string> = {
    empty_file: t(
      "settings.sections.export.import.doseHistory.fatal.emptyFile",
    ),
    missing_required_columns: t(
      "settings.sections.export.import.doseHistory.fatal.missingColumns",
    ),
    unreadable_json: t(
      "settings.sections.export.import.doseHistory.fatal.unreadableJson",
    ),
    json_not_an_array: t(
      "settings.sections.export.import.doseHistory.fatal.jsonNotAnArray",
    ),
    json_carries_no_intake_time: t(
      "settings.sections.export.import.doseHistory.fatal.jsonNoIntakeTime",
    ),
    too_many_rows: t(
      "settings.sections.export.import.doseHistory.fatal.tooManyRows",
    ),
  };
  const fallback = t("settings.sections.export.import.doseHistory.failed");
  return (code: string | undefined) =>
    (code === undefined ? undefined : messages[code]) ?? fallback;
}

/** `true` when the pasted or loaded text looks like the JSON shape. */
function looksLikeJson(text: string): boolean {
  const head = text.trimStart().charAt(0);
  return head === "[" || head === "{";
}

/**
 * The sentence for an import that did not report a result. A failed run or
 * a transport failure wrote nothing; a job still running when the watch gave
 * up may still write, so it must not read as nothing written.
 */
function importFailureKey(err: unknown): string {
  return err instanceof MedicationIntakeImportTimeout
    ? "settings.sections.export.import.doseHistory.stillRunning"
    : "settings.sections.export.import.doseHistory.failed";
}

export function DoseHistoryImportSource() {
  const { t } = useTranslations();
  const fatalMessageFor = useFatalMessage();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<DoseHistoryFileVerdict | null>(null);
  const [previewOnly, setPreviewOnly] = useState(false);
  const [outcome, setOutcome] = useState<IntakeImportResultState | null>(null);

  async function send(dryRun: boolean) {
    setError(null);
    setVerdict(null);
    setOutcome(null);
    if (text.trim().length === 0) {
      setError(t("settings.sections.export.import.doseHistory.empty"));
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetchRaw(
        `/api/medications/intake/dose-history-import${dryRun ? "?dryRun=1" : ""}`,
        {
          method: "POST",
          headers: {
            "Content-Type": looksLikeJson(text)
              ? "application/json"
              : "text/csv",
          },
          credentials: "include",
          body: text,
        },
      );
      if (res.status === 429) {
        setError(t("settings.sections.export.import.doseHistory.rateLimited"));
        return;
      }
      if (res.status === 413) {
        setError(t("settings.sections.export.import.doseHistory.tooLarge"));
        return;
      }
      if (res.status === 409) {
        setError(t("settings.sections.export.import.doseHistory.inProgress"));
        return;
      }
      if (res.status === 503) {
        setError(
          t("settings.sections.export.import.doseHistory.workerUnavailable"),
        );
        return;
      }
      if (res.status === 422 || res.status === 415) {
        const body = await res.json().catch(() => null);
        const code =
          typeof body?.meta?.errorCode === "string"
            ? body.meta.errorCode
            : undefined;
        setError(fatalMessageFor(code));
        return;
      }
      if (!res.ok) {
        setError(t("settings.sections.export.import.doseHistory.failed"));
        return;
      }

      const data = (await res.json()).data as DoseHistoryKickoff;
      setVerdict(data.file);
      setPreviewOnly(data.dryRun);
      if (data.dryRun || !data.statusUrl) return;

      const result = await waitForMedicationIntakeImport(data.statusUrl);
      setOutcome({
        kind: "outcome",
        imported: result.imported,
        skipped: result.skipped,
        skipReasons: result.skipReasons,
        skipDetails: result.skipDetails,
        skippedDetailsOmitted: result.skippedDetailsOmitted,
      });
      void invalidateMedicationReads(queryClient);
    } catch (err) {
      // A failed job's reason is the worker's English and adds nothing;
      // anything else is a transport failure. The card says what that means
      // rather than leaving the last verdict on screen.
      setError(t(importFailureKey(err)));
      setVerdict(null);
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || text.trim().length === 0;
  return (
    <ImportSource
      testId="import-card-dose-history"
      anchor="import-dose-history"
      icon={PillBottle}
      title={t("settings.sections.export.import.doseHistory.title")}
      info={[
        t("settings.sections.export.import.doseHistory.description"),
        t("settings.sections.export.import.doseHistory.detail"),
      ]}
      meta={t("settings.sections.export.import.doseHistory.rowMeta")}
      status={busy ? "running" : error ? "failed" : null}
      open={open}
      onOpenChange={setOpen}
      chooseTestId="import-choose-dose-history"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => void send(true)}
            data-testid="import-dose-history-preview"
          >
            {t("settings.sections.export.import.doseHistory.preview")}
          </Button>
          <Button
            type="button"
            disabled={disabled}
            onClick={() => void send(false)}
            data-testid="import-action-dose-history"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            ) : null}
            {t("settings.sections.export.import.doseHistory.import")}
          </Button>
        </>
      }
    >
      <ImportPasteBody
        slug="dose-history"
        fileMeta={t("settings.sections.export.import.doseHistory.fileMeta")}
        accept=".csv,.json,text/csv,application/json"
        fileInputLabel={t(
          "settings.sections.export.import.doseHistory.fileInputLabel",
        )}
        placeholder="Date,Scheduled Date,Medication,…"
        text={text}
        onTextChange={(next) => {
          setText(next);
          setError(null);
          setVerdict(null);
          setOutcome(null);
        }}
        onReadFailed={() =>
          setError(t("settings.sections.export.import.doseHistory.readFailed"))
        }
        guideTitle={t(
          "settings.sections.export.import.doseHistory.columnsHeading",
        )}
        guide={<DoseHistoryColumnRulings />}
        status={
          <>
            {verdict && shouldShowDoseHistoryVerdict(outcome) && (
              <DoseHistoryVerdictView
                verdict={verdict}
                previewOnly={previewOnly}
              />
            )}
            {outcome && <IntakeImportResultView result={outcome} />}
            {error && <ImportErrorLine>{error}</ImportErrorLine>}
          </>
        }
      />
    </ImportSource>
  );
}
