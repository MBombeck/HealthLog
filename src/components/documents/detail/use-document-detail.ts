"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useIllnessEpisodes } from "@/components/illness/use-illness";
import { useAuth } from "@/hooks/use-auth";
import { useFencedObjectUrl } from "@/hooks/use-fenced-object-url";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import {
  apiDelete,
  ApiError,
  apiGet,
  apiPatch,
  apiPost,
} from "@/lib/api/api-fetch";
import { DOCUMENT_PURGE_GRACE_DAYS } from "@/lib/documents/inbound-constants";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, queryKeys } from "@/lib/query-keys";
import type {
  DocumentSourceSystemValue,
  InboundDocumentDetailDto,
  InboundDocumentKindValue,
} from "@/lib/validations/inbound-documents";

import { DOCUMENT_KIND_ICONS } from "../document-kind-meta";

export type PatchInput = {
  title?: string | null;
  kind?: InboundDocumentKindValue;
  documentDate?: string | null;
  episodeIds?: string[];
  encounterIds?: string[];
  vaccinationIds?: string[];
};

/**
 * The open document: its read (always fresh on open, since the link pickers
 * write replace-sets seeded from it), the metadata edits that save on commit,
 * the soft delete with an Undo that restores it, and the original's bytes for
 * a document that previews inline.
 */
export function useDocumentDetail({
  documentId,
  open,
  onOpenChange,
}: {
  documentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslations();
  const detail = useQuery({
    queryKey: queryKeys.inboundDocument(documentId ?? "none"),
    enabled: open && documentId !== null,
    // Always read again on open: the link pickers below write replace-sets
    // seeded from this copy (see `seedFresh`).
    staleTime: 0,
    queryFn: () =>
      apiGet<InboundDocumentDetailDto>(`/api/documents/inbound/${documentId}`),
  });
  const doc = detail.data;

  // The detail's timestamp when the sheet opened on this document. A read
  // that lands after it is fresh enough to seed the link pickers from; a
  // cached copy from before the sheet opened is not.
  const [openedOn, setOpenedOn] = useState<{
    id: string;
    seenAt: number;
  } | null>(null);
  const openKey = open && documentId !== null ? documentId : null;
  if (openKey !== (openedOn?.id ?? null)) {
    setOpenedOn(
      openKey === null ? null : { id: openKey, seenAt: detail.dataUpdatedAt },
    );
  }
  const linkSeedFresh =
    openedOn !== null && detail.dataUpdatedAt > openedOn.seenAt;

  // The document → lab-values direction
  // had no UI link at all: an auto-staged (PENDING) or OCR-confirmed
  // (APPROVED, see `linkOcrLabsToVaultDocument`) OBSERVATION fact already
  // ties this document to specific lab rows, but nothing on the sheet said
  // so. There is no per-value route yet (`/labs` has no `?analyte=`
  // deep-link — see the labs page's own "no per-value relation" comment),
  // so this links to the labs list rather than a single biomarker; still a
  // real jump where there was none before.
  //
  // APPROVED only: the link claims values that exist in Labs, and a PENDING
  // fact is not there yet — it belongs to the review block above, which is
  // the control that turns it into one.
  const labFactCount =
    doc?.facts.filter(
      (fact) => fact.factType === "OBSERVATION" && fact.status === "APPROVED",
    ).length ?? 0;
  const { user } = useAuth();
  const { canManageDomain } = useRecordCapabilities();
  const canManageDocuments = canManageDomain("documents");
  const labsModuleEnabled = user?.modules?.labs !== false;

  const episodes = useIllnessEpisodes(true);

  const [mutationError, setMutationError] = useState<string | null>(null);
  /** Bumped on a failed write; remounts the link block onto server state. */
  const [linkResets, setLinkResets] = useState(0);
  const [shareOpen, setShareOpen] = useState(false);
  // Delete asks first, like every other way of deleting from the vault.
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  /**
   * The visit this SESSION filed the document against, if any.
   *
   * Kept beside the server state rather than derived from it, because the two
   * answer different questions: `doc.encounterLinks` says what is filed, this
   * says what the person just did here — which is what an undo can take back
   * without touching a filing they made somewhere else.
   */
  const [pickedEncounterId, setPickedEncounterId] = useState<string | null>(
    null,
  );
  const [titleDraft, setTitleDraft] = useState("");

  // Reset transient edit state whenever another document opens —
  // render-phase derived-state adjustment, not an effect.
  const [lastDocumentId, setLastDocumentId] = useState(documentId);
  if (lastDocumentId !== documentId) {
    setLastDocumentId(documentId);
    setEditingTitle(false);
    setShareOpen(false);
    setMutationError(null);
  }

  const { patch, remove } = useDocumentWrites({
    documentId,
    onOpenChange,
    setMutationError,
    setLinkResets,
  });

  const commitTitle = () => {
    if (!doc) return;
    setEditingTitle(false);
    const next = titleDraft.trim();
    const current = doc.title ?? "";
    if (next === current) return;
    patch.mutate({ title: next === "" ? null : next });
  };

  const toggleEpisode = (episodeId: string) => {
    if (!doc) return;
    const current = doc.conditionLinks.map((l) => l.episodeId);
    const next = current.includes(episodeId)
      ? current.filter((id) => id !== episodeId)
      : [...current, episodeId];
    patch.mutate({ episodeIds: next });
  };

  /**
   * File this document against a visit, or clear that filing again.
   *
   * A replace-set PATCH like the condition links, so the undo is the same
   * write with the id removed rather than a second endpoint. Nothing here can
   * fail the document: an unknown id is refused by the route before anything
   * is written, and the sheet keeps showing what the server last confirmed.
   */
  const setSuggestedEncounter = (encounterId: string | null) => {
    if (!doc) return;
    const current = doc.encounterLinks.map((l) => l.encounterId);
    const next =
      encounterId === null
        ? current.filter((id) => id !== pickedEncounterId)
        : [...new Set([...current, encounterId])];
    setPickedEncounterId(encounterId);
    patch.mutate({ encounterIds: next });
  };

  const title = doc?.title ?? doc?.filename ?? t("documents.card.untitled");
  // The product names are proper nouns and stay untranslated; only "another
  // system" is prose.
  const sourceSystemName = (system: DocumentSourceSystemValue): string =>
    system === "PAPERLESS"
      ? "Paperless-ngx"
      : system === "PAPRA"
        ? "Papra"
        : t("documents.detail.sourceOther");
  const Icon = doc ? DOCUMENT_KIND_ICONS[doc.kind] : null;
  // The ONE eager fetch of the original, and only for a document
  // that is going to render it.
  //
  // A `<iframe src="/api/…">` carries no record-session assertion, so the
  // fence refuses it once the session has been inside a shared record; the
  // bytes therefore come through the app transport as an object URL. The
  // narrow path is the point: a non-inline document (a large scan, a
  // download-only format) fetched nothing until somebody clicked, and it must
  // stay that way — this used to fetch for every document on open, twice.
  const { url: inlineSrc, failed: inlineFailed } = useFencedObjectUrl(
    doc && doc.servingClass === "inline"
      ? `/api/documents/inbound/${doc.id}/original`
      : null,
  );

  return {
    detail,
    doc,
    linkSeedFresh,
    labFactCount,
    canManageDocuments,
    labsModuleEnabled,
    episodes,
    mutationError,
    linkResets,
    shareOpen,
    setShareOpen,
    confirmDeleteOpen,
    setConfirmDeleteOpen,
    editingTitle,
    setEditingTitle,
    titleDraft,
    setTitleDraft,
    pickedEncounterId,
    patch,
    remove,
    commitTitle,
    toggleEpisode,
    setSuggestedEncounter,
    title,
    sourceSystemName,
    Icon,
    inlineSrc,
    inlineFailed,
  };
}

export type DocumentDetail = ReturnType<typeof useDocumentDetail>;

/**
 * The writes from the sheet: the replace-set PATCH (a link written here also
 * refreshes the visit's and the dose's own views), and the soft delete whose
 * toast carries an Undo; a refused restore names why (`purged`,
 * `duplicateExists`).
 */
function useDocumentWrites({
  documentId,
  onOpenChange,
  setMutationError,
  setLinkResets,
}: {
  documentId: string | null;
  onOpenChange: (open: boolean) => void;
  setMutationError: (message: string | null) => void;
  setLinkResets: (update: (n: number) => number) => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const patch = useMutation({
    mutationFn: (input: PatchInput) =>
      apiPatch<InboundDocumentDetailDto>(
        `/api/documents/inbound/${documentId}`,
        input,
      ),
    onSuccess: (_data, input) => {
      setMutationError(null);
      // A link written from this side changes what the visit's and the
      // dose's own views list, so their reads refresh with the vault's.
      void invalidateKeys(queryClient, [
        queryKeys.documents(),
        ...(input.encounterIds !== undefined ? [queryKeys.encounters()] : []),
        ...(input.vaccinationIds !== undefined
          ? [queryKeys.vaccinations()]
          : []),
      ]);
    },
    onError: () => {
      setMutationError(t("documents.detail.saveError"));
      setLinkResets((n) => n + 1);
    },
  });

  const restore = useMutation({
    mutationFn: (id: string) =>
      apiPost(`/api/documents/inbound/${id}/restore`, {}),
    onSuccess: () => {
      void invalidateKeys(queryClient, [queryKeys.documents()]);
    },
    onError: (error) => {
      const reason =
        error instanceof ApiError && typeof error.meta?.reason === "string"
          ? error.meta.reason
          : "";
      if (reason === "purged") {
        showErrorToast(t("documents.error.purged"), { cause: error });
      } else if (reason === "duplicateExists") {
        showErrorToast(t("documents.error.duplicateExists"), { cause: error });
      } else {
        showErrorToast(t("documents.toast.restoreFailed"), { cause: error });
      }
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/documents/inbound/${id}`),
    onSuccess: (_data, id) => {
      onOpenChange(false);
      void invalidateKeys(queryClient, [queryKeys.documents()]);
      toast.success(t("documents.toast.deleted"), {
        description: t("documents.toast.deletedHint", {
          days: DOCUMENT_PURGE_GRACE_DAYS,
        }),
        action: {
          label: t("common.undo"),
          onClick: () => restore.mutate(id),
        },
      });
    },
    onError: () => setMutationError(t("documents.detail.deleteError")),
  });

  return { patch, remove };
}
