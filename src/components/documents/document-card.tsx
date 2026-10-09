"use client";

/**
 * One document in the vault timeline (compact-density Card) plus the two
 * transient upload-state cards (in-flight with a live progress ring, failed
 * with the translated §3.2 reason). All three share the card footprint so an
 * optimistic entry morphs into the stored row without the grid jumping.
 *
 * Anatomy per the design standards: a leading edge that shows a small preview
 * thumbnail tile when one has been rendered (`hasThumbnail`) and otherwise the
 * kind icon `text-foreground size-5`, title in foreground (`text-sm
 * font-medium`, truncated), a muted meta line (date · size) with the real
 * filename on its own muted line below (full name on hover via `title`),
 * condition-tag pills, an attachment-class badge for download-only formats,
 * and a selection checkbox that appears on hover / focus / while selected. The
 * whole card is clickable through an invisible overlay button; the checkbox
 * floats above it.
 */
import { DayLinkStated } from "@/components/day/day-link";
import { useDocumentDate } from "@/components/documents/use-document-date";
import { Check, Download, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { useFencedObjectUrl } from "@/hooks/use-fenced-object-url";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";
import { DOCUMENT_KIND_ICONS } from "./document-kind-meta";
import type { UploadQueueItem } from "./use-document-upload";
import {
  documentCardKeyAction,
  formatBytes,
  isDocumentProcessing,
} from "./vault-utils";

/** How long the "Ready" chip stays up after a card's index lands. */
const READY_FLASH_MS = 3000;

/** Press-and-hold duration that flips a touch press into "select" mode. */
const LONG_PRESS_MS = 500;

export function DocumentCard({
  document,
  selected,
  onToggleSelected,
  onOpen,
  onDelete,
  highlighted,
  tabIndex = 0,
  onCardFocus,
  onPrefetch,
  variant = "row",
}: {
  /**
   * `row` (default): the compact card with the preview at its leading edge.
   * `tile`: the archive grid's tile, the preview filling the top of the card
   * so a page is recognisable before its title is read.
   */
  variant?: "row" | "tile";
  document: InboundDocumentDto;
  selected: boolean;
  /** `range` = extend the selection from the last anchor (shift-click). */
  /** Omitted inside somebody else's record: selection feeds bulk edits. */
  onToggleSelected?: (id: string, range?: boolean) => void;
  onOpen: (id: string) => void;
  /** Delete key on the focused card — undo-able delete owned by the page. */
  onDelete?: (id: string) => void;
  /** Brief ring after a duplicate upload resolved to this existing row. */
  highlighted: boolean;
  /** Roving-tabindex slot from the timeline (0 = the one tabbable card). */
  tabIndex?: number;
  /** The open-button gained focus (keyboard/roving bookkeeping). */
  onCardFocus?: (id: string) => void;
  /** Hover/focus intent — prefetches the detail metadata (never the blob). */
  onPrefetch?: (id: string) => void;
}) {
  const { t, locale } = useTranslations();
  const documentDate = useDocumentDate();

  // A preview thumbnail that fails to load (still rendering, decrypt error,
  // 404) falls back to the kind icon — never a broken image.
  const [thumbFailed, setThumbFailed] = useState(false);
  // v1.37.0 — fetched through the app transport rather than issued by the
  // browser as a subresource, so it carries the record-session assertion. The
  // null path means "this card has no thumbnail, or one already failed", which
  // is what keeps the timeline from firing a request per card for documents
  // that have nothing to show.
  const { url: thumbnailUrl, failed: thumbnailFailed } = useFencedObjectUrl(
    document.hasThumbnail && !thumbFailed
      ? `/api/documents/inbound/${document.id}/thumbnail`
      : null,
  );

  // Touch long-press selects instead of opening; the click that the
  // browser fires after the release is swallowed once.
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const title =
    document.title ?? document.filename ?? t("documents.card.untitled");
  const Icon = DOCUMENT_KIND_ICONS[document.kind];
  const date = documentDate(document);
  const size = formatBytes(document.byteSize, locale);
  const showFilename =
    document.filename !== null && document.filename !== title;

  // v1.29.x — processing/ready feedback for the fire-and-forget auto-index
  // (+ optional AI summary) job that starts right after upload. `processing`
  // is derived straight from the DTO (bounded to the recent-upload window, so
  // an old/never-indexed document never shows a stuck spinner). `justIndexed`
  // is local: it flashes once when a card that WAS processing on this page
  // transitions to indexed (the poll in `documents-view.tsx` is what drives
  // the transition), then clears on its own — a one-time "it landed" cue,
  // not a permanent tint.
  const processing = isDocumentProcessing(document);
  const wasProcessingRef = useRef(processing);
  const [justIndexed, setJustIndexed] = useState(false);
  useEffect(() => {
    if (wasProcessingRef.current && !processing) {
      setJustIndexed(true);
      const timer = setTimeout(() => setJustIndexed(false), READY_FLASH_MS);
      wasProcessingRef.current = processing;
      return () => clearTimeout(timer);
    }
    wasProcessingRef.current = processing;
  }, [processing]);

  const tile = variant === "tile";
  const showThumbnail = !!thumbnailUrl && !thumbnailFailed;
  // An object URL over bytes the app transport already fetched, not a
  // `/api/…` subresource: the browser issues a subresource itself and so
  // cannot carry the record-session assertion, which the fence refuses on any
  // session that has been inside a shared record. `next/image` is wrong here
  // for the older reason too — it would proxy a PHI blob we deliberately
  // never cache. Decorative (alt="") — the title beside it names the
  // document. The laziness that `loading="lazy"` used to provide now lives in
  // the hook's null path: a card with no thumbnail, or one whose thumbnail
  // already failed, issues no request at all. onError falls back to the kind
  // icon.
  const thumbnail = showThumbnail ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={thumbnailUrl}
      alt=""
      decoding="async"
      onError={() => setThumbFailed(true)}
      className={cn("size-full object-cover", tile && "object-top")}
    />
  ) : null;

  const selection = onToggleSelected ? (
    <Checkbox
      checked={selected}
      // Explicit click handling instead of onCheckedChange: the mouse
      // event carries `shiftKey` for file-manager range selection.
      // preventDefault stops Radix's internal toggle (state is fully
      // controlled by the page's selection set anyway).
      onClick={(e) => {
        e.preventDefault();
        onToggleSelected(document.id, e.shiftKey);
      }}
      aria-label={t("documents.card.selectLabel", { title })}
      className={cn(
        "relative z-10 shrink-0 transition-opacity",
        "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
        selected && "opacity-100",
        // On a tile the box floats over the preview, which can be any
        // colour; the card background behind it keeps it readable.
        tile && "bg-background absolute top-4 right-4",
      )}
    />
  ) : null;

  const titleBlock = (
    <div className="flex min-w-0 flex-1 flex-col">
      <p className="truncate text-sm font-medium">{title}</p>
      <p className="text-muted-foreground truncate text-xs">
        {/* v1.42 — a dated document's date opens its day, above the
            whole-card button. It follows the grid's roving tab stop, so the
            card that holds the keyboard offers its day next. */}
        {document.documentDate ? (
          <DayLinkStated
            at={document.documentDate}
            tabIndex={tabIndex}
            className="z-10"
          >
            {date}
          </DayLinkStated>
        ) : (
          date
        )}
        , {size}
      </p>
      {showFilename ? (
        // Filename on its OWN muted line so it never clips the date/size
        // meta; the full name stays reachable on hover via `title`.
        <p
          data-slot="document-card-filename"
          className="text-muted-foreground truncate text-xs"
          title={document.filename ?? undefined}
        >
          {document.filename}
        </p>
      ) : null}
    </div>
  );

  return (
    <Card
      data-slot="document-card"
      data-variant={variant}
      data-document-id={document.id}
      className={cn(
        "group relative h-full gap-2 py-3 transition-shadow md:py-4",
        "hover:shadow-sm",
        highlighted && "ring-primary ring-2",
      )}
    >
      <CardContent
        className={cn(
          "flex h-full flex-col gap-2",
          // A dense tile (UI standards §1): two or more of them sit side by
          // side on a phone, where the default inset would eat the preview.
          tile ? "px-3" : "px-4",
        )}
      >
        {tile ? (
          <>
            <span
              data-slot="document-preview"
              className="bg-muted flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-lg"
            >
              {thumbnail ?? (
                <Icon className="text-foreground size-8" aria-hidden />
              )}
            </span>
            {titleBlock}
            {selection}
          </>
        ) : (
          <div className="flex items-start gap-2">
            {thumbnail ? (
              // Leading-edge preview tile.
              <span
                data-slot="document-thumbnail"
                className="bg-muted mt-0.5 block size-12 shrink-0 overflow-hidden rounded-md"
              >
                {thumbnail}
              </span>
            ) : (
              <Icon
                className="text-foreground mt-0.5 size-5 shrink-0"
                aria-hidden
              />
            )}
            {titleBlock}
            {selection}
          </div>
        )}
        {document.conditionLinks.length > 0 ||
        document.servingClass === "attachment" ||
        processing ||
        justIndexed ? (
          <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
            {document.conditionLinks.map((link) => (
              <span
                key={link.episodeId}
                className="bg-muted text-foreground inline-flex max-w-40 items-center rounded-full px-2 py-0.5 text-xs"
              >
                <span className="truncate">{link.name}</span>
              </span>
            ))}
            {document.servingClass === "attachment" ? (
              <Badge
                variant="outline"
                className="text-muted-foreground gap-1 text-xs font-normal"
              >
                <Download className="size-3" aria-hidden />
                {t("documents.card.attachmentBadge")}
              </Badge>
            ) : null}
            {processing ? (
              <Badge
                variant="outline"
                data-slot="document-processing-badge"
                className="text-muted-foreground gap-1 text-xs font-normal"
              >
                <Loader2
                  className="size-3 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
                {t("documents.card.processing")}
              </Badge>
            ) : justIndexed ? (
              <Badge
                variant="outline"
                data-slot="document-ready-badge"
                className="text-success gap-1 text-xs font-normal"
              >
                <Check className="size-3" aria-hidden />
                {t("documents.card.ready")}
              </Badge>
            ) : null}
          </div>
        ) : null}
      </CardContent>
      {/* Whole-card click target. Painted last so it sits above the content
          (the checkbox stays reachable via its own z-10). Keyboard contract
          (roving tabindex owned by the timeline): Enter opens (native
          click), Space toggles selection, Delete removes with undo. Touch:
          press-and-hold selects instead of opening.

          Backspace is deliberately NOT a delete key here. It is the reflex
          "go back" key, the roving tabindex hands a card focus the moment
          someone tabs into the grid, and a card carries no other delete
          control — so the reflex press destroyed a medical document with
          nothing but a transient undo toast to catch it. Delete alone,
          announced through `aria-keyshortcuts` and shown as a `<kbd>` chip
          while the card holds focus. */}
      <button
        type="button"
        data-slot="document-open"
        tabIndex={tabIndex}
        onClick={() => {
          if (longPressFired.current) {
            longPressFired.current = false;
            return;
          }
          onOpen(document.id);
        }}
        onKeyDown={(e) => {
          const action = documentCardKeyAction(e.key);
          if (action === "select") {
            e.preventDefault();
            onToggleSelected?.(document.id, e.shiftKey);
          } else if (action === "delete") {
            e.preventDefault();
            onDelete?.(document.id);
          }
        }}
        onTouchStart={() => {
          longPressFired.current = false;
          cancelLongPress();
          longPressTimer.current = setTimeout(() => {
            longPressFired.current = true;
            onToggleSelected?.(document.id);
          }, LONG_PRESS_MS);
        }}
        onTouchMove={cancelLongPress}
        onTouchEnd={cancelLongPress}
        onTouchCancel={cancelLongPress}
        onMouseEnter={() => onPrefetch?.(document.id)}
        onFocus={() => {
          onCardFocus?.(document.id);
          onPrefetch?.(document.id);
        }}
        aria-label={t("documents.card.openLabel", { title })}
        aria-keyshortcuts={onDelete ? "Delete" : undefined}
        className="focus-visible:ring-ring/50 absolute inset-0 rounded-xl focus-visible:ring-[3px] focus-visible:outline-none"
      />
      {/* The only visible affordance for deleting a single card. Shown while
          the card holds focus (same `group-focus-within` trigger the checkbox
          uses) and hidden from the accessibility tree, because
          `aria-keyshortcuts` on the overlay button already announces the same
          key. `pointer-events-none` keeps it out of the click target.

          Full `text-foreground`, not `text-muted-foreground`: the muted token
          on this card's background measures 4.06:1, under the 4.5:1 floor, and
          axe fails the vault on it. A key hint is the one piece of meta text
          that has to be readable at a glance, so the usual muted-for-meta rule
          gives way here rather than the contrast one. */}
      {onDelete ? (
        <kbd
          aria-hidden
          data-slot="document-delete-hint"
          className="border-border bg-background text-foreground pointer-events-none absolute right-2 bottom-2 hidden rounded border px-1.5 font-mono text-xs opacity-0 transition-opacity group-focus-within:opacity-100 sm:inline-block"
        >
          {t("documents.card.deleteKey")}
        </kbd>
      ) : null}
    </Card>
  );
}

/** SVG progress ring for the in-flight upload card (0..1). */
function ProgressRing({ fraction }: { fraction: number }) {
  const clamped = Math.min(1, Math.max(0, fraction));
  const r = 13;
  const circumference = 2 * Math.PI * r;
  return (
    <svg
      viewBox="0 0 32 32"
      className="size-8 shrink-0 -rotate-90"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
    >
      <circle
        cx="16"
        cy="16"
        r={r}
        fill="none"
        strokeWidth="3"
        className="stroke-muted"
      />
      <circle
        cx="16"
        cy="16"
        r={r}
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        className="stroke-primary transition-[stroke-dashoffset] duration-200"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped)}
      />
    </svg>
  );
}

/**
 * Transient card for a queue entry: uploading (progress ring) or failed
 * (translated reason + dismiss). Shares the DocumentCard footprint.
 */
export function UploadStateCard({
  item,
  onDismiss,
}: {
  item: UploadQueueItem;
  onDismiss: (localId: string) => void;
}) {
  const { t, locale } = useTranslations();

  const failure = item.failure;
  let failureCopy: string | null = null;
  if (failure) {
    switch (failure.reason) {
      case "fileTooLarge":
        failureCopy = t("documents.error.fileTooLarge", {
          maxSize: formatBytes(failure.maxFileBytes ?? 0, locale),
        });
        break;
      case "quotaExceeded":
        failureCopy = t("documents.error.quotaExceeded", {
          used: formatBytes(failure.usedBytes ?? 0, locale),
          quota: formatBytes(failure.quotaBytes ?? 0, locale),
        });
        break;
      case "unsupportedType":
        failureCopy = t("documents.error.unsupportedType");
        break;
      case "purged":
        failureCopy = t("documents.error.purged");
        break;
      case "duplicateExists":
        failureCopy = t("documents.error.duplicateExists");
        break;
      case "rateLimited":
        failureCopy = t("documents.error.rateLimited");
        break;
      default:
        failureCopy = t("documents.error.generic");
    }
  }

  return (
    <Card
      data-slot="document-upload-card"
      className={cn(
        "h-full gap-2 border-dashed py-3 md:py-4",
        item.status === "error" && "border-destructive/50",
      )}
    >
      <CardContent className="flex h-full flex-col gap-2 px-4">
        <div className="flex items-center gap-3">
          {item.status === "uploading" ? (
            <ProgressRing fraction={item.progress} />
          ) : null}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{item.fileName}</p>
            <p className="text-muted-foreground text-xs">
              {item.status === "uploading"
                ? t("documents.card.uploading")
                : formatBytes(item.byteSize, locale)}
            </p>
          </div>
          {item.status === "error" ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={() => onDismiss(item.localId)}
              aria-label={t("documents.card.dismissFailed")}
            >
              <X className="size-4" aria-hidden />
            </Button>
          ) : null}
        </div>
        {failureCopy ? (
          <p role="alert" className="text-destructive text-xs">
            {failureCopy}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
