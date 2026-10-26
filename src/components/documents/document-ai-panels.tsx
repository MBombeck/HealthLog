"use client";

/**
 * v1.27.22 (Document vault P2) — the presentational AI panels for the document
 * detail sheet. Pure (props in, markup out) so the review-first contract and
 * the session-only note are pinned by static-render tests.
 *
 *   - `AiUnavailableHint` — the calm "set up an AI provider" pointer shown in
 *     place of the AI actions when no provider is configured (never an error).
 *   - `AssistSuggestionReview` — the reviewed DRAFT card: suggested title / type
 *     / date, each applied only by an explicit tap. Nothing is written until the
 *     user applies it (and the title lands in the editable field, not on disk).
 *   - `DocumentSummaryPanel` — the transient summary / extracted-text panel with
 *     the persistent "not saved · not a diagnosis" note.
 *   - `AiRunPhaseNote` — the calm line under an action while its read runs in
 *     the background (v1.40), shared by every document AI action.
 */
import { Sparkles } from "lucide-react";
import { Check, FileText, X } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { AiRunPhase } from "@/hooks/use-ai-run";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import {
  type DocumentSuggestionDto,
  type DocumentSummaryMode,
} from "@/lib/validations/inbound-documents";

import type { DocumentDescribeResult } from "./use-document-assist";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * The line under a document AI action while its read runs in the background,
 * or nothing when no read is running.
 *
 * `outcome` keeps the sentence true: a read whose result lands on the document
 * (the index, a stored summary, staged facts) tells the person they may leave;
 * a read whose answer lives only on this screen (suggestions, a transient
 * summary or transcription) does not promise that, because leaving drops it.
 */
export function AiRunPhaseNote({
  phase,
  outcome,
  slot,
}: {
  phase: AiRunPhase;
  outcome: "savedWithDocument" | "shownHere";
  slot: string;
}) {
  const { t } = useTranslations();
  if (phase === "idle") return null;
  return (
    <p role="status" data-slot={slot} className="text-muted-foreground text-xs">
      {phase === "waitingForWorker"
        ? t("aiRuns.waitingForWorker")
        : outcome === "savedWithDocument"
          ? t("aiRuns.backgroundDocument")
          : t("aiRuns.backgroundScan")}
    </p>
  );
}

/**
 * Calm pointer to the setting that would make assist available: the AI
 * settings when no provider is configured, the on-device scan switch on the
 * Labs module page when the provider cannot read images. Both live under
 * `/settings`, which is the caller's own and closed inside somebody else's
 * record, so the link is withheld there and the sentence stands alone. When
 * the document is already searchable (auto-indexed locally) the copy stays
 * honest — it is searchable, an AI provider only adds a richer read.
 */
export function AiUnavailableHint({
  reason,
}: {
  reason: "no-provider" | "enable-local-ocr" | null;
}) {
  const { t } = useTranslations();
  const { inSharedRecord } = useRecordCapabilities();
  const localOcr = reason === "enable-local-ocr";
  const body = localOcr
    ? t("documents.assist.unavailableLocalOcr")
    : t("documents.assist.unavailableBody");
  return (
    <div
      data-slot="assist-unavailable"
      className="border-border text-muted-foreground flex items-start gap-2 rounded-lg border border-dashed px-3 py-2.5 text-xs"
    >
      <Sparkles className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0">
        {body}
        {!inSharedRecord && (
          <>
            {" "}
            <Link
              href={
                localOcr
                  ? "/settings/modules/labs#labs-local-ocr"
                  : "/settings/ai"
              }
              data-slot="assist-settings-link"
              className="text-primary font-medium underline-offset-4 hover:underline"
            >
              {localOcr
                ? t("documents.assist.unavailableLocalOcrAction")
                : t("documents.assist.unavailableAction")}
            </Link>
          </>
        )}
      </p>
    </div>
  );
}

/** One reviewed draft row: a suggested value + an explicit apply control. */
function ReviewRow({
  label,
  value,
  applied,
  onApply,
  applyLabel,
}: {
  label: string;
  value: string;
  applied: boolean;
  onApply: () => void;
  applyLabel: string;
}) {
  const { t } = useTranslations();
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground text-xs">{label}</p>
        <p className="truncate text-sm font-medium">{value}</p>
      </div>
      {applied ? (
        <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
          <Check className="size-3.5" aria-hidden />
          {t("documents.assist.applied")}
        </span>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 px-2.5 text-xs"
          onClick={onApply}
        >
          {applyLabel}
        </Button>
      )}
    </div>
  );
}

/**
 * The review-first suggestion card. Suggestions are DRAFTS: applying the title
 * seeds the editable title field (the user still saves it); applying the type
 * or date commits that single field through the existing edit-on-commit path —
 * always an explicit tap, never automatic.
 */
export function AssistSuggestionReview({
  suggestion,
  kindLabel,
  dateLabel,
  applied,
  onUseTitle,
  onUseKind,
  onUseDate,
  onDismiss,
}: {
  suggestion: DocumentSuggestionDto;
  /** Translated label for the suggested kind, or null when none was read. */
  kindLabel: string | null;
  /** Formatted suggested date, or null when none was read. */
  dateLabel: string | null;
  applied: { title: boolean; kind: boolean; date: boolean };
  onUseTitle: () => void;
  onUseKind: () => void;
  onUseDate: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslations();
  const hasAny =
    suggestion.title !== null ||
    suggestion.kind !== null ||
    suggestion.documentDate !== null;

  return (
    <div
      data-slot="assist-suggestion-review"
      className="border-primary/30 bg-primary/5 space-y-3 rounded-lg border p-3"
    >
      <div className="flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 shrink-0 sm:size-7"
          onClick={onDismiss}
          aria-label={t("documents.assist.dismiss")}
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      {hasAny ? (
        <div className="space-y-2.5">
          {suggestion.title !== null ? (
            <ReviewRow
              label={t("documents.assist.suggestedTitle")}
              value={suggestion.title}
              applied={applied.title}
              onApply={onUseTitle}
              applyLabel={t("documents.assist.useTitle")}
            />
          ) : null}
          {suggestion.kind !== null && kindLabel !== null ? (
            <ReviewRow
              label={t("documents.assist.suggestedKind")}
              value={kindLabel}
              applied={applied.kind}
              onApply={onUseKind}
              applyLabel={t("documents.assist.apply")}
            />
          ) : null}
          {suggestion.documentDate !== null && dateLabel !== null ? (
            <ReviewRow
              label={t("documents.assist.suggestedDate")}
              value={dateLabel}
              applied={applied.date}
              onApply={onUseDate}
              applyLabel={t("documents.assist.apply")}
            />
          ) : null}
        </div>
      ) : (
        <EmptyState
          variant="plain"
          size="compact"
          title={t("documents.assist.empty")}
        />
      )}
    </div>
  );
}

/**
 * The transient summary / extracted-text panel. The result is shown once and
 * never persisted; the "not saved · not a diagnosis" note is always present.
 */
export function DocumentSummaryPanel({
  output,
  result,
  isPending,
  errorText,
  onClose,
}: {
  output: DocumentSummaryMode;
  result: DocumentDescribeResult | null;
  isPending: boolean;
  /** Resolved user-facing error sentence (already translated), or null. */
  errorText: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslations();
  const heading =
    output === "text"
      ? t("documents.summary.textTitle")
      : t("documents.summary.summaryTitle");
  const body =
    result === null ? null : "summary" in result ? result.summary : result.text;

  return (
    <div
      data-slot="document-summary-panel"
      className="border-border bg-muted/40 space-y-2 rounded-lg border p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 text-sm font-medium">
          <FileText className="text-muted-foreground size-4" aria-hidden />
          {heading}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 shrink-0 sm:size-7"
          onClick={onClose}
          aria-label={t("documents.summary.close")}
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      {isPending ? (
        <div className="space-y-2" data-slot="document-summary-loading">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-3/4" />
        </div>
      ) : errorText ? (
        <p role="alert" className="text-destructive text-sm">
          {errorText}
        </p>
      ) : body !== null ? (
        <p
          className={cn(
            "text-foreground text-sm",
            output === "text" &&
              "font-mono text-xs break-words whitespace-pre-wrap",
          )}
        >
          {body}
        </p>
      ) : null}
    </div>
  );
}
