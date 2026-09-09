"use client";

/**
 * The Dokumente vault — one wide, calm, filing-cabinet-fast surface.
 *
 * Filter state lives in the URL (`?q&kind&episode&year`) so every view is
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
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  FolderOpen,
  Loader2,
  SearchX,
  Upload,
  UploadCloud,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useIllnessEpisodes } from "@/components/illness/use-illness";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { useUrlFilterSync } from "@/hooks/use-url-filter-sync";
import { PullToRefreshIndicator } from "@/components/ui/pull-to-refresh-indicator";
import { apiGet, apiPost } from "@/lib/api/api-fetch";
import { encounterKindText } from "@/components/encounters/encounter-labels";
import { useEncounters } from "@/hooks/use-encounters";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { EncounterKind } from "@/generated/prisma/client";
import {
  type CoachCloseIntent,
  useCoachLaunch,
} from "@/lib/insights/coach-launch-context";
import { invalidateKeys, queryKeys } from "@/lib/query-keys";
import {
  DOCUMENT_BULK_MAX_IDS,
  type DocumentBulkAction,
  type DocumentBulkResultDto,
  type DocumentUsageDto,
  type InboundDocumentDetailDto,
  type InboundDocumentDto,
  type InboundDocumentKindValue,
} from "@/lib/validations/inbound-documents";
import { DocumentBulkBar } from "./document-bulk-bar";
import { DocumentDetailSheet } from "./document-detail-sheet";
import { DocumentShareSheet } from "./document-share-sheet";
import { DocumentFilterBar, type ConditionChip } from "./document-filter-bar";
import { DocumentTimeline } from "./document-timeline";
import { UploadZone } from "./upload-zone";
import { useReindexAll } from "./use-content-index";
import { useDocumentUpload } from "./use-document-upload";
import { usePageFileDrop } from "./use-page-file-drop";
import {
  buildVaultListApiSearch,
  countActiveFilters,
  documentDateKey,
  expandRangeSelection,
  hasProcessingDocument,
  parseVaultSearchParams,
  resolveBulkShareDocuments,
  SHARE_LINK_MAX_DOCUMENTS,
  vaultFiltersToSearch,
} from "./vault-utils";

interface ListPage {
  documents: InboundDocumentDto[];
  nextCursor: string | null;
}

// Strict end-of-input: `$` also accepts a trailing newline in JavaScript.
/**
 * How many visits the bulk bar offers. A menu is a picker, not a history: past
 * the first screenful a person scrolls rather than reads, and filing against a
 * visit older than this belongs on the visit's own sheet.
 */
const BULK_VISIT_OPTIONS = 12;

const DOCUMENT_QUERY_ID_PATTERN = /^[a-zA-Z0-9_-]{1,40}(?![\s\S])/;
const DOCUMENT_SELECTION_HISTORY_KEY = "__healthlogPushedDocumentSelection";

export function documentSelectionHistoryState(
  documentId: string,
): Record<string, unknown> {
  // Pass only application state here. Next's patched pushState copies its
  // private router fields onto this object; copying history.state ourselves
  // would include `__NA` and make that patch treat this as an internal write,
  // skipping useSearchParams synchronization.
  return { [DOCUMENT_SELECTION_HISTORY_KEY]: documentId };
}

export function documentSelectionHref(
  pathname: string,
  currentSearch: string,
  documentId: string,
): string | null {
  if (!DOCUMENT_QUERY_ID_PATTERN.test(documentId)) return null;
  const next = new URLSearchParams(currentSearch);
  next.set("doc", documentId);
  const search = next.toString();
  return search ? `${pathname}?${search}` : pathname;
}

export function withoutDocumentSelectionHref(
  pathname: string,
  currentSearch: string,
): string {
  const next = new URLSearchParams(currentSearch);
  next.delete("doc");
  const search = next.toString();
  return search ? `${pathname}?${search}` : pathname;
}

/**
 * How long to wait before checking that `history.back()` actually happened.
 *
 * Long enough for a traversal to commit on a loaded machine, short enough that
 * a reader who closed the sheet does not see the selection linger in the
 * address bar. The window is bounded on the other side too: the effect that
 * arms this cancels it as soon as the sheet re-opens.
 */
export const CLOSE_TRAVERSAL_GRACE_MS = 250;

/**
 * The selection this close was meant to consume is still in the address bar.
 *
 * Matched on the id rather than on the presence of `doc`, so a traversal that
 * landed somewhere carrying a DIFFERENT selection is not mistaken for a
 * dropped one and stripped.
 */
export function documentSelectionSurvivedClose(
  search: string,
  documentId: string,
): boolean {
  return new URLSearchParams(search).get("doc") === documentId;
}

export function closeDocumentSelectionHistoryEntry(
  history: {
    readonly state: unknown;
    back: () => void;
    replaceState: (
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ) => void;
  },
  pathname: string,
  currentSearch: string,
  documentId: string,
): void {
  const ownsCurrentEntry =
    history.state !== null &&
    typeof history.state === "object" &&
    (history.state as Record<string, unknown>)[
      DOCUMENT_SELECTION_HISTORY_KEY
    ] === documentId;
  if (ownsCurrentEntry) {
    // Card selection owns the current pushed entry. Returning to its base
    // consumes it, so the user's next Back reaches the prior distinct page.
    history.back();
    return;
  }

  // A deep link did not create a disposable entry on this page. Keep the user
  // here and remove only the selection from the current URL.
  history.replaceState(
    null,
    "",
    withoutDocumentSelectionHref(pathname, currentSearch),
  );
}

/**
 * The selection is being KEPT on purpose, as the way back.
 *
 * Maximizing the Coach drawer hands the conversation to `/coach` and carries
 * `?doc=` with it, so browser-Back can reconstruct the sheet. That is the one
 * close-shaped transition that must leave the parameter exactly where it is.
 *
 * Named, and used by both the close and the check that follows it, because
 * those two disagreeing is a bug with no symptom until it has one: the check
 * would strip the return URL a few hundred milliseconds after the close
 * deliberately preserved it, and whether it won that race was a question about
 * how fast the machine navigated.
 */
export function coachHandoffRetainsSelection(
  documentId: string,
  handedOffDocumentId: string | null,
  closeIntent: CoachCloseIntent | null | undefined,
): boolean {
  return handedOffDocumentId === documentId && closeIntent === "navigate";
}

export function closeDocumentSelectionAfterCoachHandoff(
  history: Parameters<typeof closeDocumentSelectionHistoryEntry>[0],
  pathname: string,
  currentSearch: string,
  documentId: string,
  handedOffDocumentId: string | null,
  closeIntent: CoachCloseIntent | null | undefined,
): string | null {
  if (
    coachHandoffRetainsSelection(documentId, handedOffDocumentId, closeIntent)
  ) {
    return handedOffDocumentId;
  }

  closeDocumentSelectionHistoryEntry(
    history,
    pathname,
    currentSearch,
    documentId,
  );
  return handedOffDocumentId === documentId ? null : handedOffDocumentId;
}

export function DocumentsView() {
  const { t } = useTranslations();
  const format = useFormatters();
  const { user, isLoading: authLoading, isAuthenticated } = useAuth();
  // v1.36.x — uploading a document, filing it, sharing it and asking the AI
  // about it are none of them delegated verbs. Inside somebody else's record
  // the vault reads and nothing more: no upload path, no selection, no bulk
  // bar, no corpus backfill. `canManageDomain("documents")` says so from the
  // server's table, and answers false under every grant today.
  const { canManageDomain, inSharedRecord, sections } = useRecordCapabilities();
  const canManageDocuments = canManageDomain("documents");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const coachLaunch = useCoachLaunch();

  const moduleEnabled =
    inSharedRecord || user?.modules?.inboundDocuments === true;

  // UX redirect only — the API routes enforce the gate server-side.
  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      router.push("/auth/login");
    } else if (!moduleEnabled) {
      router.push("/");
    }
  }, [authLoading, isAuthenticated, moduleEnabled, router]);

  // ── URL-owned filter state ────────────────────────────────────────────
  // The parse/serialise round trip stays in `vault-utils.ts`; the router
  // plumbing lives in the shared hook (which the measurements and mood
  // lists reuse — this surface is the pattern's origin).
  const { filters, applyFilters } = useUrlFilterSync({
    parse: parseVaultSearchParams,
    serialise: vaultFiltersToSearch,
  });

  // Search draft debounces into the URL (200 ms); an external URL change
  // (back button, deep link) re-seeds the draft — render-phase derived-state
  // adjustment, not an effect.
  const [searchDraft, setSearchDraft] = useState(filters.q ?? "");
  const [lastUrlQ, setLastUrlQ] = useState(filters.q ?? "");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  if ((filters.q ?? "") !== lastUrlQ) {
    setLastUrlQ(filters.q ?? "");
    setSearchDraft(filters.q ?? "");
  }
  useEffect(() => {
    const handle = setTimeout(() => {
      const trimmed = searchDraft.trim();
      if (trimmed === (filters.q ?? "")) return;
      applyFilters(
        { ...filters, q: trimmed === "" ? undefined : trimmed },
        "replace",
      );
    }, 200);
    return () => clearTimeout(handle);
  }, [searchDraft, filters, applyFilters]);

  // `/` focuses the search from anywhere on the page.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey)
        return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const toggleKind = (kind: InboundDocumentKindValue) => {
    const current = new Set(filters.kinds ?? []);
    if (current.has(kind)) {
      current.delete(kind);
    } else {
      current.add(kind);
    }
    applyFilters(
      {
        ...filters,
        kinds: current.size > 0 ? [...current].sort() : undefined,
      },
      "push",
    );
  };

  const toggleEpisode = (episodeId: string) => {
    applyFilters(
      {
        ...filters,
        episodeId: filters.episodeId === episodeId ? undefined : episodeId,
      },
      "push",
    );
  };

  const toggleYear = (year: number) => {
    applyFilters(
      { ...filters, year: filters.year === year ? undefined : year },
      "push",
    );
  };

  const clearFilters = () => {
    setSearchDraft("");
    applyFilters({}, "push");
  };

  // ── Data ──────────────────────────────────────────────────────────────
  const usage = useQuery({
    queryKey: queryKeys.inboundDocumentUsage(),
    enabled: moduleEnabled,
    queryFn: () => apiGet<DocumentUsageDto>("/api/documents/inbound/usage"),
  });

  const list = useInfiniteQuery({
    queryKey: queryKeys.inboundDocumentList(filters),
    enabled: moduleEnabled,
    queryFn: ({ pageParam }) =>
      apiGet<ListPage>(
        `/api/documents/inbound?${buildVaultListApiSearch(filters, pageParam)}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    // v1.29.x — the auto-index (+ optional AI summary) job that lands right
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

  // v1.30.1 M12 — pull-to-refresh parity with labs/checkups/mood/
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
  const enqueueFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      enqueueRef.current(files, { episodeId: episodeIdFilter });
      setUploadAnnouncement(
        t("documents.upload.queuedAnnouncement", { count: files.length }),
      );
    },
    [episodeIdFilter, t],
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
      onError: () => toast.error(t("documents.contentIndex.indexAllError")),
    });
  }, [reindexAll, t]);

  // Condition chips: every episode carrying at least one live document
  // link, served by the usage endpoint (NOT derived from the loaded corpus
  // — an old linked document pages deep must still surface its chip), plus
  // the actively filtered episode (a deep link must always show its own
  // chip, even when its last link was just removed).
  const conditionChips = useMemo<ConditionChip[]>(() => {
    const byId = new Map<string, string>();
    for (const link of usage.data?.linkedEpisodes ?? []) {
      byId.set(link.episodeId, link.name);
    }
    if (filters.episodeId && !byId.has(filters.episodeId)) {
      const episode = episodes.data?.find((e) => e.id === filters.episodeId);
      byId.set(filters.episodeId, episode?.label ?? filters.episodeId);
    }
    return [...byId.entries()]
      .map(([episodeId, name]) => ({ episodeId, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [usage.data?.linkedEpisodes, filters.episodeId, episodes.data]);

  // The visits the bulk bar can file a selection against: the account's own,
  // read through the same list the checkups page shows. Labelled here rather
  // than in the bar so the label uses the reader's locale for the kind and the
  // reader's timezone for the date — both presentation, both this side's job.
  const visits = useEncounters(
    !inSharedRecord || sections === null || sections.includes("profile"),
  );
  const bulkEncounterOptions = useMemo(
    () =>
      [...(visits.data?.upcoming ?? []), ...(visits.data?.past ?? [])]
        .slice(0, BULK_VISIT_OPTIONS)
        .map((visit) => ({
          id: visit.id,
          label: `${
            visit.practitioner?.name ??
            encounterKindText(t, visit.kind as EncounterKind)
          } · ${format.date(visit.occurredAt)}`,
        })),
    [visits.data, t, format],
  );

  // Year segmenter: years present in the loaded corpus (+ the active year).
  const years = useMemo(() => {
    const set = new Set<number>();
    for (const doc of documents) {
      set.add(Number(documentDateKey(doc).slice(0, 4)));
    }
    if (filters.year !== undefined) set.add(filters.year);
    return [...set].sort((a, b) => b - a);
  }, [documents, filters.year]);

  // ── Selection + bulk actions ──────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  // Anchor for shift-click ranges: the last plainly-toggled id.
  const rangeAnchorRef = useRef<string | null>(null);
  const toggleSelected = useCallback(
    (id: string, range?: boolean) => {
      setSelectedIds((prev) => {
        if (range) {
          return expandRangeSelection(
            documents.map((d) => d.id),
            prev,
            rangeAnchorRef.current,
            id,
          );
        }
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
      if (!range) rangeAnchorRef.current = id;
    },
    [documents],
  );
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    rangeAnchorRef.current = null;
  }, []);

  // Escape clears the selection — unless a dialog/popover owns the key.
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('[role="dialog"],[role="menu"]')) return;
      clearSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedIds.size, clearSelection]);

  /**
   * One bulk POST per ≤100-id chunk (the endpoint's cap); per-id results
   * are merged so a partial failure in any chunk surfaces once. The
   * endpoint is no-op-success on already-in-state rows, so an undo toast
   * firing twice is safe by contract.
   */
  const bulk = useMutation({
    mutationFn: async (input: {
      ids: string[];
      action: DocumentBulkAction;
      kind?: InboundDocumentKindValue;
      episodeId?: string;
    }) => {
      const results: DocumentBulkResultDto[] = [];
      for (let i = 0; i < input.ids.length; i += DOCUMENT_BULK_MAX_IDS) {
        const chunk = input.ids.slice(i, i + DOCUMENT_BULK_MAX_IDS);
        const page = await apiPost<{ results: DocumentBulkResultDto[] }>(
          "/api/documents/inbound/bulk",
          {
            ids: chunk,
            action: input.action,
            ...(input.kind !== undefined && { kind: input.kind }),
            ...(input.episodeId !== undefined && {
              episodeId: input.episodeId,
            }),
          },
        );
        results.push(...page.results);
      }
      return results;
    },
    onSettled: () => {
      void invalidateKeys(queryClient, [queryKeys.documents()]);
    },
  });

  const reportBulkOutcome = useCallback(
    (results: DocumentBulkResultDto[], successMessage: string) => {
      const failed = results.filter((r) => !r.ok).length;
      if (failed > 0) {
        toast.error(
          t("documents.bulk.partialFailure", {
            failed,
            total: results.length,
          }),
        );
      } else {
        toast.success(successMessage);
      }
    },
    [t],
  );

  const runBulk = useCallback(
    (
      action: Exclude<DocumentBulkAction, "delete" | "restore">,
      extra: {
        kind?: InboundDocumentKindValue;
        episodeId?: string;
        encounterId?: string;
      },
    ) => {
      const ids = [...selectedIds];
      bulk.mutate(
        { ids, action, ...extra },
        {
          onSuccess: (results) => {
            reportBulkOutcome(
              results,
              t("documents.bulk.updated", {
                count: results.filter((r) => r.ok).length,
              }),
            );
            clearSelection();
          },
          onError: () => toast.error(t("documents.bulk.failed")),
        },
      );
    },
    [selectedIds, bulk, reportBulkOutcome, clearSelection, t],
  );

  const restoreBulk = useCallback(
    (ids: string[]) => {
      bulk.mutate(
        { ids, action: "restore" },
        {
          onSuccess: (results) =>
            reportBulkOutcome(
              results,
              t("documents.bulk.restored", {
                count: results.filter((r) => r.ok).length,
              }),
            ),
          onError: () => toast.error(t("documents.toast.restoreFailed")),
        },
      );
    },
    [bulk, reportBulkOutcome, t],
  );

  const deleteBulk = useCallback(
    (ids: string[]) => {
      bulk.mutate(
        { ids, action: "delete" },
        {
          onSuccess: (results) => {
            const okIds = results.filter((r) => r.ok).map((r) => r.id);
            const failed = results.length - okIds.length;
            if (failed > 0) {
              toast.error(
                t("documents.bulk.partialFailure", {
                  failed,
                  total: results.length,
                }),
              );
            }
            if (okIds.length > 0) {
              // ONE aggregate undo for the whole batch (bulk restore).
              toast.success(
                t("documents.bulk.deleted", { count: okIds.length }),
                {
                  action: {
                    label: t("common.undo"),
                    onClick: () => restoreBulk(okIds),
                  },
                },
              );
            }
            clearSelection();
          },
          onError: () => toast.error(t("documents.bulk.failed")),
        },
      );
    },
    [bulk, clearSelection, restoreBulk, t],
  );

  // ── Bulk share ────────────────────────────────────────────────────────
  // ONE documents-only link for the whole selection (the share model carries
  // up to SHARE_MAX_DOCUMENTS docs per link). The titles come from the loaded
  // corpus — a selected id is always a rendered row. Over the cap we surface a
  // hint and refuse rather than silently dropping docs from the link.
  const [bulkShareOpen, setBulkShareOpen] = useState(false);
  const [bulkShareDocs, setBulkShareDocs] = useState<
    { id: string; title: string }[]
  >([]);
  const openBulkShare = useCallback(() => {
    const resolved = resolveBulkShareDocuments(
      documents,
      selectedIds,
      t("documents.card.untitled"),
    );
    if (resolved.overCap) {
      toast.error(
        t("documents.bulk.shareTooMany", { max: SHARE_LINK_MAX_DOCUMENTS }),
      );
      return;
    }
    if (resolved.documents.length === 0) return;
    setBulkShareDocs(resolved.documents);
    setBulkShareOpen(true);
  }, [documents, selectedIds, t]);

  // ── Detail sheet ──────────────────────────────────────────────────────
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const handedOffDocumentRef = useRef<string | null>(null);

  const rawDocParam = searchParams.get("doc");
  const docParam =
    rawDocParam !== null && DOCUMENT_QUERY_ID_PATTERN.test(rawDocParam)
      ? rawDocParam
      : null;
  const [observedDocParam, setObservedDocParam] = useState<string | null>(null);

  // The query is the navigation owner: direct links, browser back, and browser
  // forward all drive the same detail selection without remounting the route.
  // Wait for auth so a deep link cannot be consumed before the module gate is
  // known, and never interpolate an unvalidated id into the detail API path.
  if (!authLoading && moduleEnabled && rawDocParam !== observedDocParam) {
    setObservedDocParam(rawDocParam);
    setDetailId(docParam);
    setDetailOpen(docParam !== null);
  }

  const openDetail = useCallback(
    (id: string) => {
      const href = documentSelectionHref(pathname, searchParams.toString(), id);
      if (href === null) return;
      handedOffDocumentRef.current = null;
      setDetailId(id);
      setDetailOpen(true);
      window.history.pushState(documentSelectionHistoryState(id), "", href);
    },
    [pathname, searchParams],
  );

  const handleDetailOpenChange = useCallback((open: boolean) => {
    setDetailOpen(open);
  }, []);

  const coachOwnsDocument =
    docParam !== null &&
    coachLaunch?.open === true &&
    coachLaunch.documentId === docParam;

  useEffect(() => {
    if (authLoading || !moduleEnabled) return;
    if (docParam === null) {
      handedOffDocumentRef.current = null;
      return;
    }
    if (detailOpen) return;
    if (coachOwnsDocument) {
      // "Ask Coach" intentionally closes the sheet while the drawer owns the
      // same document. Keep the return URL intact so maximize → browser-back
      // can reconstruct the sheet from `?doc=`.
      handedOffDocumentRef.current = docParam;
      return;
    }
    // Read before the call below reassigns the ref: the same inputs the close
    // itself decides on.
    const retainedAsReturnUrl = coachHandoffRetainsSelection(
      docParam,
      handedOffDocumentRef.current,
      coachLaunch?.closeIntent,
    );

    handedOffDocumentRef.current = closeDocumentSelectionAfterCoachHandoff(
      window.history,
      pathname,
      searchParams.toString(),
      docParam,
      handedOffDocumentRef.current,
      coachLaunch?.closeIntent,
    );

    // Nothing was closed: the selection is the way back from `/coach` and is
    // meant to stay. Checking for it here would delete it.
    if (retainedAsReturnUrl) return;

    // Consuming the pushed entry is a REQUEST to the browser, not a guarantee.
    //
    // `history.back()` is queued against the session history, and a traversal
    // asked for while another is still settling can be dropped — closing the
    // sheet immediately after pressing the browser's Forward button is exactly
    // that shape. Nothing raises when it happens: the sheet is closed, React
    // is consistent, and the URL still names the document. A reload or a
    // shared link then re-opens the sheet the reader just closed.
    //
    // So the request is checked rather than trusted. If the selection is still
    // in the address bar shortly afterwards, it is removed the synchronous
    // way. The guard is the document id, so a traversal that landed on some
    // other selection is left alone, and the cleanup below cancels the check
    // the moment the sheet re-opens or the parameter changes — which is what
    // makes re-opening within the window safe.
    const verify = window.setTimeout(() => {
      if (!documentSelectionSurvivedClose(window.location.search, docParam)) {
        return;
      }
      window.history.replaceState(
        null,
        "",
        withoutDocumentSelectionHref(pathname, window.location.search),
      );
    }, CLOSE_TRAVERSAL_GRACE_MS);
    return () => window.clearTimeout(verify);
  }, [
    authLoading,
    coachOwnsDocument,
    coachLaunch?.closeIntent,
    detailOpen,
    docParam,
    moduleEnabled,
    pathname,
    searchParams,
  ]);

  // Hover/focus intent prefetches the detail METADATA (never the blob —
  // the blob fetch starts when the sheet mounts its preview element).
  const prefetchDetail = useCallback(
    (id: string) => {
      void queryClient.prefetchQuery({
        queryKey: queryKeys.inboundDocument(id),
        queryFn: () =>
          apiGet<InboundDocumentDetailDto>(`/api/documents/inbound/${id}`),
        staleTime: 30_000,
      });
    },
    [queryClient],
  );

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
          canManageDocuments ? (
            <Button
              className="min-h-11 sm:min-h-9"
              onClick={() => uploadInputRef.current?.click()}
            >
              <Upload className="size-4" aria-hidden />
              {t("documents.pageUpload")}
            </Button>
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
        years={years}
        activeYear={filters.year}
        onToggleYear={toggleYear}
        activeCount={activeCount}
        onClearAll={clearFilters}
        showIndexAll={showIndexAll}
        indexAllPending={reindexAll.isPending}
        onIndexAll={handleIndexAll}
      />

      {list.isPending ? (
        <div
          data-slot="documents-loading"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {Array.from({ length: 9 }, (_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : list.isError ? (
        <QueryErrorCard
          title={t("documents.list.loadError")}
          onRetry={() => void list.refetch()}
        />
      ) : showEmpty && !isFiltered ? (
        <EmptyState
          icon={<FolderOpen className="size-6" aria-hidden />}
          title={t("documents.empty.title")}
          description={t("documents.empty.description")}
          ctaSize="lg"
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
          documents={documents}
          uploadItems={upload.items}
          onDismissUpload={upload.dismiss}
          hasNextPage={list.hasNextPage}
          isFetchingNextPage={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          selectedIds={selectedIds}
          onToggleSelected={canManageDocuments ? toggleSelected : undefined}
          onOpen={openDetail}
          onDelete={canManageDocuments ? (id) => deleteBulk([id]) : undefined}
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
          onDelete={() => deleteBulk([...selectedIds])}
          onClear={clearSelection}
        />
      ) : null}

      <DocumentShareSheet
        open={bulkShareOpen}
        onOpenChange={setBulkShareOpen}
        documents={bulkShareDocs}
      />

      {/* Page-wide drop overlay — pure decoration (aria-hidden); the intake
          itself announces through the live region below. */}
      {dropActive ? (
        <div
          aria-hidden
          data-slot="document-drop-overlay"
          className="bg-background/80 fixed inset-0 z-50 p-4 backdrop-blur-sm md:p-8"
        >
          <div className="border-primary bg-primary/5 flex h-full items-center justify-center rounded-xl border-2 border-dashed">
            <div className="flex flex-col items-center gap-2 px-4 text-center">
              <UploadCloud className="text-primary size-8" aria-hidden />
              <p className="text-base font-medium">
                {t("documents.dropOverlay.title")}
              </p>
              <p className="text-muted-foreground text-xs">
                {t("documents.dropOverlay.hint")}
              </p>
            </div>
          </div>
        </div>
      ) : null}
      <p aria-live="polite" role="status" className="sr-only">
        {uploadAnnouncement}
      </p>
    </div>
  );
}
