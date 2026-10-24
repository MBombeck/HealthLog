"use client";

"use client";

/**
 * The Dokumente vault — one wide, calm, filing-cabinet-fast surface.
 *
 * Filter state lives in the URL (`?q&kind&episode&encounter&year`) so every view is
 * shareable, back-button-safe, and deep-linkable from the illness page and
 * labs. Search debounces 200 ms and `/` focuses it. The timeline below is
 * virtualized; uploads appear optimistically above it in < 100 ms.
 *
 * Born-gated on the resolved `modules.inboundDocuments` flag from
 * `GET /api/auth/me` (per-user opt-in AND the operator availability layer).
 * An unauthenticated visitor bounces to login; an account without the
 * module bounces home. Every `/api/documents/inbound/*` route re-enforces
 * the gate server-side — this is a UX redirect, not the security boundary.
 */
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { FolderOpen, Loader2, SearchX, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PullToRefreshIndicator } from "@/components/ui/pull-to-refresh-indicator";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { DOCUMENT_PURGE_GRACE_DAYS } from "@/lib/documents/inbound-constants";
import { useTranslations } from "@/lib/i18n/context";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

import { DocumentBulkBar } from "./document-bulk-bar";
import { DocumentDetailSheet } from "./document-detail-sheet";
import { DocumentFilterBar } from "./document-filter-bar";
import { DocumentShareSheet } from "./document-share-sheet";
import { DocumentTimeline } from "./document-timeline";
import { UploadZone } from "./upload-zone";
import { countActiveFilters } from "./vault-utils";
import { useVaultDetail } from "./vault/use-vault-detail";
import { useVaultFilters } from "./vault/use-vault-filters";
import { useVaultLibrary } from "./vault/use-vault-library";
import { useVaultSelection } from "./vault/use-vault-selection";
import { VaultDropOverlay } from "./vault/vault-drop-overlay";
import { VaultPageActions } from "./vault/vault-page-actions";

/** The grace window the delete confirmation names. */
const GRACE = { days: DOCUMENT_PURGE_GRACE_DAYS };

/**
 * The vault page. Its state lives in `./vault/`: the URL filters, the
 * library (list, usage, uploads, filter choices), the selection and its bulk
 * actions, and the `?doc=` detail sheet; this component lays them out.
 */
export function DocumentsView() {
  const { t } = useTranslations();
  const { user, isLoading: authLoading, isAuthenticated } = useAuth();
  const timezone = user?.timezone || DEFAULT_TIMEZONE;
  // Uploading a document, filing it, sharing it and asking the AI about it
  // are none of them delegated verbs. Inside somebody else's record the vault
  // reads and nothing more: no upload path, no selection, no bulk bar, no
  // corpus backfill. `canManageDomain("documents")` says so from the server's
  // table, and answers false under every grant today.
  const { canManageDomain, inSharedRecord, sections } = useRecordCapabilities();
  const canManageDocuments = canManageDomain("documents");
  const router = useRouter();
  const pathname = usePathname();

  const moduleEnabled = user?.modules?.inboundDocuments === true;

  // UX redirect only — the API routes enforce the gate server-side.
  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      router.push("/auth/login");
    } else if (!moduleEnabled) {
      router.push("/");
    }
  }, [authLoading, isAuthenticated, moduleEnabled, router]);

  const {
    filters,
    searchDraft,
    setSearchDraft,
    searchInputRef,
    toggleKind,
    toggleEpisode,
    toggleEncounter,
    toggleYear,
    clearFilters,
  } = useVaultFilters();
  const {
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
  } = useVaultLibrary({
    filters,
    moduleEnabled,
    canManageDocuments,
    inSharedRecord,
    sections,
    timezone,
  });
  const {
    selectedIds,
    toggleSelected,
    clearSelection,
    bulk,
    runBulk,
    pendingDeleteIds,
    setPendingDeleteIds,
    requestDelete,
    confirmDelete,
    bulkShareOpen,
    setBulkShareOpen,
    bulkShareDocs,
    openBulkShare,
  } = useVaultSelection(documents);
  const {
    detailId,
    detailOpen,
    openDetail,
    handleDetailOpenChange,
    prefetchDetail,
  } = useVaultDetail({ authLoading, moduleEnabled, pathname });

  if (authLoading || !isAuthenticated || !moduleEnabled) {
    return (
      <div className="flex h-64 items-center justify-center" role="status">
        <Loader2
          className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none"
          aria-hidden
        />
        <span className="sr-only">{t("nav.loadingScreen")}</span>
      </div>
    );
  }

  const activeCount = countActiveFilters(filters);
  const isFiltered = activeCount > 0;
  const showEmpty =
    list.isSuccess && documents.length === 0 && upload.items.length === 0;

  return (
    <div className="space-y-6">
      <PullToRefreshIndicator {...pull} />
      <PageHeader
        title={t("documents.title")}
        description={t("documents.subtitle")}
        actions={
          canManageDocuments || !inSharedRecord ? (
            <VaultPageActions
              canManageDocuments={canManageDocuments}
              inSharedRecord={inSharedRecord}
              hideUpload={showEmpty && !isFiltered}
              uploadInputRef={uploadInputRef}
            />
          ) : null
        }
      />

      {canManageDocuments && (
        <UploadZone
          usage={usage.data}
          inputRef={uploadInputRef}
          onFiles={enqueueFiles}
        />
      )}
      {inSharedRecord && !canManageDocuments && (
        // Where the upload zone would be: the one empty space a person acting
        // for somebody else would otherwise search a control in.
        <p
          className="text-muted-foreground text-sm"
          data-slot="documents-owner-only"
        >
          {t("documents.ownerOnlyUpload")}
        </p>
      )}

      <DocumentFilterBar
        searchValue={searchDraft}
        onSearchChange={setSearchDraft}
        searchInputRef={searchInputRef}
        activeKinds={new Set(filters.kinds ?? [])}
        onToggleKind={toggleKind}
        conditionChips={conditionChips}
        activeEpisodeId={filters.episodeId}
        onToggleEpisode={toggleEpisode}
        procedureChips={procedureChips}
        activeEncounterId={filters.encounterId}
        onToggleEncounter={toggleEncounter}
        years={years}
        activeYear={filters.year}
        onToggleYear={toggleYear}
        activeCount={activeCount}
        onClearAll={clearFilters}
        showIndexAll={showIndexAll}
        indexAllPending={reindexAll.isPending}
        onIndexAll={handleIndexAll}
      />

      {list.isPending || isLayoutLoading ? (
        layout.view === "list" ? (
          <div data-slot="documents-loading" className="space-y-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-20 w-full rounded-xl" />
            ))}
          </div>
        ) : (
          <div
            data-slot="documents-loading"
            // The archive's tile shape (a 4:3 preview over two text lines),
            // in the timeline's column counts, so the grid does not jump when
            // the first page lands.
            className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4"
          >
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="aspect-[4/3] w-full rounded-xl" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
        )
      ) : list.isError ? (
        <QueryErrorCard
          error={list.error}
          title={t("documents.list.loadError")}
          onRetry={() => void list.refetch()}
        />
      ) : showEmpty && !isFiltered ? (
        <EmptyState
          icon={<FolderOpen className="size-6" aria-hidden />}
          title={t("documents.empty.title")}
          description={t("documents.empty.description")}
          action={
            canManageDocuments ? (
              <Button
                className="min-h-11 sm:min-h-9"
                onClick={() => uploadInputRef.current?.click()}
              >
                <Upload className="size-4" aria-hidden />
                {t("documents.empty.action")}
              </Button>
            ) : undefined
          }
        />
      ) : showEmpty && isFiltered ? (
        <EmptyState
          icon={<SearchX className="size-6" aria-hidden />}
          title={t("documents.empty.noMatchesTitle")}
          description={t("documents.empty.noMatchesDescription")}
          action={
            <Button variant="outline" onClick={clearFilters}>
              {t("documents.filter.clear")}
            </Button>
          }
        />
      ) : (
        <DocumentTimeline
          view={layout.view}
          arrangement={layout.arrangement}
          timezone={timezone}
          documents={documents}
          uploadItems={upload.items}
          onDismissUpload={upload.dismiss}
          hasNextPage={list.hasNextPage}
          isFetchingNextPage={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          selectedIds={selectedIds}
          onToggleSelected={canManageDocuments ? toggleSelected : undefined}
          onOpen={openDetail}
          onDelete={
            canManageDocuments ? (id) => requestDelete([id]) : undefined
          }
          highlightId={upload.highlightId}
          onPrefetch={prefetchDetail}
        />
      )}

      <DocumentDetailSheet
        documentId={detailId}
        open={detailOpen}
        onOpenChange={handleDetailOpenChange}
        assistAvailable={usage.data?.assistAvailable}
        contentIndexEnabled={usage.data?.contentIndex.enabled}
      />

      {canManageDocuments && selectedIds.size > 0 ? (
        <DocumentBulkBar
          selectedCount={selectedIds.size}
          episodes={(episodes.data ?? []).map((e) => ({
            id: e.id,
            label: e.label,
          }))}
          busy={bulk.isPending}
          onSetKind={(kind) => runBulk("setKind", { kind })}
          onLinkEpisode={(episodeId) => runBulk("linkEpisode", { episodeId })}
          encounters={bulkEncounterOptions}
          onLinkEncounter={(encounterId) =>
            runBulk("linkEncounter", { encounterId })
          }
          onShare={openBulkShare}
          onRequestDelete={() => requestDelete([...selectedIds])}
          onClear={clearSelection}
        />
      ) : null}

      <ConfirmDialog
        open={pendingDeleteIds !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteIds(null);
        }}
        title={
          pendingDeleteIds !== null && pendingDeleteIds.length > 1
            ? t("documents.deleteConfirm.titleMany", {
                count: pendingDeleteIds.length,
              })
            : t("documents.deleteConfirm.titleOne")
        }
        body={t("documents.deleteConfirm.body", GRACE)}
        confirmLabel={t("documents.deleteConfirm.action")}
        onConfirm={confirmDelete}
        slot="documents-delete"
        destructive
      />

      <DocumentShareSheet
        open={bulkShareOpen}
        onOpenChange={setBulkShareOpen}
        documents={bulkShareDocs}
      />

      {dropActive ? <VaultDropOverlay /> : null}
      <p aria-live="polite" role="status" className="sr-only">
        {uploadAnnouncement}
      </p>
    </div>
  );
}
