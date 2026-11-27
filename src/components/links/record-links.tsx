"use client";

/**
 * "Verknüpfungen": the one row every record uses to show what it is filed
 * against, and the one way to add to it.
 *
 * Before this row a document carried a block per link family (its
 * conditions, its visit, its doses, then a "related" list for the rest), and
 * each block wrote a line of its own when it was empty ("not linked to any
 * condition", "no vaccinations recorded yet"). A visit, a lab reading, a
 * condition and a medication each had their own arrangement of the same
 * thing. Here every link is a chip, whatever its kind; a chip opens the
 * record; a row with no chips and nothing to add renders nothing at all, so
 * an absence never takes a line.
 *
 * Adding is one button. With one family to pick from it opens that family's
 * picker; with several it asks which first. The pickers themselves are the
 * caller's (`EntityLinkPicker` with `sheetOnly`), because each family reads
 * its options from its own list route. Unlinking happens in the same picker,
 * by unticking: the chip itself only ever opens.
 */
import { useId, type ReactNode } from "react";
import Link from "next/link";
import {
  Activity,
  CalendarDays,
  FlaskConical,
  FolderOpen,
  Pill,
  Plus,
  Syringe,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ENCOUNTER_KINDS,
  encounterKindText,
} from "@/components/encounters/encounter-labels";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { translateOrNull } from "@/lib/i18n/translate-code";
import { cn } from "@/lib/utils";
import type { EncounterKind } from "@/generated/prisma/client";
import type { RelatedLink } from "@/lib/links/related";

export type RecordLinkKind = RelatedLink["kind"];

type Translate = ReturnType<typeof useTranslations>["t"];

export const RECORD_LINK_ICONS: Record<RecordLinkKind, LucideIcon> = {
  labResult: FlaskConical,
  encounter: CalendarDays,
  document: FolderOpen,
  conditionEpisode: Activity,
  medication: Pill,
  vaccination: Syringe,
};

/** The kind's name, singular. Literal calls, so the i18n guard sees each. */
export function recordLinkKindText(t: Translate, kind: RecordLinkKind): string {
  switch (kind) {
    case "labResult":
      return t("links.related.kind.labResult");
    case "encounter":
      return t("links.related.kind.encounter");
    case "document":
      return t("links.related.kind.document");
    case "conditionEpisode":
      return t("links.related.kind.conditionEpisode");
    case "medication":
      return t("links.related.kind.medication");
    case "vaccination":
      return t("links.related.kind.vaccination");
  }
}

function viaText(t: Translate, via: RelatedLink["via"]): string | null {
  if (via === "encounter") return t("links.related.via.encounter");
  if (via === "efficacyTarget") return t("links.related.via.efficacyTarget");
  return null;
}

/**
 * A related record's name. A visit without a reason or a practitioner is
 * labelled by its kind, sent as the enum constant so each reader names it
 * from their own bundle; a dose without a written name arrives as its
 * catalogue slug ("tetanus"), named the way the dose picker names it.
 */
export function relatedRowLabel(t: Translate, row: RelatedLink): string {
  if (
    row.kind === "encounter" &&
    (ENCOUNTER_KINDS as string[]).includes(row.label)
  ) {
    return encounterKindText(t, row.label as EncounterKind);
  }
  if (row.kind === "vaccination" && /^[a-z0-9_-]+$/.test(row.label)) {
    const name = translateOrNull(t, `vaccinations.catalog.${row.label}`);
    if (name !== null) return name;
  }
  return row.label;
}

/** `related[]` as chips, in the server's order, minus the omitted kinds. */
export function relatedChips(
  t: Translate,
  format: ReturnType<typeof useFormatters>,
  calendarDate: (iso: string) => string,
  related: readonly RelatedLink[] | undefined,
  omitKinds: readonly RecordLinkKind[] = [],
): RecordLinkChipData[] {
  return (related ?? [])
    .filter((row) => !omitKinds.includes(row.kind))
    .map((row) => ({
      kind: row.kind,
      id: row.id,
      label: relatedRowLabel(t, row),
      dateLabel: row.date
        ? // A dose date is a calendar date at UTC midnight.
          row.kind === "vaccination"
          ? calendarDate(row.date)
          : format.date(row.date)
        : null,
      href: row.href,
      note: viaText(t, row.via),
    }));
}

export interface RecordLinkChipData {
  kind: RecordLinkKind;
  id: string;
  label: string;
  /** Already formatted for the reader, or null for an undated record. */
  dateLabel?: string | null;
  /** Where the record opens; null renders the chip as plain text. */
  href: string | null;
  /** Read out after the name, never drawn (how a derived link runs). */
  note?: string | null;
}

/**
 * One linked record. The icon says the kind at a glance, the name is
 * content (foreground), the date is meta (muted). A screen reader hears the
 * kind first, because the icon is not read.
 */
export function RecordLinkChip({
  chip,
  tabIndex,
  className,
  slot = "record-link",
}: {
  chip: RecordLinkChipData;
  /** For a chip inside a roving-tabindex grid (the vault's cards). */
  tabIndex?: number;
  className?: string;
  slot?: string;
}) {
  const { t } = useTranslations();
  const Icon = RECORD_LINK_ICONS[chip.kind];
  const body = (
    <>
      <Icon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
      <span className="sr-only">{recordLinkKindText(t, chip.kind)}: </span>
      <span className="text-foreground min-w-0 truncate">{chip.label}</span>
      {chip.dateLabel ? (
        <span className="text-muted-foreground shrink-0 tabular-nums">
          <span className="sr-only">, </span>
          {chip.dateLabel}
        </span>
      ) : null}
      {chip.note ? <span className="sr-only">, {chip.note}</span> : null}
    </>
  );
  const shape =
    "border-border bg-muted/40 inline-flex min-h-8 max-w-64 items-center gap-1.5 rounded-full border px-2.5 text-xs";
  if (!chip.href) {
    return (
      <span
        data-slot={slot}
        data-kind={chip.kind}
        className={cn(shape, className)}
      >
        {body}
      </span>
    );
  }
  return (
    <Link
      href={chip.href}
      data-slot={slot}
      data-kind={chip.kind}
      tabIndex={tabIndex}
      title={chip.note ?? undefined}
      className={cn(
        shape,
        "hover:bg-muted focus-visible:ring-ring/50 transition-colors focus-visible:ring-[3px] focus-visible:outline-none",
        className,
      )}
    >
      {body}
    </Link>
  );
}

export interface RecordLinkAddOption {
  kind: RecordLinkKind;
  /** Needed when two entries share a kind; defaults to the kind. */
  key?: string;
  /** The menu entry; defaults to the kind's singular name. */
  label?: string;
  onSelect: () => void;
}

/**
 * "Verknüpfen". One option opens it straight away; several ask which family
 * first.
 */
export function RecordLinkAddButton({
  options,
  slot,
  disabled = false,
}: {
  options: readonly RecordLinkAddOption[];
  slot: string;
  /** Waiting on something the pickers must not start without. */
  disabled?: boolean;
}) {
  const { t } = useTranslations();
  if (options.length === 0) return null;
  const trigger = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 rounded-full text-xs"
      data-slot={`${slot}-add`}
      disabled={disabled}
      onClick={options.length === 1 ? options[0].onSelect : undefined}
    >
      <Plus className="size-3.5" aria-hidden />
      {t("links.row.add")}
    </Button>
  );
  if (options.length === 1) return trigger;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-slot={`${slot}-add-menu`}>
        {options.map((option) => {
          const Icon = RECORD_LINK_ICONS[option.kind];
          return (
            <DropdownMenuItem
              key={option.key ?? option.kind}
              data-slot={`${slot}-add-${option.key ?? option.kind}`}
              onSelect={option.onSelect}
            >
              <Icon className="size-4" aria-hidden />
              {option.label ?? recordLinkKindText(t, option.kind)}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The row: a label, the chips, and the add button after the last chip.
 * Nothing at all when there is no chip and no way to add one.
 *
 * `labelled={false}` drops the visible label for a surface whose own heading
 * already says "Verknüpfungen" (a tile, a detail section); the list keeps its
 * accessible name either way.
 */
export function RecordLinksRow({
  chips,
  add,
  status,
  slot = "record-links",
  labelled = true,
}: {
  chips: readonly RecordLinkChipData[];
  /** The add button, usually a `RecordLinkAddButton`. */
  add?: ReactNode;
  /** A loading or failed-read line in place of the chips. */
  status?: ReactNode;
  slot?: string;
  labelled?: boolean;
}) {
  const { t } = useTranslations();
  const labelId = useId();
  if (chips.length === 0 && !add && !status) return null;
  return (
    <div className="space-y-2" data-slot={slot}>
      {labelled ? (
        <p id={labelId} className="text-sm leading-none font-medium">
          {t("links.related.title")}
        </p>
      ) : null}
      {status}
      {chips.length > 0 || add ? (
        <ul
          className="flex flex-wrap items-center gap-1.5"
          aria-labelledby={labelled ? labelId : undefined}
          aria-label={labelled ? undefined : t("links.related.title")}
          data-slot={`${slot}-chips`}
        >
          {chips.map((chip) => (
            <li key={`${chip.kind}:${chip.id}`} className="min-w-0">
              <RecordLinkChip chip={chip} />
            </li>
          ))}
          {add ? <li>{add}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
