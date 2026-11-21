"use client";

/**
 * One mood entry as a desktop table row and as a mobile card, with the note
 * preview and source label both share.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Pencil } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TableCell, TableRow } from "@/components/ui/table";
import { DeleteButton } from "@/components/data-list";
import { DayLink } from "@/components/day/day-link";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { MOOD_LABEL_KEYS } from "@/lib/mood/labels";
import type { MoodContextWire } from "@/lib/mood/context";
import type { RatedFactor } from "./mood-tag-picker";
import { InlineAction } from "@/components/ui/inline-action";

export interface MoodEntry {
  id: string;
  date: string;
  mood: string;
  score: number;
  tags: string[];
  // Structured-tag keys + free-text note.
  tagKeys: string[];
  ratedFactors: RatedFactor[];
  // The five level-A values, absent on entries written before them.
  a1?: number | null;
  a2?: number | null;
  a3?: number | null;
  a4?: number | null;
  a5?: number | null;
  note: string | null;
  // The day context, null on entries that carry none.
  context: MoodContextWire | null;
  /**
   * The IANA zone this entry's `date` is anchored to, or null on a legacy row.
   * Read by the linked-day block so an entry logged in another country is
   * looked up under ITS day rather than under the corrector's.
   */
  tz: string | null;
  source: string;
  moodLoggedAt: string;
}

interface MoodRowProps {
  entry: MoodEntry;
  isSelected: boolean;
  canManage: boolean;
  noteExpanded: boolean;
  onToggleNote: () => void;
  onToggleRow: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function MoodTableRow({
  entry,
  isSelected,
  canManage: canManageMind,
  noteExpanded,
  onToggleNote,
  onToggleRow,
  onEdit,
  onDelete,
}: MoodRowProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  return (
    <TableRow
      data-state={isSelected ? "selected" : undefined}
      data-mood-entry-id={entry.id}
    >
      <TableCell className="pl-4">
        {canManageMind && (
          <Checkbox
            checked={isSelected}
            onCheckedChange={onToggleRow}
            aria-label={t("dataList.selectRow")}
          />
        )}
      </TableCell>
      <TableCell className="font-semibold tabular-nums">
        {entry.score}{" "}
        <span className="text-muted-foreground font-normal">
          (
          {MOOD_LABEL_KEYS[entry.mood]
            ? t(MOOD_LABEL_KEYS[entry.mood])
            : entry.mood}
          )
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground max-w-[18rem] text-sm">
        <span className="block break-words">
          {entry.tags.length > 0 ? entry.tags.join(", ") : "-"}
        </span>
        {entry.note && (
          <MoodNoteText
            note={entry.note}
            expanded={noteExpanded}
            onToggle={onToggleNote}
          />
        )}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {/* The entry's own day (its `date`, cut
          in the zone it was logged in) opens the day. */}
        <DayLink date={entry.date.slice(0, 10)}>
          {fmt.dateTime(entry.moodLoggedAt)}
        </DayLink>
      </TableCell>
      <TableCell>
        {entry.source !== "MANUAL" && (
          <Badge variant="outline" className="text-xs">
            {formatMoodSource(entry.source, t)}
          </Badge>
        )}
      </TableCell>
      <TableCell className="pr-4 text-right">
        <div className="flex items-center justify-end gap-1">
          {canManageMind && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onEdit}
              aria-label={t("common.edit")}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          <DeleteButton
            domain="mind"
            onConfirm={onDelete}
            title={t("mood.deleteConfirmTitle")}
            description={t("mood.deleteConfirmDescription")}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}

export function MoodCardRow({
  entry,
  isSelected,
  canManage: canManageMind,
  noteExpanded,
  onToggleNote,
  onToggleRow,
  onEdit,
  onDelete,
}: MoodRowProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  return (
    <div
      data-testid="mood-row"
      data-mood-entry-id={entry.id}
      data-state={isSelected ? "selected" : undefined}
      className="bg-card border-border data-[state=selected]:border-primary/60 data-[state=selected]:bg-primary/5 flex items-center justify-between rounded-lg border p-3"
    >
      <div className="flex items-center gap-2 overflow-hidden">
        {/* The 16px Checkbox is itself a `<button role=checkbox>`, so
          its 44px wrapper is a plain `<div>` (a button may not nest in a
          button, and React fails hydration on it); the Checkbox owns the
          44px hit area through an `after` hit-slop. */}
        {canManageMind && (
          <div className="flex size-11 shrink-0 items-center justify-center">
            <Checkbox
              checked={isSelected}
              onCheckedChange={onToggleRow}
              aria-label={t("dataList.selectRow")}
              className="relative after:absolute after:-inset-3.5"
            />
          </div>
        )}
        <div className="bg-muted flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
          <span
            data-testid="mood-row-score"
            className="text-lg font-bold tabular-nums"
          >
            {entry.score}
          </span>
        </div>
        <div className="min-w-0">
          <span className="text-sm font-semibold">
            {MOOD_LABEL_KEYS[entry.mood]
              ? t(MOOD_LABEL_KEYS[entry.mood])
              : entry.mood}
          </span>
          <p className="text-muted-foreground truncate text-xs">
            <DayLink date={entry.date.slice(0, 10)}>
              {fmt.dateTime(entry.moodLoggedAt)}
            </DayLink>
          </p>
          {entry.tags.length > 0 && (
            <p className="text-muted-foreground text-xs break-words">
              {entry.tags.join(", ")}
            </p>
          )}
          {entry.note && (
            <MoodNoteText
              note={entry.note}
              expanded={noteExpanded}
              onToggle={onToggleNote}
            />
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {/* Phase A5 mobile audit: bumped from h-8 w-8 (32px)
          to min-h-11 min-w-11 (44px) so the per-row edit
          and delete actions meet WCAG 2.5.5 on touch
          devices. The desktop table keeps its denser
          h-8 w-8 since pointer targets allow it. */}
        {canManageMind && (
          <Button
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11"
            onClick={onEdit}
            aria-label={t("common.edit")}
          >
            <Pencil className="h-4 w-4" />
          </Button>
        )}
        <DeleteButton
          domain="mind"
          onConfirm={onDelete}
          iconClassName="h-4 w-4"
          title={t("mood.deleteConfirmTitle")}
          description={t("mood.deleteConfirmDescription")}
        />
      </div>
    </div>
  );
}
/**
 * An expandable free-text note. Collapsed: a two-line clamped
 * preview. Expanded: the COMPLETE text, line breaks preserved, rendered as
 * plain text children. The full note is readable in place — previously the
 * only full-text surface was the edit sheet (plus a hover tooltip on
 * desktop, unreachable on touch).
 *
 * Structure: the note is a plain paragraph with an `id`; the toggle is a
 * SMALL sibling button carrying `aria-expanded` + `aria-controls`. The
 * earlier cut wrapped the whole paragraph in the button, which made the
 * entire note text the button's accessible name and put block content
 * inside a button (invalid content model).
 *
 * The toggle only renders when the collapsed paragraph actually
 * overflows its two-line clamp (`scrollHeight > clientHeight`, re-checked
 * on resize) — a one-line note gets no dangling "show more" control.
 */
export function MoodNoteText({
  note,
  expanded,
  onToggle,
}: {
  note: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslations();
  const noteId = useId();
  const paragraphRef = useRef<HTMLParagraphElement | null>(null);
  const [clamped, setClamped] = useState(false);

  const updateClamped = useCallback(() => {
    const el = paragraphRef.current;
    if (!el) return;
    // +1 tolerates sub-pixel rounding on fractional zoom levels.
    setClamped(el.scrollHeight > el.clientHeight + 1);
  }, []);

  useEffect(() => {
    // Only the collapsed paragraph carries the clamp; measuring the
    // expanded one would always read "fits" and drop the collapse
    // affordance while it is needed most.
    if (expanded) return;
    updateClamped();
    const el = paragraphRef.current;
    if (!el) return;
    const observer = new ResizeObserver(updateClamped);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, note, updateClamped]);

  return (
    <div className="mt-0.5 min-w-0">
      <p
        id={noteId}
        ref={paragraphRef}
        data-testid="mood-note-text"
        className={
          // User-authored content renders in foreground — user data is never
          // muted (the row's timestamp stays muted); italic keeps the note
          // visually distinct from app copy.
          expanded
            ? "text-foreground text-sm break-words whitespace-pre-wrap italic"
            : "text-foreground line-clamp-2 text-sm italic"
        }
      >
        {note}
      </p>
      {(expanded || clamped) && (
        <InlineAction
          className="font-medium"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={noteId}
          data-testid="mood-note-toggle"
        >
          {expanded ? t("mood.noteCollapse") : t("mood.noteExpand")}
        </InlineAction>
      )}
    </div>
  );
}

/**
 * A `MoodEntry.source` value with its localized label. MANUAL shows in the
 * source filter only (a manual row carries no badge in the table).
 */
export function formatMoodSource(
  source: string,
  t: ReturnType<typeof useTranslations>["t"],
): string {
  switch (source) {
    case "MANUAL":
      return t("mood.sourceManual");
    case "MOODLOG":
      return t("mood.sourceMoodlog");
    case "WEB":
      return t("mood.sourceWeb");
    case "TELEGRAM":
      return t("mood.sourceTelegram");
    case "DAYLIO":
      return t("mood.sourceDaylio");
    case "NOTIFICATION":
      return t("mood.sourceNotification");
    case "APPLE_HEALTH":
      return t("mood.sourceAppleHealth");
    default:
      return source;
  }
}
