"use client";

/**
 * The shared entity link picker: a searchable, grouped, multi-select surface
 * for attaching records (documents, lab results, illness episodes, …) to a
 * visit or a vaccination.
 *
 * One pattern, two consumers. The visit form mounts one per family (documents,
 * labs, conditions); the vaccination form mounts the documents one. Both used
 * to render a flat capped list with no search — 30 lab values arrived as 25
 * undifferentiated rows and anything past the cap was unreachable. This block
 * replaces that with an inline summary (removable chips + an add button) and a
 * sheet that searches, groups and multi-selects.
 *
 * **The gate blanks the block, it does not post-filter it.** The caller mounts
 * this only for a module that is on; a switched-off module leaves nothing here.
 *
 * Nothing here can block a save: the selection starts empty and stays valid
 * empty, and the link cap stays authoritative on the server. This surface only
 * ever raises the FETCH limit so grouping has something to group; it never
 * raises what may be linked.
 *
 * **A chip is a record, not a remove button.** The whole chip used to be the
 * unlink control with an X drawn inside it, so a tap meant to open the linked
 * record removed the link instead. The label now opens the record when the
 * option names a target (`href`) and is plain text when it does not; only the
 * separate X, labelled with what it removes, unlinks, and every unlink offers
 * an undo right under the chips. The undo is inline rather than in a toast on
 * purpose: this block lives inside a modal sheet, and a toast sits outside the
 * sheet where its button cannot be pressed while the sheet is open. The chip
 * carries the option's date, so two doses of one vaccine read as two
 * different records.
 *
 * **A long list pages on the server.** A caller over a list that can outgrow
 * one page passes `server`: the search box then asks the list route instead
 * of filtering what is loaded, and "Load newer" / "Load older" page through
 * the windows around the record's date (see `useLinkPickerPages`). A record
 * that is linked always shows as a chip, whether or not the page that holds
 * it is loaded: the caller passes what it knows about the existing links as
 * `knownOptions`, and every option picked in this session is remembered.
 */
import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Check, Loader2, Plus, Search, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import { formatPeriod, type PeriodQuery } from "./period-query";
import { InlineAction } from "@/components/ui/inline-action";

export interface EntityLinkOption {
  id: string;
  label: string;
  /** Already-localized date string, or null for a target with no date. */
  dateLabel?: string | null;
  /** Optional secondary muted line (e.g. the analyte under a panel group). */
  meta?: string | null;
  /**
   * Grouping key + already-localized heading. Omit or null for a flat list.
   * Options with the same key collapse under one heading, in first-seen order.
   */
  group?: { key: string; label: string } | null;
  /**
   * Where the linked record opens, or null/omitted when it has no page of its
   * own. The chip's label becomes a link to it; the X stays the only unlink.
   */
  href?: string | null;
}

/** Lowercased haystack for the client search over one option. */
function haystack(option: EntityLinkOption): string {
  return [option.label, option.meta, option.group?.label, option.dateLabel]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Client-side search: the whole term must appear in the option's haystack. */
export function filterOptions(
  options: EntityLinkOption[],
  term: string,
): EntityLinkOption[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return options;
  return options.filter((option) => haystack(option).includes(needle));
}

/**
 * Server-side search and paging for a list that can outgrow one page. The
 * caller owns the term (it is part of the list route's query) and the pages.
 */
export interface EntityLinkServerPaging {
  term: string;
  onTermChange: (term: string) => void;
  /** The typed term has not been answered yet. */
  searchPending: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  onOlder: () => void;
  onNewer: () => void;
  /**
   * The list route has no text search: the term filters the loaded options
   * here instead of being sent.
   */
  filterLocally?: boolean;
  /** The term names a year or a month, and the list is that period. */
  period?: PeriodQuery | null;
}

/**
 * The paging props from a `useLinkPickerPages` result, so every caller
 * wires the same fields the same way.
 */
export function serverPagingFrom(pages: {
  term: string;
  setTerm: (term: string) => void;
  searchPending: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  loadOlder: () => void;
  loadNewer: () => void;
  filterLocally: boolean;
  period: PeriodQuery | null;
}): EntityLinkServerPaging {
  return {
    term: pages.term,
    onTermChange: pages.setTerm,
    searchPending: pages.searchPending,
    hasOlder: pages.hasOlder,
    hasNewer: pages.hasNewer,
    loadingOlder: pages.loadingOlder,
    loadingNewer: pages.loadingNewer,
    onOlder: pages.loadOlder,
    onNewer: pages.loadNewer,
    filterLocally: pages.filterLocally,
    period: pages.period,
  };
}

/**
 * The options a chip can be resolved from: what is loaded, what the caller
 * knows about the existing links, and what was picked in this session. The
 * loaded option wins, then the known one, then the picked one.
 */
export function resolvableOptions(
  options: readonly EntityLinkOption[],
  knownOptions: readonly EntityLinkOption[],
  picked: ReadonlyMap<string, EntityLinkOption>,
): Map<string, EntityLinkOption> {
  const map = new Map<string, EntityLinkOption>(picked);
  for (const option of knownOptions) map.set(option.id, option);
  for (const option of options) map.set(option.id, option);
  return map;
}

export interface EntityLinkGroup {
  /** Group key, or null for the flat (ungrouped) bucket. */
  key: string | null;
  /** Heading to render, or null when the list is flat. */
  label: string | null;
  options: EntityLinkOption[];
}

/**
 * Collapse options into ordered groups. A group's position is where its first
 * member appears, so the caller's own ordering (usually newest first) carries
 * through. When no option carries a group, the whole list is one flat bucket
 * with a null heading.
 */
export function groupOptions(options: EntityLinkOption[]): EntityLinkGroup[] {
  const anyGrouped = options.some((option) => option.group != null);
  if (!anyGrouped) {
    return options.length ? [{ key: null, label: null, options }] : [];
  }
  const order: string[] = [];
  const byKey = new Map<string, EntityLinkGroup>();
  for (const option of options) {
    const key = option.group?.key ?? "__ungrouped__";
    const label = option.group?.label ?? null;
    let group = byKey.get(key);
    if (!group) {
      group = { key, label, options: [] };
      byKey.set(key, group);
      order.push(key);
    }
    group.options.push(option);
  }
  return order.map((key) => byKey.get(key)!);
}

/**
 * Toggle a whole group's ids: if every id is already selected, remove them
 * all; otherwise add the missing ones. Preserves order and never duplicates.
 */
export function toggleAll(selected: string[], ids: string[]): string[] {
  const selectedSet = new Set(selected);
  const allOn = ids.every((id) => selectedSet.has(id));
  if (allOn) {
    const drop = new Set(ids);
    return selected.filter((id) => !drop.has(id));
  }
  const merged = [...selected];
  for (const id of ids) if (!selectedSet.has(id)) merged.push(id);
  return merged;
}

/** Put an unlinked id back (the undo), never twice. */
export function restoreLink(selected: string[], id: string): string[] {
  return selected.includes(id) ? selected : [...selected, id];
}

/** The chip's full name: the label and, when it has one, the date. */
function chipName(option: EntityLinkOption): string {
  return option.dateLabel
    ? `${option.label}, ${option.dateLabel}`
    : option.label;
}

function toggleOne(selected: string[], id: string): string[] {
  return selected.includes(id)
    ? selected.filter((entry) => entry !== id)
    : [...selected, id];
}

export interface EntityLinkPickerProps {
  icon: LucideIcon;
  title: string;
  /** data-slot on the inline block; the module-gate tests assert this. */
  slot: string;
  options: EntityLinkOption[];
  pending: boolean;
  selected: string[];
  onChange: (ids: string[]) => void;
  searchPlaceholder: string;
  emptyLabel: string;
  /**
   * The option read failed. Renders an error row with Retry instead of the
   * empty label: a failed read must never pass for "nothing to link", which
   * is exactly how a refused page size once hid a whole vault. Pass the
   * failed read's error (or any truthy value for a failure without one); the
   * row reads its status.
   */
  error?: unknown;
  errorLabel?: string;
  onRetry?: () => void;
  /**
   * A second way to add, beside the add button: the documents pickers put
   * "Import from Paperless-ngx / Papra" here. Shown even when there is
   * nothing to link yet, because an empty vault is exactly when importing is
   * the way forward. The element renders nothing when it has nothing to offer.
   */
  extraAction?: ReactNode;
  /** Server-side search and paging; omit for a list that fits one read. */
  server?: EntityLinkServerPaging;
  /**
   * What the caller knows about records already linked (label and date from
   * the record's own read), so their chips show even when no loaded page
   * holds them.
   */
  knownOptions?: EntityLinkOption[];
  /**
   * Render the search sheet alone, opened from outside (`open` /
   * `onOpenChange`). The record's chips then live in the caller's
   * `RecordLinksRow`, and the loading, failed and empty states move into the
   * sheet.
   */
  sheetOnly?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function EntityLinkPicker({
  icon: Icon,
  title,
  slot,
  options,
  pending,
  selected,
  onChange,
  searchPlaceholder,
  emptyLabel,
  error = null,
  errorLabel,
  onRetry,
  extraAction,
  server,
  knownOptions,
  sheetOnly = false,
  open: openProp,
  onOpenChange: onOpenChangeProp,
}: EntityLinkPickerProps) {
  const { t, locale } = useTranslations();
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChangeProp ?? setOpenState;
  const [localTerm, setLocalTerm] = useState("");
  const term = server ? server.term : localTerm;
  const setTerm = server ? server.onTermChange : setLocalTerm;

  // Every option picked in this session, so its chip survives a search or a
  // page change that takes it out of the loaded list. Written from the event
  // handlers, never during render.
  const [picked, setPicked] = useState<ReadonlyMap<string, EntityLinkOption>>(
    () => new Map(),
  );
  const remember = (more: readonly EntityLinkOption[]) => {
    if (more.length === 0) return;
    setPicked((prev) => {
      const next = new Map(prev);
      for (const option of more) next.set(option.id, option);
      return next;
    });
  };

  const optionById = useMemo(
    () => resolvableOptions(options, knownOptions ?? [], picked),
    [options, knownOptions, picked],
  );

  // A server-paged list is already the answer to the term; filtering it
  // again here would drop a match on a field the option does not render.
  const groups = useMemo(() => {
    const visible =
      // A period is answered by the route's date window, never by the digits.
      server && (!server.filterLocally || server.period)
        ? options
        : filterOptions(options, term);
    // Linked records the loaded pages do not hold stay reachable in the
    // sheet, on top, so they can be unticked where they are listed.
    const loaded = new Set(options.map((option) => option.id));
    const linkedElsewhere = term.trim()
      ? []
      : selected
          .filter((id) => !loaded.has(id))
          .map((id) => optionById.get(id))
          .filter((option): option is EntityLinkOption => option != null)
          .map((option) => ({
            ...option,
            group: { key: "__linked__", label: t("links.picker.linked") },
          }));
    return groupOptions([...linkedElsewhere, ...visible]);
  }, [options, term, server, selected, optionById, t]);

  // The link the last X removed, offered back until the next change.
  const [lastRemoved, setLastRemoved] = useState<EntityLinkOption | null>(null);

  const change = (ids: string[], touched: readonly EntityLinkOption[] = []) => {
    setLastRemoved(null);
    remember(touched);
    onChange(ids);
  };

  const unlink = (option: EntityLinkOption) => {
    onChange(selected.filter((id) => id !== option.id));
    setLastRemoved(option);
  };

  const selectedSet = new Set(selected);
  const selectedChips = selected
    .map((id) => optionById.get(id))
    .filter((option): option is EntityLinkOption => option != null);

  // In sheet-only mode the loading, failed and empty states the inline
  // block would show move into the sheet.
  const sheetStatus = sheetOnly
    ? pickerSheetStatus({
        pending,
        error,
        errorLabel,
        onRetry,
        slot,
        emptyLabel,
        extraAction,
        empty:
          options.length === 0 &&
          selected.length === 0 &&
          !term.trim() &&
          !(server && (server.hasOlder || server.hasNewer)),
      })
    : null;

  const sheet = (
    <ResponsiveSheet
      open={open}
      onOpenChange={setOpen}
      title={title}
      contentWidth="lg"
    >
      <div className="space-y-3">
        <div className="relative">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="pl-9"
            data-slot={`${slot}-search`}
          />
        </div>

        {server?.period ? (
          <p
            className="text-muted-foreground px-1 text-xs"
            data-slot={`${slot}-period`}
          >
            {t("links.picker.period.showing", {
              period: formatPeriod(server.period, locale),
            })}
          </p>
        ) : null}

        {sheetStatus ? (
          sheetStatus
        ) : server?.searchPending && groups.length === 0 ? (
          <div
            className="flex justify-center py-6"
            data-slot={`${slot}-searching`}
          >
            <Loader2
              className="text-muted-foreground size-4 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          </div>
        ) : groups.length === 0 &&
          !(server && (server.hasOlder || server.hasNewer)) ? (
          <p className="text-muted-foreground px-1 py-6 text-center text-sm">
            {t("links.picker.searchNoMatch")}
          </p>
        ) : (
          <div className="max-h-[50vh] space-y-4 overflow-y-auto overscroll-contain">
            {server?.hasNewer ? (
              <PageButton
                slot={`${slot}-load-newer`}
                loading={server.loadingNewer}
                onClick={server.onNewer}
                label={t("links.picker.loadNewer")}
              />
            ) : null}
            {groups.map((group) => {
              const groupIds = group.options.map((option) => option.id);
              return (
                <div key={group.key ?? "__flat__"} className="space-y-1">
                  {group.label ? (
                    <div className="flex items-center justify-between gap-2 px-1">
                      <span
                        className="text-muted-foreground text-xs font-medium"
                        data-slot={`${slot}-group-heading`}
                      >
                        {group.label}
                      </span>
                      <InlineAction
                        tone="muted"
                        data-slot={`${slot}-group-select`}
                        onClick={() =>
                          change(toggleAll(selected, groupIds), group.options)
                        }
                      >
                        {t("links.picker.selectAll")}
                      </InlineAction>
                    </div>
                  ) : null}
                  <ul className="space-y-1">
                    {group.options.map((option) => {
                      const on = selectedSet.has(option.id);
                      return (
                        <li key={option.id}>
                          <button
                            type="button"
                            aria-pressed={on}
                            data-slot={`${slot}-option`}
                            onClick={() =>
                              change(toggleOne(selected, option.id), [option])
                            }
                            className={cn(
                              "border-border hover:bg-muted/50 focus-visible:ring-ring/50 flex min-h-11 w-full items-center gap-2 rounded-md border px-3 text-left focus-visible:ring-[3px] focus-visible:outline-none",
                              on && "border-primary/40 bg-primary/5",
                            )}
                          >
                            <Check
                              className={cn(
                                "size-4 shrink-0",
                                on ? "opacity-100" : "opacity-0",
                              )}
                              aria-hidden
                            />
                            <span className="min-w-0 flex-1">
                              <span className="text-foreground block truncate text-sm">
                                {option.label}
                              </span>
                              {option.meta ? (
                                <span className="text-muted-foreground block truncate text-xs">
                                  {option.meta}
                                </span>
                              ) : null}
                            </span>
                            {option.dateLabel ? (
                              <span className="text-muted-foreground shrink-0 text-xs">
                                {option.dateLabel}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
            {server?.hasOlder ? (
              <PageButton
                slot={`${slot}-load-older`}
                loading={server.loadingOlder}
                onClick={server.onOlder}
                label={t("links.picker.loadOlder")}
              />
            ) : null}
          </div>
        )}

        <div className="flex justify-end border-t pt-3">
          <Button type="button" onClick={() => setOpen(false)}>
            {t("links.picker.done")}
          </Button>
        </div>
      </div>
    </ResponsiveSheet>
  );

  if (sheetOnly) return sheet;

  return (
    <div className="space-y-2" data-slot={slot}>
      <div className="flex items-center gap-2">
        <Icon className="text-foreground size-4 shrink-0" aria-hidden />
        <span className="text-sm font-medium">{title}</span>
        {selected.length > 0 ? (
          <Badge variant="outline" className="ml-auto">
            {selected.length}
          </Badge>
        ) : null}
      </div>

      {pending && !error ? (
        <Skeleton className="h-9 w-full rounded-md" />
      ) : error ? (
        <QueryErrorRow
          error={error}
          message={errorLabel}
          onRetry={onRetry}
          slot={`${slot}-error`}
        />
      ) : options.length === 0 &&
        selected.length === 0 &&
        !(server && (server.hasOlder || server.hasNewer)) ? (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">{emptyLabel}</p>
          {extraAction}
        </div>
      ) : (
        <div className="space-y-2">
          {selectedChips.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" data-slot={`${slot}-chips`}>
              {selectedChips.map((option) => {
                const name = (
                  <>
                    <span className="text-foreground max-w-48 truncate">
                      {option.label}
                    </span>
                    {option.dateLabel ? (
                      <span className="text-muted-foreground shrink-0">
                        {option.dateLabel}
                      </span>
                    ) : null}
                  </>
                );
                return (
                  <li
                    key={option.id}
                    data-slot={`${slot}-chip`}
                    className="border-border bg-muted/40 flex min-h-8 items-center rounded-full border text-xs"
                  >
                    {option.href ? (
                      <Link
                        href={option.href}
                        data-slot={`${slot}-chip-open`}
                        className="hover:bg-muted focus-visible:ring-ring/50 flex min-h-8 min-w-0 items-center gap-1.5 rounded-full py-1 pr-1.5 pl-3 focus-visible:ring-[3px] focus-visible:outline-none"
                      >
                        {name}
                      </Link>
                    ) : (
                      <span className="flex min-w-0 items-center gap-1.5 py-1 pr-1.5 pl-3">
                        {name}
                      </span>
                    )}
                    <button
                      type="button"
                      data-slot={`${slot}-chip-remove`}
                      aria-label={t("links.picker.removeNamed", {
                        name: chipName(option),
                      })}
                      onClick={() => unlink(option)}
                      className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 relative mr-0.5 flex size-7 shrink-0 items-center justify-center rounded-full after:absolute after:-inset-2 after:content-[''] focus-visible:ring-[3px] focus-visible:outline-none"
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {lastRemoved ? (
            <p
              role="status"
              data-slot={`${slot}-undo`}
              className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs"
            >
              <span>
                {t("links.picker.removed", { name: chipName(lastRemoved) })}
              </span>
              <button
                type="button"
                data-slot={`${slot}-undo-button`}
                onClick={() =>
                  change(restoreLink(selected, lastRemoved.id), [lastRemoved])
                }
                className="text-foreground focus-visible:ring-ring/50 min-h-8 rounded-sm font-medium underline underline-offset-2 focus-visible:ring-[3px] focus-visible:outline-none"
              >
                {t("common.undo")}
              </button>
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-9"
              data-slot={`${slot}-add`}
              onClick={() => setOpen(true)}
            >
              <Plus className="size-4" aria-hidden />
              {t("links.picker.add")}
            </Button>
            {extraAction}
          </div>
        </div>
      )}

      {sheet}
    </div>
  );
}

/** What a sheet-only picker shows instead of its list, or null for the list. */
function pickerSheetStatus({
  pending,
  error,
  errorLabel,
  onRetry,
  slot,
  emptyLabel,
  extraAction,
  empty,
}: {
  pending: boolean;
  error: unknown;
  errorLabel?: string;
  onRetry?: () => void;
  slot: string;
  emptyLabel: string;
  extraAction?: ReactNode;
  empty: boolean;
}): ReactNode {
  if (pending && !error) return <Skeleton className="h-11 w-full rounded-md" />;
  if (error) {
    return (
      <QueryErrorRow
        error={error}
        message={errorLabel}
        onRetry={onRetry}
        slot={`${slot}-error`}
      />
    );
  }
  if (!empty) return null;
  return (
    <div className="space-y-2 px-1 py-6 text-center">
      <p className="text-muted-foreground text-sm">{emptyLabel}</p>
      {extraAction}
    </div>
  );
}

/** "Load newer" / "Load older": a full-width row inside the scrolling list. */
function PageButton({
  slot,
  loading,
  onClick,
  label,
}: {
  slot: string;
  loading: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="min-h-11 w-full"
      data-slot={slot}
      disabled={loading}
      aria-busy={loading}
      onClick={onClick}
    >
      {loading ? (
        <Loader2
          className="size-4 animate-spin motion-reduce:animate-none"
          aria-hidden
        />
      ) : null}
      {label}
    </Button>
  );
}
