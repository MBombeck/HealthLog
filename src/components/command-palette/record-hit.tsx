"use client";

import {
  Activity,
  Dumbbell,
  FileText,
  FlaskConical,
  NotebookPen,
  Pill,
  Stethoscope,
  Syringe,
  Thermometer,
  type LucideIcon,
} from "lucide-react";

import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type {
  SearchHit,
  SearchHitKind,
  SearchMarkedText,
} from "@/lib/search/contract";

export const RECORD_HIT_ICON: Record<SearchHitKind, LucideIcon> = {
  visit: Stethoscope,
  condition: Thermometer,
  document: FileText,
  vaccination: Syringe,
  lab: FlaskConical,
  medication: Pill,
  symptom: Activity,
  workout: Dumbbell,
  note: NotebookPen,
};

/**
 * Text with the ranges the query matched set in `<mark>`. Plain React text
 * children only: the ranges are character offsets the server computed, and
 * nothing here is parsed as markup.
 */
export function Marked({ value }: { value: SearchMarkedText }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [start, end] of value.marks) {
    if (start < at || end > value.text.length || end <= start) continue;
    if (start > at) parts.push(value.text.slice(at, start));
    parts.push(
      <mark
        key={start}
        className="bg-primary/15 text-foreground rounded-[2px] font-medium"
      >
        {value.text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < value.text.length) parts.push(value.text.slice(at));
  return <>{parts}</>;
}

/** What a hit is called when its record has no name of its own. */
export function useRecordHitLabel(): (hit: SearchHit) => string {
  const { t } = useTranslations();
  return (hit) =>
    hit.source
      ? t(`palette.records.source.${hit.source}`)
      : t(`palette.records.kind.${hit.kind}`);
}

/** The body of one record option: title, kind and date, context, snippet. */
export function RecordHitContent({ hit }: { hit: SearchHit }) {
  const fmt = useFormatters();
  const label = useRecordHitLabel()(hit);
  const Icon = RECORD_HIT_ICON[hit.kind];
  return (
    <>
      <Icon
        className="text-muted-foreground mt-0.5 size-4 shrink-0 self-start"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block truncate">
          {hit.title ? <Marked value={hit.title} /> : label}
        </span>
        <span className="block truncate text-xs">
          {/* Muted reads too faint on the highlighted row's accent fill, so
              the highlighted option sets it in the accent's own ink. */}
          <span className="text-muted-foreground group-aria-selected:text-accent-foreground">
            {hit.title ? label : null}
            {hit.title && hit.day ? ", " : null}
            {hit.day ? fmt.dateShortSmartCalendar(hit.day) : null}
          </span>
          {hit.context.map((part, i) => (
            <span key={i}>
              {hit.title || hit.day || i > 0 ? ", " : null}
              <Marked value={part} />
            </span>
          ))}
        </span>
        {hit.snippet ? (
          <span className="line-clamp-2 block text-xs break-words">
            <Marked value={hit.snippet} />
          </span>
        ) : null}
      </span>
    </>
  );
}
