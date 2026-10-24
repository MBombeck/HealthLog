"use client";

/**
 * Document detail on `ResponsiveSheet` (bottom sheet on phones, dialog on
 * desktop). Inline-class documents (PDF / browser-native images) preview
 * inline against the owner-scoped decrypt-and-serve route — skeleton first,
 * content on load, internal scroll only (`overscroll-contain`). Attachment-
 * class documents get NO fake preview: type glyph, filename, size, and a
 * prominent Download button.
 *
 * Metadata edits save on commit (title on Enter/blur, kind and filing date
 * on change, condition links on toggle — replace-set PATCH). Mutation
 * errors surface inline (`role="alert"`), never as a QueryErrorCard.
 * Delete soft-deletes with an Undo toast (restore endpoint); a restore
 * refusal maps `meta.reason` (`purged`, `duplicateExists`) to translated
 * copy. A Share action in the footer opens the clinician share-link create
 * flow (shared `ShareLinkCreateForm`) with this document pre-attached.
 */
import { X } from "lucide-react";

import { DocumentReadingConsentPrompt } from "@/components/ai/document-reading-consent-prompt";
import { RelatedRecordsBlock } from "@/components/links/related-records";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-button";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { VaccinationDocumentSuggestion } from "@/components/vaccinations/vaccination-document-suggestion";
import { DOCUMENT_PURGE_GRACE_DAYS } from "@/lib/documents/inbound-constants";
import { formatBytes } from "@/lib/format/bytes";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { RelatedLink } from "@/lib/links/related";

import {
  DocumentDetailFields,
  DocumentDetailFooter,
  DocumentDetailMeta,
} from "./detail/detail-sections";
import { DocumentDownloadButton, InlinePreview } from "./detail/original-file";
import { useDocumentDetail } from "./detail/use-document-detail";
import { useDocumentDetailAi } from "./detail/use-document-detail-ai";
import { DocumentAiSection } from "./document-ai-section";
import { DocumentEncounterSuggestion } from "./document-encounter-suggestion";
import { DocumentFactsSection } from "./document-facts-review";
import { DocumentRecordLinks } from "./document-record-links";
import { DocumentShareSheet } from "./document-share-sheet";
import { DocumentSummaryBlock } from "./document-summary-block";

/** The grace window the delete confirmation names. */
const GRACE = { days: DOCUMENT_PURGE_GRACE_DAYS };

export function DocumentDetailSheet({
  documentId,
  open,
  onOpenChange,
  assistAvailable,
  contentIndexEnabled,
}: {
  documentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Whether the AI "Suggest details" / summary actions can run (from
   * `usage.assistAvailable`). When false the AI area shows a calm pointer to
   * the AI settings instead of an error — the manual form stays fully usable.
   */
  assistAvailable?: boolean;
  /** Whether content indexing is available (from `usage.contentIndex.enabled`). */
  contentIndexEnabled?: boolean;
}) {
  const { t, locale } = useTranslations();
  const format = useFormatters();
  const detail = useDocumentDetail({ documentId, open, onOpenChange });
  const {
    detail: detailQuery,
    doc,
    linkSeedFresh,
    canManageDocuments,
    labsModuleEnabled,
    mutationError,
    linkResets,
    shareOpen,
    setShareOpen,
    confirmDeleteOpen,
    setConfirmDeleteOpen,
    pickedEncounterId,
    patch,
    remove,
    setSuggestedEncounter,
    title,
    Icon,
    inlineSrc,
    inlineFailed,
  } = detail;
  const {
    documentAi,
    coach,
    capability,
    suggest,
    summary,
    storedSummary,
    indexDoc,
    aiErrorText,
    suggestion,
    setSuggestion,
    appliedFields,
    summaryOutput,
    setSummaryOutput,
    aiEnabled,
    indexEnabled,
    autoReadEnabled,
    runSuggest,
    runSummary,
    generateStoredSummary,
    runIndex,
    applyTitle,
    applyKind,
    applyDate,
    suggestionKindLabel,
    suggestionDateLabel,
  } = useDocumentDetailAi({
    documentId,
    open,
    assistAvailable,
    contentIndexEnabled,
    detail,
  });

  return (
    <>
      <ResponsiveSheet
        open={open}
        onOpenChange={onOpenChange}
        title={title}
        description={t("documents.detail.title")}
        contentWidth="3xl"
        showCloseButton={false}
        headerAction={
          // Enlarged close control rendered in the header's trailing slot —
          // the sheet's own X glyph is `size-4` via the primitive; we hide it
          // (`showCloseButton={false}`) and render this larger `size-5` X with
          // a comfortable min tap target instead. Scoped to this sheet only,
          // so the global primitive default is unchanged for other callers.
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-slot="document-detail-close"
            aria-label={t("common.close")}
            onClick={() => onOpenChange(false)}
            className="text-muted-foreground hover:text-foreground min-h-11 min-w-11 sm:size-9"
          >
            <X className="size-5" aria-hidden="true" />
          </Button>
        }
        footer={
          doc ? (
            <DocumentDetailFooter
              doc={doc}
              detail={detail}
              aiEnabled={aiEnabled}
              coachAvailable={coach.available}
              onOpenChange={onOpenChange}
            />
          ) : undefined
        }
      >
        {detailQuery.isPending && open ? (
          <div className="space-y-3" data-slot="document-detail-loading">
            <Skeleton className="h-48 w-full rounded-lg" />
            <Skeleton className="h-9 w-2/3" />
            <Skeleton className="h-9 w-1/2" />
          </div>
        ) : null}

        {detailQuery.isError ? (
          <QueryErrorRow
            inset
            error={detailQuery.error}
            slot="document-detail-error"
            message={t("documents.detail.loadError")}
            onRetry={() => void detailQuery.refetch()}
          />
        ) : null}

        {doc ? (
          <div className="space-y-6">
            {doc.servingClass === "inline" ? (
              <InlinePreview
                src={inlineSrc}
                failed={inlineFailed}
                mimeType={doc.mimeType}
                title={title}
              />
            ) : (
              <div className="border-border flex flex-col items-center gap-2 rounded-lg border px-4 py-8 text-center">
                {Icon ? (
                  <Icon className="text-muted-foreground size-8" aria-hidden />
                ) : null}
                <p className="max-w-full truncate text-sm font-medium">
                  {doc.filename ?? title}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t("documents.detail.previewUnavailable")},{" "}
                  {formatBytes(doc.byteSize, locale)}
                </p>
                <DocumentDownloadButton
                  documentId={doc.id}
                  filename={doc.filename}
                  readyUrl={null}
                  unavailable={false}
                  size="sm"
                  className="mt-1"
                  slot="document-download-inline"
                />
              </div>
            )}

            <DocumentSummaryBlock
              summary={doc.summary}
              // The stored summary is read; generating one writes to the
              // owner's record, so a delegate reads what is there and has no
              // generate control.
              canGenerate={canManageDocuments}
              summaryState={doc.summaryState}
              generatedAtLabel={
                doc.summaryGeneratedAt
                  ? format.date(doc.summaryGeneratedAt)
                  : null
              }
              aiEnabled={aiEnabled}
              isGenerating={storedSummary.isPending}
              runPhase={storedSummary.runPhase}
              actionsDisabled={capability.isPending}
              onGenerate={generateStoredSummary}
            />

            {canManageDocuments && documentAi.reason === "consent_required" ? (
              <DocumentReadingConsentPrompt />
            ) : null}

            {canManageDocuments && documentAi.available && (
              <DocumentAiSection
                aiEnabled={aiEnabled}
                autoReadEnabled={autoReadEnabled}
                indexEnabled={indexEnabled}
                unavailableReason={capability.data?.reason ?? null}
                actionsDisabled={capability.isPending}
                onSuggest={runSuggest}
                suggestPending={suggest.isPending}
                suggestErrorKey={
                  suggest.isError ? aiErrorText(suggest.error) : null
                }
                onSummarise={runSummary}
                summaryPending={summary.isPending}
                suggestion={suggestion}
                suggestionKindLabel={suggestionKindLabel}
                suggestionDateLabel={suggestionDateLabel}
                appliedFields={appliedFields}
                onUseTitle={applyTitle}
                onUseKind={applyKind}
                onUseDate={applyDate}
                onDismissSuggestion={() => setSuggestion(null)}
                summaryOutput={summaryOutput}
                summaryResult={summary.data ?? null}
                summaryErrorKey={
                  summary.isError ? aiErrorText(summary.error) : null
                }
                onCloseSummary={() => {
                  setSummaryOutput(null);
                  summary.reset();
                }}
                hasContentIndex={doc.hasContentIndex}
                contentIndexSource={doc.contentIndexSource}
                lastIndexOutcome={doc.lastIndexOutcome}
                indexPending={indexDoc.isPending}
                indexRunPhase={indexDoc.runPhase}
                assistRunPhase={
                  suggest.isPending ? suggest.runPhase : summary.runPhase
                }
                onIndex={runIndex}
              />
            )}

            {mutationError ? (
              <p role="alert" className="text-destructive text-sm">
                {mutationError}
              </p>
            ) : null}

            <div className="space-y-4">
              <DocumentDetailFields doc={doc} detail={detail} />

              <DocumentEncounterSuggestion
                anchor={doc.reportDate ?? doc.documentDate}
                alreadyLinked={
                  doc.encounterLinks.length > 0 && pickedEncounterId === null
                }
                disabled={!canManageDocuments}
                value={pickedEncounterId}
                onChange={setSuggestedEncounter}
              />

              {/* A vaccination scan offers to file against the dose it records,
                  through the same ±7-day rule the visit suggestion uses. */}
              {doc.kind === "VACCINATION" ? (
                <VaccinationDocumentSuggestion
                  anchor={doc.reportDate ?? doc.documentDate}
                  documentId={doc.id}
                  disabled={!canManageDocuments}
                />
              ) : null}

              {/* Which visits and doses this page is filed against, and — for
                  someone who may manage the vault — the links themselves.
                  Keyed on the write-failure count so a refused write drops
                  the local selection back to what the server confirmed. */}
              <DocumentRecordLinks
                key={`${doc.id}:${linkResets}`}
                doc={doc}
                canManage={canManageDocuments}
                seedFresh={linkSeedFresh}
                seedError={!linkSeedFresh && detailQuery.isRefetchError}
                onRetrySeed={() => void detailQuery.refetch()}
                onChange={(part) => patch.mutate(part)}
              />

              {/* The lab results read from this page and the
                  medications it belongs to. Conditions, visits and doses
                  have their own blocks above. */}
              <RelatedRecordsBlock
                related={(doc as { related?: RelatedLink[] }).related}
                omitKinds={["conditionEpisode", "encounter", "vaccination"]}
              />

              {/* Staged-facts review + the stored-text extract recovery. The
                  existing extract/confirm chain finally gets its control on
                  the document itself: pending facts open the review, a read
                  lab document with nothing staged offers "Extract lab
                  values" over its stored text — never a re-upload. */}
              <DocumentFactsSection
                doc={doc}
                canManage={canManageDocuments}
                aiEnabled={aiEnabled}
                labsModuleEnabled={labsModuleEnabled}
              />

              <DocumentDetailMeta doc={doc} detail={detail} />
            </div>
          </div>
        ) : null}
      </ResponsiveSheet>

      {doc ? (
        <DocumentShareSheet
          open={shareOpen}
          onOpenChange={setShareOpen}
          documents={[{ id: doc.id, title }]}
        />
      ) : null}
      {doc ? (
        <ConfirmDialog
          open={confirmDeleteOpen}
          onOpenChange={setConfirmDeleteOpen}
          title={t("documents.deleteConfirm.titleOne")}
          body={t("documents.deleteConfirm.body", GRACE)}
          confirmLabel={t("documents.deleteConfirm.action")}
          onConfirm={() => remove.mutate(doc.id)}
          pending={remove.isPending}
          slot="document-detail-delete"
          destructive
        />
      ) : null}
    </>
  );
}
