"use client";

/**
 * What the document's AI reads leave in the detail sheet, lifted out of the
 * sheet so the availability gate and the review-first wiring render without
 * the sheet's dialog portal and are pinned by static-render tests.
 *
 * The reads themselves are entries of the sheet's "⋯"
 * (`useDocumentAiMenuItems` below), so the sheet carries one menu instead of
 * a row of four buttons:
 *
 *   - "Read with AI" runs a provider read of the document, the richer pass
 *     that also refreshes the searchable index ("Read again" once a provider
 *     has read it).
 *   - "Suggest details" drafts a title, type and date to review before saving.
 *   - "Show text" shows the extracted text here, for this visit only.
 *   - "Summarise" writes the stored summary; the summary block shows it.
 *
 * With auto-read on, reading happens on upload, so suggest and show-text step
 * back; an unread document keeps its read entry whatever the preference says,
 * since a document the automatic pass never reached would otherwise have no
 * path to a read at all.
 *
 * This block shows only what there is: where a read stands, why the last one
 * found nothing, a suggestion to review, the shown text. With nothing to show
 * it renders nothing. When `aiEnabled` is false it is the calm "set up an AI
 * provider" pointer (never an error), and the fields below stay usable.
 */
import { FileText, ScanText, TextSearch, WandSparkles } from "lucide-react";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { AiRunPhase } from "@/hooks/use-ai-run";
import { useTranslations } from "@/lib/i18n/context";
import type {
  DocumentContentIndexSourceValue,
  DocumentIndexOutcomeValue,
  DocumentSuggestionDto,
  DocumentSummaryMode,
} from "@/lib/validations/inbound-documents";
import { isAiReadSource } from "@/lib/documents/inbound-constants";

import {
  AiRunPhaseNote,
  AiUnavailableHint,
  AssistSuggestionReview,
  DocumentSummaryPanel,
} from "./document-ai-panels";
import type { DocumentDescribeResult } from "./use-document-assist";

export function DocumentAiSection({
  aiEnabled,
  autoReadEnabled = false,
  indexEnabled,
  unavailableReason,
  suggestErrorKey,
  summaryPending,
  suggestion,
  suggestionKindLabel,
  suggestionDateLabel,
  appliedFields,
  onUseTitle,
  onUseKind,
  onUseDate,
  onDismissSuggestion,
  summaryOutput,
  summaryResult,
  summaryErrorKey,
  onCloseSummary,
  hasContentIndex,
  lastIndexOutcome = null,
  indexRunPhase = "idle",
  assistRunPhase = "idle",
}: {
  aiEnabled: boolean;
  /** Whether "read documents automatically with AI" is on. */
  autoReadEnabled?: boolean;
  indexEnabled: boolean;
  unavailableReason: "no-provider" | "enable-local-ocr" | null;
  /** Resolved user-facing error sentence (already translated), or null. */
  suggestErrorKey: string | null;
  summaryPending: boolean;
  suggestion: DocumentSuggestionDto | null;
  suggestionKindLabel: string | null;
  suggestionDateLabel: string | null;
  appliedFields: { title: boolean; kind: boolean; date: boolean };
  onUseTitle: () => void;
  onUseKind: () => void;
  onUseDate: () => void;
  onDismissSuggestion: () => void;
  summaryOutput: DocumentSummaryMode | null;
  summaryResult: DocumentDescribeResult | null;
  /** Resolved user-facing error sentence (already translated), or null. */
  summaryErrorKey: string | null;
  onCloseSummary: () => void;
  hasContentIndex: boolean;
  /**
   * Refs #776: why the last index attempt produced no index (null: never
   * tried, or the document IS indexed). A muted plain-words line, so a failed
   * read is explainable, not a mystery.
   */
  lastIndexOutcome?: DocumentIndexOutcomeValue | null;
  /** v1.40: where a background read stands, for the calm line under it. */
  indexRunPhase?: AiRunPhase;
  /** v1.40: the same for a suggestion or a shown text. */
  assistRunPhase?: AiRunPhase;
}) {
  const { t } = useTranslations();
  if (!aiEnabled) return <AiUnavailableHint reason={unavailableReason} />;

  // Only an un-indexed document explains itself; once an index exists the
  // last failure is history.
  const indexOutcomeText =
    !hasContentIndex && lastIndexOutcome
      ? t(`documents.detail.index.outcome.${lastIndexOutcome}`)
      : null;
  // Auto-read promised a read on upload that this document never got.
  const unread = autoReadEnabled && !hasContentIndex && indexEnabled;
  const phase = indexRunPhase !== "idle" ? indexRunPhase : assistRunPhase;

  if (
    !unread &&
    phase === "idle" &&
    !indexOutcomeText &&
    !suggestErrorKey &&
    !suggestion &&
    !summaryOutput
  ) {
    return null;
  }

  return (
    <div data-slot="document-ai-section" className="space-y-3">
      {unread && !indexOutcomeText ? (
        <p
          data-slot="document-unread-note"
          className="text-muted-foreground text-xs"
        >
          {t("documents.ai.notReadYet")}
        </p>
      ) : null}

      {indexRunPhase !== "idle" ? (
        <AiRunPhaseNote
          phase={indexRunPhase}
          outcome="savedWithDocument"
          slot="document-index-run-phase"
        />
      ) : (
        <AiRunPhaseNote
          phase={assistRunPhase}
          outcome="shownHere"
          slot="document-assist-run-phase"
        />
      )}

      {indexOutcomeText ? (
        <p
          data-slot="document-index-outcome"
          className="text-muted-foreground text-xs"
        >
          {indexOutcomeText}
        </p>
      ) : null}

      {suggestErrorKey ? (
        <p role="alert" className="text-destructive text-sm">
          {suggestErrorKey}
        </p>
      ) : null}

      {suggestion ? (
        <AssistSuggestionReview
          suggestion={suggestion}
          kindLabel={suggestionKindLabel}
          dateLabel={suggestionDateLabel}
          applied={appliedFields}
          onUseTitle={onUseTitle}
          onUseKind={onUseKind}
          onUseDate={onUseDate}
          onDismiss={onDismissSuggestion}
        />
      ) : null}

      {summaryOutput ? (
        <DocumentSummaryPanel
          output={summaryOutput}
          result={summaryResult}
          isPending={summaryPending}
          errorText={summaryErrorKey}
          onClose={onCloseSummary}
        />
      ) : null}
    </div>
  );
}

/**
 * The AI reads as entries of the sheet's "⋯". Empty when no provider is set
 * up: the section above says so instead.
 */
export function useDocumentAiMenuItems({
  aiEnabled,
  autoReadEnabled,
  indexEnabled,
  hasContentIndex,
  contentIndexSource,
  canSummarise,
  actionsDisabled,
  indexPending,
  suggestPending,
  summaryPending,
  onIndex,
  onSuggest,
  onShowText,
  onSummarise,
}: {
  aiEnabled: boolean;
  autoReadEnabled: boolean;
  indexEnabled: boolean;
  hasContentIndex: boolean;
  contentIndexSource: DocumentContentIndexSourceValue | null;
  /** False while a stored summary is being written. */
  canSummarise: boolean;
  /** Capability still resolving: the transport mode isn't known yet. */
  actionsDisabled: boolean;
  indexPending: boolean;
  suggestPending: boolean;
  summaryPending: boolean;
  onIndex: () => void;
  onSuggest: () => void;
  onShowText: () => void;
  onSummarise: () => void;
}): React.ReactNode[] {
  const { t } = useTranslations();
  const items: React.ReactNode[] = [];
  if (!aiEnabled) return items;
  const aiRead = hasContentIndex && isAiReadSource(contentIndexSource);
  if (indexEnabled && (!autoReadEnabled || !hasContentIndex)) {
    items.push(
      <DropdownMenuItem
        key="read"
        data-slot="document-read-ai"
        disabled={indexPending || actionsDisabled}
        onSelect={onIndex}
      >
        <ScanText aria-hidden />
        {indexPending
          ? t("documents.ai.reading")
          : aiRead
            ? t("documents.ai.reread")
            : t("documents.ai.read")}
      </DropdownMenuItem>,
    );
  }
  if (canSummarise) {
    items.push(
      <DropdownMenuItem
        key="summarise"
        data-slot="document-detail-summary-generate"
        disabled={summaryPending || actionsDisabled}
        onSelect={onSummarise}
      >
        <FileText aria-hidden />
        {t("documents.summary.summarise")}
      </DropdownMenuItem>,
    );
  }
  if (!autoReadEnabled) {
    items.push(
      <DropdownMenuItem
        key="suggest"
        data-slot="assist-suggest"
        disabled={suggestPending || actionsDisabled}
        onSelect={onSuggest}
      >
        <WandSparkles aria-hidden />
        {suggestPending
          ? t("documents.assist.suggesting")
          : t("documents.assist.suggest")}
      </DropdownMenuItem>,
      <DropdownMenuItem
        key="text"
        data-slot="document-show-text"
        disabled={summaryPending || actionsDisabled}
        onSelect={onShowText}
      >
        <TextSearch aria-hidden />
        {t("documents.summary.showText")}
      </DropdownMenuItem>,
    );
  }
  return items;
}
