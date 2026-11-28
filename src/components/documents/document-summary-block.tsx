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
 *   NONE        → nothing: a document without a summary needs no line saying so
 *
 * #1404 — when the server recorded why the last attempt stopped (`failure`), the
 * absent state says that reason instead of the generic line.
 *
 * Writing one is the sheet's "⋯" entry "Summarise", a click, never an effect:
 * opening a document must not spend a provider call. While that runs, the
 * block shows where it stands.
 */
import { AiJobFailureLine } from "@/components/ai/ai-job-failure-line";
import type { AiJobFailureDto } from "@/lib/ai/job-failure/types";
import type { AiRunPhase } from "@/hooks/use-ai-run";
import { useTranslations } from "@/lib/i18n/context";
import type { DocumentSummaryStateValue } from "@/lib/validations/inbound-documents";

import { AiRunPhaseNote } from "./document-ai-panels";

/** Copy key for a state that says why there is no summary. */
function absentCopyKey(state: DocumentSummaryStateValue): string {
  return state === "WITHHELD"
    ? "documents.detail.summary.withheld"
    : "documents.detail.summary.unavailable";
}

export function DocumentSummaryBlock({
  summary,
  summaryState,
  generatedAtLabel,
  runPhase = "idle",
  failures,
}: {
  /** The stored, decrypted summary, or null when there is none to show. */
  summary: string | null;
  summaryState: DocumentSummaryStateValue;
  /** Pre-formatted generation date; the sheet owns locale formatting. */
  generatedAtLabel: string | null;
  /**
   * v1.40: where the background read stands while one runs. The summary is
   * stored on the document, so the line tells the person they may leave.
   */
  runPhase?: AiRunPhase;
  /** #1404: the document's recorded AI failures; the summary's is shown. */
  failures?: readonly AiJobFailureDto[];
}) {
  const { t } = useTranslations();
  const failure =
    failures?.find((entry) => entry.job === "documentSummary") ?? null;

  // A stored summary wins over every state and is shown read-only from storage.
  if (summary) {
    return (
      <section className="space-y-2" data-slot="document-detail-summary">
        <p className="text-sm leading-none font-medium">
          {t("documents.detail.summary.title")}
        </p>
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

  const phase = (
    <AiRunPhaseNote
      phase={runPhase}
      outcome="savedWithDocument"
      slot="document-detail-summary-run-phase"
    />
  );
  if (summaryState === "NONE" && !failure) {
    return runPhase === "idle" ? null : phase;
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
      {phase}
    </section>
  );
}
