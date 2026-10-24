"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { useIllnessEpisodes } from "@/components/illness/use-illness";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { apiGet } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { useDocumentsLayout } from "@/lib/queries/use-documents-layout";
import { queryKeys } from "@/lib/query-keys";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";

import { useReindexAll } from "../use-content-index";
import { useDocumentUpload } from "../use-document-upload";
import { usePageFileDrop } from "../use-page-file-drop";
import { buildVaultListApiSearch, hasProcessingDocument } from "../vault-utils";

import { useDocumentUsage } from "./use-document-usage";
import type { VaultFilters } from "./use-vault-filters";
import { useVaultFilterChoices } from "./use-vault-filter-choices";

interface ListPage {
  documents: InboundDocumentDto[];
  nextCursor: string | null;
}

/**
 * Everything the vault shows: the usage gauge, the paged list for the active
 * filters, the reader's layout, the upload queue and its intake paths, the
 * corpus-index affordance, and the filter choices (conditions, procedures,
 * visits for the bulk bar, years).
 */
export function useVaultLibrary({
  filters,
  moduleEnabled,
  canManageDocuments,
  inSharedRecord,
  sections,
  timezone,
}: {
  filters: VaultFilters["filters"];
  moduleEnabled: boolean;
  canManageDocuments: boolean;
  inSharedRecord: boolean;
  sections: readonly string[] | null;
  timezone: string;
}) {
  const { t } = useTranslations();
  const usage = useDocumentUsage(moduleEnabled);

  const list = useInfiniteQuery({
    queryKey: queryKeys.inboundDocumentList(filters),
    enabled: moduleEnabled,
    queryFn: ({ pageParam }) =>
      apiGet<ListPage>(
        `/api/documents/inbound?${buildVaultListApiSearch(filters, pageParam)}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    // .x — the auto-index (+ optional AI summary) job that lands right
    // after upload is fire-and-forget server-side; nothing pushes its
    // completion to the client. Poll while any loaded document is still
    // inside its recent-upload processing window (see `hasProcessingDocument`
    // — bounded, so an old/permanently-unindexed document never keeps this
    // polling forever) so the card's "Processing…" chip clears on its own
    // once the index lands, without a manual refresh.
    refetchInterval: (query) => {
      const pages = query.state.data?.pages ?? [];
      const docs = pages.flatMap((p) => p.documents);
      return hasProcessingDocument(docs) ? 4000 : false;
    },
  });

  const documents = useMemo(
    () => list.data?.pages.flatMap((p) => p.documents) ?? [],
    [list.data],
  );

  // The reader's presentation (cards / list, stacked / flowing months),
  // persisted per user and changed behind the wrench.
  const { layout, isLayoutLoading } = useDocumentsLayout(moduleEnabled);

  // Pull-to-refresh parity with labs/checkups/mood/
  // measurements/medications. The vault is one of the sharpest PWA-resume-
  // staleness surfaces named in the audit: a document indexed server-side
  // while the tab was backgrounded (auto-index / AI summary) otherwise
  // stays invisible until the bounded processing poll above happens to
  // catch it or the user navigates away and back.
  const refreshDocuments = useCallback(
    () => Promise.all([list.refetch(), usage.refetch()]),
    [list, usage],
  );
  const pull = usePullToRefresh({ onRefresh: refreshDocuments });

  const upload = useDocumentUpload(
    usage.data ? { maxFileBytes: usage.data.maxFileBytes } : undefined,
  );
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  // One intake path for every source (picker, zone drop, page-wide drop,
  // clipboard paste): pre-links to the active episode filter and feeds the
  // sr-only live region — the drop overlay itself is decorative.
  const [uploadAnnouncement, setUploadAnnouncement] = useState("");
  const enqueueRef = useRef(upload.enqueue);
  useEffect(() => {
    enqueueRef.current = upload.enqueue;
  }, [upload.enqueue]);
  const episodeIdFilter = filters.episodeId;
  const encounterIdFilter = filters.encounterId;
  const enqueueFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      enqueueRef.current(files, {
        episodeId: episodeIdFilter,
        encounterId: encounterIdFilter,
      });
      setUploadAnnouncement(
        t("documents.upload.queuedAnnouncement", { count: files.length }),
      );
    },
    [episodeIdFilter, encounterIdFilter, t],
  );
  const { dropActive } = usePageFileDrop(
    canManageDocuments ? enqueueFiles : undefined,
  );

  const episodes = useIllnessEpisodes(
    true,
    !inSharedRecord || sections === null || sections.includes("illness"),
  );

  // Content-search coverage: fire the corpus backfill when indexing is
  // available and some documents are not yet searchable. The list search
  // already unions content matches server-side — this only surfaces the hint
  // and the "index all" affordance from the usage gauge.
  const reindexAll = useReindexAll();
  const contentIndex = usage.data?.contentIndex;
  const canIndexContent = contentIndex?.enabled ?? false;
  const showIndexAll =
    canManageDocuments &&
    canIndexContent &&
    contentIndex !== undefined &&
    contentIndex.totalCount > 0 &&
    contentIndex.indexedCount < contentIndex.totalCount;
  const handleIndexAll = useCallback(() => {
    reindexAll.mutate(undefined, {
      onSuccess: (result) =>
        toast.success(
          result.enqueued > 0
            ? t("documents.contentIndex.indexAllQueued", {
                count: result.enqueued,
              })
            : t("documents.contentIndex.indexAllNothing"),
        ),
      onError: (failure) =>
        showErrorToast(t("documents.contentIndex.indexAllError"), {
          cause: failure,
        }),
    });
  }, [reindexAll, t]);

  const { conditionChips, bulkEncounterOptions, procedureChips, years } =
    useVaultFilterChoices({
      filters,
      usage: usage.data,
      episodes: episodes.data,
      documents,
      timezone,
      inSharedRecord,
      sections,
    });

  return {
    usage,
    list,
    documents,
    layout,
    isLayoutLoading,
    pull,
    upload,
    uploadInputRef,
    uploadAnnouncement,
    enqueueFiles,
    dropActive,
    episodes,
    reindexAll,
    showIndexAll,
    handleIndexAll,
    conditionChips,
    bulkEncounterOptions,
    procedureChips,
    years,
  };
}
