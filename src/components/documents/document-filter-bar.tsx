"use client";

/**
 * The vault's sticky filter rail: debounced title/filename search plus four
 * compact dropdown facets — type (multi-select, OR inside the facet),
 * condition (episodes that actually carry links, single-select), procedure
 * (procedures and surgeries that actually carry links, single-select), and
 * year (years present in the corpus, single-select) — and a one-tap clear
 * with the active-facet count.
 *
 * The controls sit on ONE row at every width: the search flexes and can
 * shrink to nothing while each dropdown trigger stays a fixed compact
 * control, so the bar never wraps to a second line and never grows a
 * horizontal chip scroller. The corpus-backfill prompt rides its own helper
 * line below, only while some documents remain un-indexed.
 *
 * Purely presentational — the filter state lives in the page URL and is
 * owned by `documents-view.tsx`; this bar only renders the controls. It
 * sticks below the top edge inside the shell's scroll container (sticky,
 * translucent background, border-b — no viewport-height tricks).
 */
import {
  Activity,
  Calendar,
  ChevronDown,
  ListFilter,
  ScanSearch,
  Scissors,
  Search,
  X,
} from "lucide-react";
import type { RefObject } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { InboundDocumentKindValue } from "@/lib/validations/inbound-documents";
import { DOCUMENT_KIND_ICONS, DOCUMENT_KIND_ORDER } from "./document-kind-meta";
import type { ProcedureFilterChoice } from "./vault-utils";

/**
 * Active-facet tint on a dropdown trigger — mirrors the app pill vocabulary.
 * An active trigger may also shrink (its label truncates further), so on a
 * phone with several facets set the row gives up label width before it gives
 * up the search field.
 */
const TRIGGER_ACTIVE =
  "border-primary/40 bg-primary/10 text-foreground min-w-0 shrink";
/** Shared trigger chrome: compact, fixed, never shrinks below its label. */
const TRIGGER_CLASSES = "shrink-0 gap-1.5 font-normal";

/**
 * The facet label is the whole point of the trigger — but four text labels
 * plus the search will not fit a 360px phone. So the label shows from `sm`
 * up, and on a phone only when the facet is ACTIVE (truncated), while the
 * leading icon always carries the facet identity. The trailing chevron is
 * desktop-only chrome. Net: inactive phone triggers collapse to a single
 * icon, the row stays one line at every width, and the accessible name is
 * pinned via `aria-label` so an icon-only trigger still announces its state.
 */
function facetLabelClass(active: boolean): string {
  return cn(
    "max-w-28 min-w-0 truncate",
    active ? "inline" : "hidden sm:inline",
  );
}

export interface ConditionChip {
  episodeId: string;
  name: string;
}

export function DocumentFilterBar({
  searchValue,
  onSearchChange,
  searchInputRef,
  activeKinds,
  onToggleKind,
  conditionChips,
  activeEpisodeId,
  onToggleEpisode,
  procedureChips,
  activeEncounterId,
  onToggleEncounter,
  years,
  activeYear,
  onToggleYear,
  activeCount,
  onClearAll,
  showIndexAll = false,
  indexAllPending = false,
  onIndexAll,
}: {
  searchValue: string;
  onSearchChange: (value: string) => void;
  /** Focused by the page-level `/` shortcut. */
  searchInputRef: RefObject<HTMLInputElement | null>;
  activeKinds: ReadonlySet<InboundDocumentKindValue>;
  onToggleKind: (kind: InboundDocumentKindValue) => void;
  conditionChips: ConditionChip[];
  activeEpisodeId: string | undefined;
  onToggleEpisode: (episodeId: string) => void;
  procedureChips: ProcedureFilterChoice[];
  activeEncounterId: string | undefined;
  onToggleEncounter: (encounterId: string) => void;
  years: number[];
  activeYear: number | undefined;
  onToggleYear: (year: number) => void;
  activeCount: number;
  onClearAll: () => void;
  /** Some documents are not yet indexed — offer the corpus backfill. */
  showIndexAll?: boolean;
  indexAllPending?: boolean;
  onIndexAll?: () => void;
}) {
  const { t } = useTranslations();

  const kindCount = activeKinds.size;
  const typeLabel =
    kindCount === 0
      ? t("documents.filter.typeAll")
      : kindCount === 1
        ? t(`documents.kind.${[...activeKinds][0]}`)
        : t("documents.filter.typeCount", { count: kindCount });

  const activeCondition = conditionChips.find(
    (chip) => chip.episodeId === activeEpisodeId,
  );
  const conditionLabel =
    activeCondition?.name ?? t("documents.filter.conditionAll");

  const activeProcedure = procedureChips.find(
    (chip) => chip.encounterId === activeEncounterId,
  );
  const procedureLabel =
    activeProcedure?.name ?? t("documents.filter.procedureAll");

  const yearLabel =
    activeYear !== undefined
      ? String(activeYear)
      : t("documents.filter.yearAll");

  return (
    <div
      data-slot="document-filter-bar"
      className="bg-background/95 border-border sticky top-0 z-10 -mx-4 border-b px-4 pt-1 pb-3 backdrop-blur md:-mx-6 md:px-6"
    >
      {/* One row at every width: the search flexes (min-w-0 → it can shrink to
          nothing), every dropdown trigger stays a fixed compact control, and
          the clear pins to the trailing edge. The search keeps at least its
          icon plus its padding (the `/` hint and its padding are desktop
          only), so it never bleeds under the next control. `flex-nowrap` guarantees the bar
          never breaks to a second line. */}
      <div className="flex flex-nowrap items-center gap-2">
        <div className="relative min-w-12 flex-1">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            ref={searchInputRef}
            type="search"
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t("documents.filter.searchPlaceholder")}
            aria-label={t("documents.filter.searchLabel")}
            className="min-w-0 pr-3 pl-9 sm:pr-8"
            aria-keyshortcuts="/"
          />
          <kbd
            aria-hidden
            className="border-border text-muted-foreground pointer-events-none absolute top-1/2 right-2.5 hidden -translate-y-1/2 rounded border px-1.5 font-mono text-xs sm:inline-block"
          >
            /
          </kbd>
        </div>

        {/* Type — multi-select (OR inside the facet). Items keep the menu
            open so several kinds can be toggled in one pass. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-slot="document-type-filter"
              aria-label={typeLabel}
              className={cn(TRIGGER_CLASSES, kindCount > 0 && TRIGGER_ACTIVE)}
            >
              <ListFilter className="size-4 shrink-0" aria-hidden />
              <span className={facetLabelClass(kindCount > 0)}>
                {typeLabel}
              </span>
              <ChevronDown
                className="hidden size-3.5 opacity-60 sm:inline"
                aria-hidden
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            aria-label={t("documents.filter.typeGroup")}
          >
            <DropdownMenuLabel>
              {t("documents.filter.typeGroup")}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {DOCUMENT_KIND_ORDER.map((kind) => {
              const Icon = DOCUMENT_KIND_ICONS[kind];
              return (
                <DropdownMenuCheckboxItem
                  key={kind}
                  checked={activeKinds.has(kind)}
                  onCheckedChange={() => onToggleKind(kind)}
                  onSelect={(event) => event.preventDefault()}
                >
                  <Icon className="size-4" aria-hidden />
                  {t(`documents.kind.${kind}`)}
                </DropdownMenuCheckboxItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Condition — single-select; only rendered when episodes carry
            links. Picking closes the menu (natural single-choice cadence). */}
        {conditionChips.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-slot="document-condition-filter"
                aria-label={conditionLabel}
                className={cn(
                  TRIGGER_CLASSES,
                  activeCondition && TRIGGER_ACTIVE,
                )}
              >
                <Activity className="size-4 shrink-0" aria-hidden />
                <span className={facetLabelClass(Boolean(activeCondition))}>
                  {conditionLabel}
                </span>
                <ChevronDown
                  className="hidden size-3.5 opacity-60 sm:inline"
                  aria-hidden
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              aria-label={t("documents.filter.conditionGroup")}
            >
              <DropdownMenuLabel>
                {t("documents.filter.conditionGroup")}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {conditionChips.map((chip) => (
                <DropdownMenuCheckboxItem
                  key={chip.episodeId}
                  checked={chip.episodeId === activeEpisodeId}
                  onCheckedChange={() => onToggleEpisode(chip.episodeId)}
                >
                  <span className="max-w-56 truncate">{chip.name}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {/* Procedure — single-select; only rendered when procedures carry
            links. Same cadence as the condition facet beside it. */}
        {procedureChips.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-slot="document-procedure-filter"
                aria-label={procedureLabel}
                className={cn(
                  TRIGGER_CLASSES,
                  activeProcedure && TRIGGER_ACTIVE,
                )}
              >
                <Scissors className="size-4 shrink-0" aria-hidden />
                <span className={facetLabelClass(Boolean(activeProcedure))}>
                  {procedureLabel}
                </span>
                <ChevronDown
                  className="hidden size-3.5 opacity-60 sm:inline"
                  aria-hidden
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              aria-label={t("documents.filter.procedureGroup")}
            >
              <DropdownMenuLabel>
                {t("documents.filter.procedureGroup")}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {procedureChips.map((chip) => (
                <DropdownMenuCheckboxItem
                  key={chip.encounterId}
                  checked={chip.encounterId === activeEncounterId}
                  onCheckedChange={() => onToggleEncounter(chip.encounterId)}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="max-w-56 truncate">{chip.name}</span>
                    <span className="text-muted-foreground max-w-56 truncate text-xs">
                      {chip.detail}
                    </span>
                  </span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {/* Year — single-select; only rendered when the corpus spans years. */}
        {years.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-slot="document-year-filter"
                aria-label={yearLabel}
                className={cn(
                  TRIGGER_CLASSES,
                  "tabular-nums",
                  activeYear !== undefined && TRIGGER_ACTIVE,
                )}
              >
                <Calendar className="size-4 shrink-0" aria-hidden />
                <span className={facetLabelClass(activeYear !== undefined)}>
                  {yearLabel}
                </span>
                <ChevronDown
                  className="hidden size-3.5 opacity-60 sm:inline"
                  aria-hidden
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              aria-label={t("documents.filter.yearGroup")}
            >
              <DropdownMenuLabel>
                {t("documents.filter.yearGroup")}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {years.map((year) => (
                <DropdownMenuCheckboxItem
                  key={year}
                  checked={year === activeYear}
                  onCheckedChange={() => onToggleYear(year)}
                  className="tabular-nums"
                >
                  {year}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {activeCount > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClearAll}
            aria-label={t("documents.filter.clear")}
            className="text-muted-foreground shrink-0"
          >
            <X className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">
              {t("documents.filter.clear")}
            </span>
            {activeCount > 1 ? (
              <span className="tabular-nums">({activeCount})</span>
            ) : null}
          </Button>
        ) : null}
      </div>

      {showIndexAll ? (
        <div
          data-slot="content-search-hint"
          className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
        >
          <span className="inline-flex items-center gap-1.5">
            <ScanSearch className="size-3.5 shrink-0" aria-hidden />
            {t("documents.contentIndex.indexPrompt")}
          </span>
          <Button
            type="button"
            variant="link"
            size="sm"
            data-slot="content-index-all"
            onClick={onIndexAll}
            disabled={indexAllPending}
            className="text-primary h-auto p-0 text-xs"
          >
            {indexAllPending
              ? t("documents.contentIndex.indexAllPending")
              : t("documents.contentIndex.indexAll")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
