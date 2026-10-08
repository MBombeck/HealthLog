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
  if (width >= 1100) return 4;
  if (width >= 760) return 3;
  if (width >= 330) return 2;
  return 1;
}

/** Gap between tiles and between rows, in px (`gap-4` / `pb-4`). */
const GRID_GAP_PX = 16;

/**
 * First guess at a row's height before the virtualizer measures it: a 4:3
 * preview across the tile's width plus the title and meta lines under it.
 */
export function estimatedRowHeight(width: number, columns: number): number {
  const cols = Math.max(1, columns);
  const tileWidth = Math.max(0, (width - GRID_GAP_PX * (cols - 1)) / cols);
  return Math.round(tileWidth * 0.75) + 96 + GRID_GAP_PX;
}

export function DocumentMonthHeading({ label }: { label: string }) {
  return (
    <h2 className="text-muted-foreground pt-2 pb-3 text-xs font-medium tracking-wide uppercase">
      {label}
    </h2>
  );
}

export function DocumentMonthRow({
  documents,
  columns,
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
  selectedIds: ReadonlySet<string>;
  onToggleSelected?: (id: string, range?: boolean) => void;
  onOpen: (id: string) => void;
  onDelete?: (id: string) => void;
  highlightId: string | null;
  rovingId: string | null;
  onCardFocus: (id: string) => void;
  onPrefetch?: (id: string) => void;
}) {
  return (
    <div
      data-slot="document-month-row"
      className="grid gap-4 pb-4"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {documents.map((doc) => (
        <DocumentCard
          key={doc.id}
          variant="tile"
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
      ))}
    </div>
  );
}
