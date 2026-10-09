"use client";

/**
 * The vault timeline: a virtualized, month-sectioned grid of preview tiles
 * (`document-month-grid.tsx`) windowed
 * with `@tanstack/react-virtual` over the shell's scroll container
 * (`#main-content` — single scroll owner per the design standards; the
 * timeline never brings its own scrollport). The flat item list (month
 * labels + chunked card rows) comes from `buildTimelineItems`, so the
 * mounted DOM stays bounded (< ~400 nodes) regardless of corpus size.
 *
 * Columns are measured, not breakpoint-classed: a ResizeObserver on the
 * grid container drives the per-row chunking (4 / 3 on a desktop, 2 on a
 * phone, 1 on the narrowest screens), which keeps the virtualizer's row model
 * and the painted grid in lockstep.
 *
 * In-flight / failed uploads render as a small non-virtualized grid above
 * the timeline — they are few (client concurrency 3) and must appear
 * < 100 ms after file selection, before any query settles.
 */
import { Loader2 } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { useTranslations } from "@/lib/i18n/context";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";
import { UploadStateCard } from "./document-card";
import {
  DEFAULT_DOCUMENTS_LAYOUT,
  type DocumentsLayoutArrangement,
  type DocumentsLayoutView,
} from "@/lib/documents/documents-layout";
import {
  columnsForWidth,
  DocumentMonthHeading,
  DocumentMonthRow,
  estimatedRowHeight,
  listColumnsForWidth,
} from "./document-month-grid";
import type { UploadQueueItem } from "./use-document-upload";
import {
  buildFlowTimelineItems,
  buildTimelineItems,
  formatMonthLabel,
} from "./vault-utils";

const SCROLL_CONTAINER_ID = "main-content";

export function DocumentTimeline({
  documents,
  uploadItems,
  onDismissUpload,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  selectedIds,
  onToggleSelected,
  onOpen,
  onDelete,
  highlightId,
  onPrefetch,
  timezone,
  view = DEFAULT_DOCUMENTS_LAYOUT.view,
  arrangement = DEFAULT_DOCUMENTS_LAYOUT.arrangement,
}: {
  /** Preview tiles or compact rows (the reader's vault presentation). */
  view?: DocumentsLayoutView;
  /** Months as their own blocks, or one continuous run across the width. */
  arrangement?: DocumentsLayoutArrangement;
  /** The reader's profile zone; an undated document files under its upload day there. */
  timezone: string;
  documents: InboundDocumentDto[];
  uploadItems: UploadQueueItem[];
  onDismissUpload: (localId: string) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  selectedIds: ReadonlySet<string>;
  /** Omitted inside somebody else's record: selection feeds bulk edits. */
  onToggleSelected?: (id: string, range?: boolean) => void;
  onOpen: (id: string) => void;
  /** Delete key on the focused card — the page owns the undo-able delete. */
  onDelete?: (id: string) => void;
  highlightId: string | null;
  onPrefetch?: (id: string) => void;
}) {
  const { t, locale } = useTranslations();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState(1);
  const [gridWidth, setGridWidth] = useState(0);
  const [scrollMargin, setScrollMargin] = useState(0);

  // Roving tabindex over the card grid: exactly one card is tabbable; the
  // arrow keys move the active slot. Falls back to the first document when
  // the remembered card left the corpus (filter change, deletion).
  const [activeId, setActiveId] = useState<string | null>(null);

  const flow = arrangement === "flow";

  // Measured columns — the ResizeObserver drives the row chunking. Tiles
  // share a row on any width; compact rows only in the flowing arrangement,
  // a stacked list stays one column.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const update = () => {
      const width = el.clientWidth;
      setColumns(
        view === "cards"
          ? columnsForWidth(width)
          : flow
            ? listColumnsForWidth(width)
            : 1,
      );
      setGridWidth(width);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [view, flow]);

  const items = useMemo(
    () =>
      flow
        ? buildFlowTimelineItems(documents, columns, timezone)
        : buildTimelineItems(documents, columns, timezone),
    [documents, columns, timezone, flow],
  );
  const formatMonth = (key: string) => formatMonthLabel(key, locale);

  // The timeline does not start at the scrollport's top edge (page header,
  // filter bar, upload row sit above it) — feed the offset to the
  // virtualizer so window positions line up. Re-measured when the content
  // above changes height (upload cards appearing/leaving) and on resize.
  useEffect(() => {
    const scrollEl = document.getElementById(SCROLL_CONTAINER_ID);
    const listEl = listRef.current;
    if (!scrollEl || !listEl) return;
    const measure = () => {
      const margin =
        listEl.getBoundingClientRect().top -
        scrollEl.getBoundingClientRect().top +
        scrollEl.scrollTop;
      setScrollMargin(margin);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [uploadItems.length, columns]);

  // The React Compiler cannot memoize across TanStack Virtual's instance
  // API (library-level opt-out, not a fixable call-site problem) — the
  // windowing still works, the compiler just skips this component.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => document.getElementById(SCROLL_CONTAINER_ID),
    estimateSize: (index) =>
      items[index].type === "month"
        ? 40
        : estimatedRowHeight(gridWidth, columns, view, flow),
    getItemKey: (index) => items[index].key,
    overscan: 6,
    scrollMargin,
  });

  const virtualItems = virtualizer.getVirtualItems();

  // ── Keyboard navigation (roving tabindex) ─────────────────────────────
  // The tabbable slot: the remembered active card, else the first document.
  const rovingId =
    activeId !== null && documents.some((d) => d.id === activeId)
      ? activeId
      : (documents[0]?.id ?? null);

  // Which virtual item (grid row) a document renders in — the arrow-key
  // handler scrolls that row into the window before focusing the card.
  const rowIndexById = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((item, index) => {
      if (item.type !== "row") return;
      for (const doc of item.documents) map.set(doc.id, index);
    });
    return map;
  }, [items]);

  const focusDocument = (id: string) => {
    setActiveId(id);
    const rowIndex = rowIndexById.get(id);
    if (rowIndex !== undefined) {
      virtualizer.scrollToIndex(rowIndex, { align: "auto" });
    }
    // The row may only mount on the next virtualizer paint — retry across
    // a few frames, bounded.
    let attempts = 0;
    const tryFocus = () => {
      const button = listRef.current?.querySelector<HTMLButtonElement>(
        `[data-document-id="${CSS.escape(id)}"] [data-slot="document-open"]`,
      );
      if (button) {
        button.focus();
        return;
      }
      attempts += 1;
      if (attempts < 20) requestAnimationFrame(tryFocus);
    };
    requestAnimationFrame(tryFocus);
  };

  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (documents.length === 0) return;
    const currentIndex = rovingId
      ? documents.findIndex((d) => d.id === rovingId)
      : 0;
    let nextIndex: number | null = null;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = Math.min(documents.length - 1, currentIndex + 1);
        break;
      case "ArrowLeft":
        nextIndex = Math.max(0, currentIndex - 1);
        break;
      case "ArrowDown":
        nextIndex = Math.min(documents.length - 1, currentIndex + columns);
        break;
      case "ArrowUp":
        nextIndex = Math.max(0, currentIndex - columns);
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = documents.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    if (nextIndex !== currentIndex) {
      focusDocument(documents[nextIndex].id);
    }
  };

  // Keyset infinite feed: pull the next page when the window nears the end.
  const lastIndex = virtualItems[virtualItems.length - 1]?.index ?? -1;
  useEffect(() => {
    if (
      hasNextPage &&
      !isFetchingNextPage &&
      lastIndex >= items.length - columns * 3 - 1
    ) {
      onLoadMore();
    }
  }, [
    lastIndex,
    items.length,
    columns,
    hasNextPage,
    isFetchingNextPage,
    onLoadMore,
  ]);

  return (
    <div
      data-slot="document-timeline"
      data-view={view}
      data-arrangement={arrangement}
      className="space-y-4"
    >
      {uploadItems.length > 0 ? (
        <div
          data-slot="document-upload-queue"
          aria-live="polite"
          className="grid gap-4"
          style={{
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          }}
        >
          {uploadItems.map((item) => (
            <UploadStateCard
              key={item.localId}
              item={item}
              onDismiss={onDismissUpload}
            />
          ))}
        </div>
      ) : null}

      {/* List semantics over the virtualized window: the container is one
          list, each windowed item (month label or card row) one list item —
          honest for a windowed structure where per-document posinset would
          lie whenever pages are still loading. Keyboard contract on the
          grid: arrows move the roving slot, Enter opens, Space selects,
          Delete removes (undo-able), documented on the cards. */}
      <div
        ref={listRef}
        role="list"
        aria-label={t("documents.timeline.listLabel")}
        onKeyDown={onGridKeyDown}
      >
        <div
          className="relative"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualItems.map((virtualItem) => {
            const item = items[virtualItem.index];
            return (
              <div
                key={virtualItem.key}
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
                role="listitem"
                className="absolute inset-x-0 top-0"
                style={{
                  transform: `translateY(${
                    virtualItem.start - scrollMargin
                  }px)`,
                }}
              >
                {item.type === "month" ? (
                  <DocumentMonthHeading
                    label={formatMonthLabel(item.key, locale)}
                  />
                ) : (
                  <DocumentMonthRow
                    documents={item.documents}
                    columns={columns}
                    view={view}
                    monthStarts={item.monthStarts}
                    formatMonth={formatMonth}
                    selectedIds={selectedIds}
                    onToggleSelected={onToggleSelected}
                    onOpen={onOpen}
                    onDelete={onDelete}
                    highlightId={highlightId}
                    rovingId={rovingId}
                    onCardFocus={setActiveId}
                    onPrefetch={onPrefetch}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {isFetchingNextPage ? (
        <div
          className="text-muted-foreground flex items-center justify-center gap-2 py-4 text-sm"
          role="status"
        >
          <Loader2
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          {t("documents.timeline.loadingMore")}
        </div>
      ) : null}
    </div>
  );
}
