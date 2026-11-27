"use client";

/**
 * Document detail on `ResponsiveSheet` (bottom sheet on phones, dialog on
 * desktop). Inline-class documents (PDF / browser-native images) preview
 * inline against the owner-scoped decrypt-and-serve route — skeleton first,
 * content on load, internal scroll only (`overscroll-contain`). Under it, or
 * alone for a type with no preview, the file as one row: glyph, name, when it
 * came in and its size.
 *
 * The footer is one pair, Share and Download; the AI reads, the Coach,
 * opening the original in a tab and Delete share the "⋯" in the header.
 *
 * Metadata edits save on commit (title on Enter/blur, kind and filing date
 * on change, condition links on toggle — replace-set PATCH). A quiet status
 * line says "Saving…" and then "Saved", since there is no Save button to
 * confirm the write. Mutation errors surface inline (`role="alert"`), never
 * as a QueryErrorCard.
 * Delete soft-deletes with an Undo toast (restore endpoint); a restore
 * refusal maps `meta.reason` (`purged`, `duplicateExists`) to translated
 * copy. Share opens the clinician share-link create flow (shared
 * `ShareLinkCreateForm`) with this document pre-attached.
 */
import { useState } from "react";
import dynamic from "next/dynamic";

import { DocumentReadingConsentPrompt } from "@/components/ai/document-reading-consent-prompt";
import { ActionMenu } from "@/components/ui/action-pair";
import { ConfirmDialog } from "@/components/ui/confirm-button";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { VaccinationDocumentSuggestion } from "@/components/vaccinations/vaccination-document-suggestion";
import { DOCUMENT_PURGE_GRACE_DAYS } from "@/lib/documents/inbound-constants";
import { useFormatters, useTranslations } from "@/lib/i18n/context";

import {
  DocumentDetailFields,
  DocumentDetailMeta,
  DocumentSaveStatus,
  useDocumentDetailFooter,
  useDocumentDetailMenuItems,
} from "./detail/detail-sections";
import { DocumentFileRow, InlinePreview } from "./detail/original-file";
import {
  useDocumentDetail,
  type DocumentDetail,
} from "./detail/use-document-detail";
import { useDocumentDetailAi } from "./detail/use-document-detail-ai";
import {
  DocumentAiSection,
  useDocumentAiMenuItems,
} from "./document-ai-section";
import { DocumentEncounterSuggestion } from "./document-encounter-suggestion";
import { DocumentFactsSection } from "./document-facts-review";
import { DocumentRecordLinks } from "./document-record-links";
import { DocumentShareSheet } from "./document-share-sheet";
import { DocumentAiFailureNotes } from "./document-ai-failure-notes";
import { DocumentSummaryBlock } from "./document-summary-block";

// Loaded on demand: only a managed profile's guardian ever opens it, and it
// carries the Coach's bubble renderer.
const DocumentChatSheet = dynamic(
  () => import("./chat/document-chat-sheet").then((m) => m.DocumentChatSheet),
  { ssr: false, loading: () => null },
);

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
  /** Whether the AI suggest and summary actions can run (`usage.assistAvailable`);
   *  when false the AI area points to the AI settings and the form stays usable. */
  assistAvailable?: boolean;
  /** Whether content indexing is available (from `usage.contentIndex.enabled`). */
  contentIndexEnabled?: boolean;
}) {
  const { t } = useTranslations();
  const format = useFormatters();
  const detail = useDocumentDetail({ documentId, open, onOpenChange });
  const {
    detail: detailQuery,
    doc,
    linkSeedFresh,
    canManageDocuments,
    labsModuleEnabled,
    mutationError,
    saved,
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
    previewInline,
    inlineSrc,
    inlineFailed,
  } = detail;
  const ai = useDocumentDetailAi({
    documentId,
    open,
    assistAvailable,
    contentIndexEnabled,
    detail,
  });
  const {
    documentAi,
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
    applyTitle,
    applyKind,
    applyDate,
    suggestionKindLabel,
    suggestionDateLabel,
  } = ai;
  const [chatOpen, setChatOpen] = useState(false);
  const footer = useSheetFooter({
    detail,
    ai,
    onOpenChange,
    onOpenChat: () => setChatOpen(true),
  });

  return (
    <>
      <ResponsiveSheet
        open={open}
        onOpenChange={onOpenChange}
        title={<OneLineTitle text={title} />}
        contentWidth="3xl"
        footer={footer}
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
            <div className="space-y-3">
              {previewInline ? (
                <InlinePreview
                  src={inlineSrc}
                  failed={inlineFailed}
                  mimeType={doc.mimeType}
                  title={title}
                />
              ) : null}
              <DocumentFileRow doc={doc} title={title} Icon={Icon} />
            </div>

            <DocumentSummaryBlock
              summary={doc.summary}
              summaryState={doc.summaryState}
              generatedAtLabel={
                doc.summaryGeneratedAt
                  ? format.date(doc.summaryGeneratedAt)
                  : null
              }
              runPhase={storedSummary.runPhase}
              failures={doc.aiFailures}
            />
            <DocumentAiFailureNotes
              failures={doc.aiFailures}
              canRetry={canManageDocuments && documentAi.available}
              retryPending={indexDoc.isPending}
              onRetry={ai.runIndex}
            />

            {detail.ownsVault && documentAi.reason === "consent_required" ? (
              <DocumentReadingConsentPrompt />
            ) : null}

            {canManageDocuments && documentAi.available && (
              <DocumentAiSection
                aiEnabled={aiEnabled}
                autoReadEnabled={autoReadEnabled}
                indexEnabled={indexEnabled}
                unavailableReason={capability.data?.reason ?? null}
                suggestErrorKey={
                  suggest.isError ? aiErrorText(suggest.error) : null
                }
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
                lastIndexOutcome={doc.lastIndexOutcome}
                indexRunPhase={indexDoc.runPhase}
                assistRunPhase={
                  suggest.isPending ? suggest.runPhase : summary.runPhase
                }
              />
            )}

            <DocumentSaveStatus
              error={mutationError}
              pending={patch.isPending}
              saved={saved}
            />

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

              {/* What this page is filed against, as one row of chips,
                  and for someone who may manage the vault the one button
                  that links more. Keyed on the write-failure count so a
                  refused write drops the local selection back to what the
                  server confirmed. */}
              <DocumentRecordLinks
                key={`${doc.id}:${linkResets}`}
                doc={doc}
                canManage={canManageDocuments}
                seedFresh={linkSeedFresh}
                seedError={!linkSeedFresh && detailQuery.isRefetchError}
                onRetrySeed={() => void detailQuery.refetch()}
                episodes={detail.episodes}
                onChange={(part) => patch.mutate(part)}
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

      {doc && chatOpen ? (
        <DocumentChatSheet
          documentId={doc.id}
          title={title}
          open={chatOpen}
          onOpenChange={setChatOpen}
        />
      ) : null}
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

/**
 * The sheet's footer: its one "⋯" (the AI reads, the owner's or a guardian's
 * with a provider, then the Coach, the original in a new tab and Delete,
 * left out when it would hold nothing), then Share and Download.
 */
function useSheetFooter({
  detail,
  ai,
  onOpenChange,
  onOpenChat,
}: {
  detail: DocumentDetail;
  ai: ReturnType<typeof useDocumentDetailAi>;
  onOpenChange: (open: boolean) => void;
  onOpenChat: () => void;
}): React.ReactNode {
  const { doc, canManageDocuments } = detail;
  const aiItems = useDocumentAiMenuItems({
    aiEnabled:
      Boolean(doc) &&
      canManageDocuments &&
      ai.documentAi.available &&
      ai.aiEnabled,
    autoReadEnabled: ai.autoReadEnabled,
    indexEnabled: ai.indexEnabled,
    hasContentIndex: doc?.hasContentIndex ?? false,
    contentIndexSource: doc?.contentIndexSource ?? null,
    canSummarise: doc?.summaryState !== "PENDING",
    actionsDisabled: ai.capability.isPending,
    indexPending: ai.indexDoc.isPending,
    suggestPending: ai.suggest.isPending,
    summaryPending: ai.summary.isPending || ai.storedSummary.isPending,
    onIndex: ai.runIndex,
    onSuggest: ai.runSuggest,
    onShowText: () => ai.runSummary("text"),
    onSummarise: ai.generateStoredSummary,
  });
  const otherItems = useDocumentDetailMenuItems({
    doc,
    detail,
    aiEnabled: ai.aiEnabled,
    coachAvailable: ai.coach.available,
    onOpenChange,
    onOpenChat,
  });
  const items = [...aiItems, ...otherItems];
  return useDocumentDetailFooter({
    doc,
    detail,
    menu:
      items.length > 0 ? (
        <ActionMenu slot="document-detail-more">{items}</ActionMenu>
      ) : null,
  });
}

/** The sheet's title on one line; the full title is the Title row's value. */
function OneLineTitle({ text }: { text: string }) {
  return (
    <span className="block truncate" title={text}>
      {text}
    </span>
  );
}
