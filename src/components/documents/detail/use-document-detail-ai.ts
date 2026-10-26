"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useAiCapability } from "@/hooks/use-ai-capability";
import { useCalendarDate } from "@/hooks/use-calendar-date";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type {
  DocumentSuggestionDto,
  DocumentSummaryMode,
} from "@/lib/validations/inbound-documents";

import type {
  DocumentAiMode,
  DocumentAiTarget,
} from "../document-ai-transport";
import { useIndexDocument } from "../use-content-index";
import {
  useDocumentAiCapability,
  useDocumentAiErrorText,
  useDocumentsAutoAiRead,
  useDocumentSummary,
  useSuggestDetails,
} from "../use-document-assist";

import type { DocumentDetail } from "./use-document-detail";

/**
 * The document's AI layer: the capability that drives the vision or text
 * transport, the review-first suggestion and what was applied from it, the
 * session-only and the stored summary, and content indexing.
 */
export function useDocumentDetailAi({
  documentId,
  open,
  assistAvailable,
  contentIndexEnabled,
  detail,
}: {
  documentId: string | null;
  open: boolean;
  assistAvailable?: boolean;
  contentIndexEnabled?: boolean;
  detail: DocumentDetail;
}) {
  const { t, tCount } = useTranslations();
  const queryClient = useQueryClient();
  const { doc, canManageDocuments } = detail;
  // AI layer — capability drives the vision/text transport; the mutations run
  // the review-first assist, the session-only summary, and content indexing.
  // The affordance itself is gated on `assistAvailable` (from usage); the
  // probe only resolves the transport mode + the actionable unavailable reason.
  //
  // Neither probe fires inside somebody else's record. The
  // document reads behind this sheet are delegable; the AI verbs above them are
  // not, and both of these routes stay on the caller's own authentication. A
  // delegate would fire two queries that must 403 in order to compute an
  // affordance every branch below already withholds on `canManageDocuments`.
  // Reading a document with AI follows the `documentAi` capability on
  // `/api/auth/me` (the operator's "Reading documents" switch, the provider,
  // the document-reading consent). Unavailable, the actions are simply not
  // offered and the probe never fires; a missing consent is asked for in
  // place instead.
  const documentAi = useAiCapability("documentAi");
  const coach = useAiCapability("coach");
  const capability = useDocumentAiCapability(
    canManageDocuments && open && documentId !== null && documentAi.available,
  );
  // When auto-read is ON, reading happens automatically on upload — the manual
  // per-document AI action row is redundant and collapses away.
  const autoRead = useDocumentsAutoAiRead(
    canManageDocuments && open && documentId !== null,
  );
  const suggest = useSuggestDetails();
  const summary = useDocumentSummary();
  // Resolves an AI error to final copy — a 429 names the actual wait, derived
  // from the reset instant the route mirrors into the error meta.
  const aiErrorText = useDocumentAiErrorText();
  // Stored generation has an independent mutation state so transient
  // Summarise/Show text requests cannot change this block's spinner or result.
  const storedSummary = useDocumentSummary();
  const indexDoc = useIndexDocument();

  const [suggestion, setSuggestion] = useState<DocumentSuggestionDto | null>(
    null,
  );
  const [appliedFields, setAppliedFields] = useState({
    title: false,
    kind: false,
    date: false,
  });
  const [summaryOutput, setSummaryOutput] =
    useState<DocumentSummaryMode | null>(null);

  // Reset transient AI state whenever another document opens.
  const [lastDocumentId, setLastDocumentId] = useState(documentId);
  if (lastDocumentId !== documentId) {
    setLastDocumentId(documentId);
    setSuggestion(null);
    setAppliedFields({ title: false, kind: false, date: false });
    setSummaryOutput(null);
  }

  // Clear stale mutation state (a prior document's assist error / summary)
  // when the sheet switches documents or closes — the mutation stores live
  // outside render, so they reset in an effect rather than during render.
  useEffect(() => {
    suggest.reset();
    summary.reset();
    storedSummary.reset();
    indexDoc.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  const { aiEnabled, indexEnabled, autoReadEnabled, aiMode, aiTarget } =
    aiGates({
      documentAiAvailable: documentAi.available,
      assistAvailable,
      contentIndexEnabled,
      capability: capability.data,
      autoRead: autoRead.data,
      doc,
    });

  const runSuggest = () => {
    if (!aiTarget) return;
    setAppliedFields({ title: false, kind: false, date: false });
    suggest.mutate(
      { mode: aiMode, target: aiTarget },
      { onSuccess: (result) => setSuggestion(result) },
    );
  };

  const runSummary = (output: DocumentSummaryMode) => {
    if (!aiTarget) return;
    summary.reset();
    setSummaryOutput(output);
    summary.mutate({ mode: aiMode, target: aiTarget, output });
  };

  // Generate or regenerate the STORED summary from the detail block. Only the
  // stored-summary branch requests replacement; the empty-state action keeps
  // first-write-wins if another worker or tab finishes while AI is running.
  const generateStoredSummary = () => {
    if (!aiTarget || !documentId) return;
    storedSummary.reset();
    storedSummary.mutate(
      {
        mode: aiMode,
        target: aiTarget,
        output: "summary",
        persist: true,
        replace: doc?.summary != null,
      },
      {
        onSuccess: (result) => {
          if ("summary" in result) {
            if (result.persistence === "withheld") {
              showErrorToast(result.summary);
            } else if (result.persistence === "failed") {
              showErrorToast(t("documents.detail.saveError"));
            }
          }
          void queryClient.invalidateQueries({
            queryKey: queryKeys.inboundDocument(documentId),
          });
        },
        onError: (error) =>
          showErrorToast(aiErrorText(error), { cause: error }),
      },
    );
  };

  const runIndex = () => {
    if (!aiTarget) return;
    indexDoc.mutate(
      { mode: aiMode, target: aiTarget },
      {
        // A read that continued into lab staging says so — the staged values
        // are waiting in the review block, not silently in a queue. Staged
        // facts stay PENDING; confirmation remains the only write into Labs.
        onSuccess: (result) =>
          toast.success(
            result.labFactsStaged > 0
              ? tCount("documents.ai.readStaged", result.labFactsStaged)
              : t("documents.ai.readDone"),
          ),
        onError: (error) =>
          showErrorToast(aiErrorText(error), { cause: error }),
      },
    );
  };

  const {
    applyTitle,
    applyKind,
    applyDate,
    suggestionKindLabel,
    suggestionDateLabel,
  } = useSuggestionApply({ suggestion, setAppliedFields, detail });

  return {
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
  };
}

/**
 * Whether the AI actions run, whether content can be indexed, whether auto-
 * read already does it, and the transport mode and target. The gate falls
 * back to the capability probe when the sheet opens before usage loaded.
 */
function aiGates({
  documentAiAvailable,
  assistAvailable,
  contentIndexEnabled,
  capability,
  autoRead,
  doc,
}: {
  documentAiAvailable: boolean;
  assistAvailable?: boolean;
  contentIndexEnabled?: boolean;
  capability: ReturnType<typeof useDocumentAiCapability>["data"];
  autoRead: ReturnType<typeof useDocumentsAutoAiRead>["data"];
  doc: DocumentDetail["doc"];
}) {
  const aiEnabled =
    documentAiAvailable && (assistAvailable ?? capability?.available ?? false);
  const indexEnabled =
    documentAiAvailable &&
    (contentIndexEnabled ?? capability?.available ?? false);
  const autoReadEnabled = autoRead?.documentsAutoAiRead ?? false;
  const aiMode: DocumentAiMode =
    capability?.mode === "text" ? "text" : "vision";
  const aiTarget: DocumentAiTarget | null = doc
    ? {
        documentId: doc.id,
        mimeType: doc.mimeType,
        filename: doc.filename,
        servingClass: doc.servingClass,
      }
    : null;

  return { aiEnabled, indexEnabled, autoReadEnabled, aiMode, aiTarget };
}

type AppliedFields = { title: boolean; kind: boolean; date: boolean };

/**
 * Review-first apply: the title lands in the EDITABLE field (the user still
 * saves it via blur/Enter, the existing commit path); type and date each
 * commit that single field on an explicit tap. Never automatic.
 */
function useSuggestionApply({
  suggestion,
  setAppliedFields,
  detail,
}: {
  suggestion: DocumentSuggestionDto | null;
  setAppliedFields: (update: (prev: AppliedFields) => AppliedFields) => void;
  detail: DocumentDetail;
}) {
  const { t } = useTranslations();
  const calendarDate = useCalendarDate();
  const { patch, setTitleDraft, setEditingTitle } = detail;
  const applyTitle = () => {
    if (!suggestion?.title) return;
    setTitleDraft(suggestion.title);
    setEditingTitle(true);
    setAppliedFields((prev) => ({ ...prev, title: true }));
  };
  const applyKind = () => {
    if (!suggestion?.kind) return;
    patch.mutate({ kind: suggestion.kind });
    setAppliedFields((prev) => ({ ...prev, kind: true }));
  };
  const applyDate = () => {
    if (!suggestion?.documentDate) return;
    patch.mutate({ documentDate: suggestion.documentDate });
    setAppliedFields((prev) => ({ ...prev, date: true }));
  };

  const suggestionKindLabel = suggestion?.kind
    ? t(`documents.kind.${suggestion.kind}`)
    : null;
  const suggestionDateLabel = suggestion?.documentDate
    ? calendarDate(suggestion.documentDate)
    : null;

  return {
    applyTitle,
    applyKind,
    applyDate,
    suggestionKindLabel,
    suggestionDateLabel,
  };
}
