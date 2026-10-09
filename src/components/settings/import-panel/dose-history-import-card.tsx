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
import { useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2, PillBottle, Upload } from "lucide-react";

import {
  IntakeImportResultView,
  type IntakeImportResultState,
} from "@/components/medications/intake-import-result";
import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import {
  MedicationIntakeImportError,
  waitForMedicationIntakeImport,
} from "@/lib/medications/intake-import-poll";
import { invalidateMedicationReads } from "@/lib/query-keys";

import { DoseHistoryColumnRulings } from "./dose-history-columns";
import {
  DoseHistoryVerdictView,
  type DoseHistoryFileVerdict,
} from "./dose-history-verdict";
import { ImportCardShell } from "./import-card-shell";
import { MAX_PASTE_CHARS } from "./constants";

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

export function DoseHistoryImportCard() {
  const { t } = useTranslations();
  const fatalMessageFor = useFatalMessage();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaId = useId();
  const queryClient = useQueryClient();

  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<DoseHistoryFileVerdict | null>(null);
  const [previewOnly, setPreviewOnly] = useState(false);
  const [outcome, setOutcome] = useState<IntakeImportResultState | null>(null);

  async function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    setVerdict(null);
    setOutcome(null);
    try {
      setText(await file.text());
    } catch {
      setError(t("settings.sections.export.import.doseHistory.readFailed"));
    }
  }

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
      // A failed job carries a sanitised reason; anything else is a transport
      // failure with nothing to add. Either way the run did not write, and the
      // card says so rather than leaving the last verdict on screen.
      setError(
        err instanceof MedicationIntakeImportError && err.message.length > 0
          ? err.message
          : t("settings.sections.export.import.doseHistory.failed"),
      );
      setVerdict(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ImportCardShell
      testId="import-card-dose-history"
      anchor="import-dose-history"
      icon={PillBottle}
      title={t("settings.sections.export.import.doseHistory.title")}
      description={t("settings.sections.export.import.doseHistory.description")}
    >
      <p className="text-sm">
        {t("settings.sections.export.import.doseHistory.detail")}
      </p>

      <div className="space-y-1.5">
        <Label htmlFor={textareaId} className="text-xs">
          {t("settings.sections.export.import.doseHistory.pasteLabel")}
        </Label>
        <Textarea
          id={textareaId}
          data-testid="import-dose-history-textarea"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={5}
          maxLength={MAX_PASTE_CHARS}
          spellCheck={false}
          placeholder="Date,Scheduled Date,Medication,…"
          className="font-mono text-xs"
        />
        <p className="text-muted-foreground text-right text-xs tabular-nums">
          {t("settings.sections.export.import.charCount", {
            used: text.length,
            max: MAX_PASTE_CHARS,
          })}
        </p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.json,text/csv,application/json"
        className="sr-only"
        aria-label={t(
          "settings.sections.export.import.doseHistory.fileInputLabel",
        )}
        onChange={onFileChange}
      />

      <DoseHistoryColumnRulings />

      <div aria-live="polite" className="space-y-2">
        {verdict && shouldShowDoseHistoryVerdict(outcome) && (
          <DoseHistoryVerdictView verdict={verdict} previewOnly={previewOnly} />
        )}
        {outcome && <IntakeImportResultView result={outcome} />}
        {error && (
          <p
            role="alert"
            className="text-destructive flex items-start gap-2 text-sm"
          >
            <AlertCircle
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
            <span>{error}</span>
          </p>
        )}
      </div>

      <SettingsCardActions className="mt-auto" align="start">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={() => fileInputRef.current?.click()}
          data-testid="import-dose-history-choose-file"
        >
          <Upload className="h-3.5 w-3.5" />
          {t("settings.sections.export.import.doseHistory.uploadFile")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          disabled={busy || text.trim().length === 0}
          onClick={() => void send(true)}
          data-testid="import-dose-history-preview"
        >
          {busy && (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          )}
          {t("settings.sections.export.import.doseHistory.preview")}
        </Button>
        <Button
          type="button"
          size="sm"
          className="min-h-11 sm:min-h-9"
          disabled={busy || text.trim().length === 0}
          onClick={() => void send(false)}
          data-testid="import-action-dose-history"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <PillBottle className="h-3.5 w-3.5" />
          )}
          {t("settings.sections.export.import.doseHistory.import")}
        </Button>
      </SettingsCardActions>
    </ImportCardShell>
  );
}
