"use client";

/**
 * The archive's month grid: a month heading, then that month's documents as
 * preview tiles, so a page is recognisable by its look before its title is
 * read. The timeline owns windowing and keyboard focus; this module owns how
 * one windowed item is laid out and how many tiles share a row.
 *
 * Two tiles side by side on a phone (one on the narrowest screens), three or
 * four on a desktop. The count comes from the grid's measured width, not from
 * viewport breakpoints, so the virtualizer's row model and the painted grid
 * can never disagree.
 */
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";
import { DocumentCard } from "./document-card";

/** Measured grid width → tiles per row. */
export function columnsForWidth(width: number): number {
  if (width >= 1000) return 4;
  if (width >= 760) return 3;
  if (width >= 330) return 2;
  return 1;
}

/**
 * Measured width → compact rows side by side in the list view. Stacked, the
 * list is one column; flowing, it fills the width the way the tiles do, with
 * wider cells because a row carries its title beside the preview.
 */
export function listColumnsForWidth(width: number): number {
  if (width >= 1100) return 3;
  if (width >= 700) return 2;
  return 1;
}

/** Height the flowing arrangement reserves above each row for month names. */
export const FLOW_MONTH_LABEL_PX = 24;

/** Gap between tiles and between rows, in px (`gap-4` / `pb-4`). */
const GRID_GAP_PX = 16;

/**
 * First guess at a row's height before the virtualizer measures it: a 4:3
 * preview across the tile's width plus the title and meta lines under it.
 */
export function estimatedRowHeight(
  width: number,
  columns: number,
  view: "cards" | "list" = "cards",
  flow = false,
): number {
  const extra = flow ? FLOW_MONTH_LABEL_PX - GRID_GAP_PX : 0;
  if (view === "list") return 84 + GRID_GAP_PX + extra;
  const cols = Math.max(1, columns);
  const tileWidth = Math.max(0, (width - GRID_GAP_PX * (cols - 1)) / cols);
  return Math.round(tileWidth * 0.75) + 96 + GRID_GAP_PX + extra;
}

export function DocumentMonthHeading({ label }: { label: string }) {
  return (
    <h2 className="text-muted-foreground pt-2 pb-3 text-xs font-medium tracking-wide uppercase">
      {label}
    </h2>
  );
}

/**
 * The flowing arrangement's month marker: the month's name and a hairline
 * that runs to the edge of its cell, sitting in the space above the first
 * document of that month. It marks where a month begins without taking a row
 * of its own, so the documents keep running across the width.
 */
function FlowMonthMarker({ label }: { label: string }) {
  return (
    <div
      data-slot="document-flow-month"
      className="absolute inset-x-0 -top-6 flex h-6 items-center gap-2"
    >
      <span className="text-muted-foreground min-w-0 truncate text-xs font-medium tracking-wide uppercase">
        {label}
      </span>
      <span aria-hidden className="bg-border h-px flex-1" />
    </div>
  );
}

export function DocumentMonthRow({
  documents,
  columns,
  view = "cards",
  monthStarts,
  formatMonth,
  selectedIds,
  onToggleSelected,
  onOpen,
  onDelete,
  highlightId,
  rovingId,
  onCardFocus,
  onPrefetch,
}: {
  documents: InboundDocumentDto[];
  columns: number;
  /** `cards` = preview tiles, `list` = compact rows. */
  view?: "cards" | "list";
  /** Flowing arrangement: documents that open a month → that month's key. */
  monthStarts?: Record<string, string>;
  /** YYYY-MM → the reader's month label; needed with `monthStarts`. */
  formatMonth?: (key: string) => string;
  selectedIds: ReadonlySet<string>;
  onToggleSelected?: (id: string, range?: boolean) => void;
  onOpen: (id: string) => void;
  onDelete?: (id: string) => void;
  highlightId: string | null;
  rovingId: string | null;
  onCardFocus: (id: string) => void;
  onPrefetch?: (id: string) => void;
}) {
  const flow = monthStarts !== undefined;
  return (
    <div
      data-slot="document-month-row"
      className={flow ? "grid gap-4 pt-6" : "grid gap-4 pb-4"}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {documents.map((doc) => {
        const monthKey = monthStarts?.[doc.id];
        const card = (
          <DocumentCard
            key={doc.id}
            variant={view === "list" ? "row" : "tile"}
            document={doc}
            selected={selectedIds.has(doc.id)}
            onToggleSelected={onToggleSelected}
            onOpen={onOpen}
            onDelete={onDelete}
            highlighted={highlightId === doc.id}
            tabIndex={rovingId === doc.id ? 0 : -1}
            onCardFocus={onCardFocus}
            onPrefetch={onPrefetch}
          />
        );
        if (!flow) return card;
        return (
          <div key={doc.id} className="relative min-w-0">
            {monthKey ? (
              <FlowMonthMarker label={formatMonth?.(monthKey) ?? monthKey} />
            ) : null}
            {card}
          </div>
        );
      })}
    </div>
  );
}
