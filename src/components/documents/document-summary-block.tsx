"use client";

/**
 * The document detail sheet's summary block, lifted out of the sheet so its
 * state machine renders without the dialog portal and is pinned by static-render
 * tests.
 *
 * The block exists because a null summary is ambiguous and used to be read as
 * one thing: "being generated". It was the fallback for every outcome — a
 * document nobody ever enqueued (no backfill reaches uploads that predate the
 * auto-read opt-in), a missing vision provider, a spent budget, a withdrawn
 * consent, an unreadable file, a provider error, and a summary the outbound
 * safety screen withheld. All of them left the column null, so the view told the
 * user a job was running that in most cases never existed.
 *
 * It now branches on the stored `summaryState`:
 *
 *   READY       → the stored summary, served from storage, never regenerated
 *   PENDING     → "being generated" — the ONLY state allowed to claim that, and
 *                 it is set when a job was actually enqueued
 *   WITHHELD    → says the summary was blocked, offers another attempt. The
 *                 blocked prose is never shown or stored
 *   UNAVAILABLE → says none could be produced, offers another attempt
 *   NONE        → says none exists yet, offers to generate one
 *
 * #1404 — when the server recorded why the last attempt stopped (`failure`), the
 * absent state says that reason instead of the generic line, and the action
 * reads "Try again".
 *
 * The action is a click, never an effect: opening a document must not spend a
 * provider call. With no AI provider configured the block renders the state
 * without an action rather than an button that would 422.
 */
import { FileText } from "lucide-react";

import { AiJobFailureLine } from "@/components/ai/ai-job-failure-line";
import { Button } from "@/components/ui/button";
import type { AiJobFailureDto } from "@/lib/ai/job-failure/types";
import type { AiRunPhase } from "@/hooks/use-ai-run";
import { useTranslations } from "@/lib/i18n/context";
import type { DocumentSummaryStateValue } from "@/lib/validations/inbound-documents";

import { AiRunPhaseNote } from "./document-ai-panels";

/** Copy key for a state with no summary to show. */
function absentCopyKey(state: DocumentSummaryStateValue): string {
  if (state === "WITHHELD") return "documents.detail.summary.withheld";
  if (state === "UNAVAILABLE") return "documents.detail.summary.unavailable";
  return "documents.detail.summary.none";
}

export function DocumentSummaryBlock({
  summary,
  summaryState,
  generatedAtLabel,
  aiEnabled,
  isGenerating,
  runPhase = "idle",
  actionsDisabled,
  canGenerate = true,
  failures,
  onGenerate,
}: {
  /** The stored, decrypted summary, or null when there is none to show. */
  summary: string | null;
  summaryState: DocumentSummaryStateValue;
  /** Pre-formatted generation date — the sheet owns locale formatting. */
  generatedAtLabel: string | null;
  /** Whether an AI provider is configured; false hides the action, not the state. */
  aiEnabled: boolean;
  isGenerating: boolean;
  /**
   * v1.40 — where the background read stands while one runs. The summary is
   * stored on the document, so the line tells the person they may leave.
   */
  runPhase?: AiRunPhase;
  /** Capability still resolving — the transport mode isn't known yet. */
  actionsDisabled: boolean;
  /**
   * v1.36.x — false inside somebody else's record: a stored summary is
   * readable, generating one writes to the owner's record and no grant level
   * admits it. The state line stays; the button goes.
   */
  canGenerate?: boolean;
  /** #1404 — the document's recorded AI failures; the summary's is shown. */
  failures?: readonly AiJobFailureDto[];
  onGenerate: () => void;
}) {
  const { t } = useTranslations();
  const failure =
    failures?.find((entry) => entry.job === "documentSummary") ?? null;

  // A stored summary wins over every state and is shown read-only from storage.
  // Generation remains available only for absent terminal states below.
  if (summary) {
    return (
      <section className="space-y-2" data-slot="document-detail-summary">
        <div
          data-slot="document-detail-summary-header"
          className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm leading-none font-medium">
            {t("documents.detail.summary.title")}
          </p>
        </div>
        <p className="text-foreground text-sm">{summary}</p>
        {generatedAtLabel ? (
          <p className="text-muted-foreground text-xs">{generatedAtLabel}</p>
        ) : null}
      </section>
    );
  }

  if (summaryState === "PENDING") {
    return (
      <p
        className="text-muted-foreground text-xs"
        data-slot="document-detail-summary-pending"
      >
        {t("documents.detail.summary.pending")}
      </p>
    );
  }

  return (
    <section className="space-y-2" data-slot="document-detail-summary-absent">
      <p className="text-sm leading-none font-medium">
        {t("documents.detail.summary.title")}
      </p>
      {failure && summaryState !== "WITHHELD" ? (
        <AiJobFailureLine
          failure={failure}
          slot="document-detail-summary-failure"
        />
      ) : (
        <p className="text-muted-foreground text-xs">
          {t(absentCopyKey(summaryState))}
        </p>
      )}
      {aiEnabled && canGenerate ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-slot="document-detail-summary-generate"
          onClick={onGenerate}
          disabled={isGenerating || actionsDisabled}
        >
          <FileText className="size-4" aria-hidden />
          {isGenerating
            ? t("documents.detail.summary.generating")
            : failure
              ? t("aiRuns.jobFailure.retry")
              : t("documents.detail.summary.generate")}
        </Button>
      ) : null}
      <AiRunPhaseNote
        phase={runPhase}
        outcome="savedWithDocument"
        slot="document-detail-summary-run-phase"
      />
    </section>
  );
}
