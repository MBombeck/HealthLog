"use client";

import { StickyNote } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

export interface MedicationNoteProps {
  /** The person's own note; null or empty renders nothing. */
  note: string | null | undefined;
  /** `data-slot` of the rendered note, for tests and e2e. */
  slot: string;
  /** Cut to two lines, the full text on hover (cards). */
  clamp?: boolean;
  /** Lead with a muted note glyph (the detail header). */
  icon?: boolean;
  className?: string;
}

/**
 * #1371 — the medication's own note ("30 to 60 minutes before food"), in the
 * one presentation every surface shares: the person's words in foreground
 * text (user data is never muted), the line breaks they typed kept, and a
 * screen-reader label in front. A `span` so it can sit inside a list row as
 * well as a block.
 */
export function MedicationNote({
  note,
  slot,
  clamp = false,
  icon = false,
  className,
}: MedicationNoteProps) {
  const { t } = useTranslations();
  if (!note) return null;
  return (
    <span
      data-slot={slot}
      title={clamp ? note : undefined}
      className={cn(
        "text-sm break-words",
        icon ? "flex items-start gap-2" : "block",
        clamp ? "line-clamp-2" : "whitespace-pre-line",
        className,
      )}
    >
      {icon && (
        <StickyNote
          className="text-muted-foreground mt-0.5 size-4 shrink-0"
          aria-hidden="true"
        />
      )}
      <span className="sr-only">{t("medications.note.label")}: </span>
      {icon ? <span className="min-w-0">{note}</span> : note}
    </span>
  );
}
