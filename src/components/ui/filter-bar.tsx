"use client";

import * as React from "react";
import { ListFilter, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * v1.16.1 — unified filter rail for data lists.
 *
 * One filter language for every list surface (measurements, mood, …)
 * instead of the per-page rows of large labelled Selects + date inputs
 * that had drifted apart. The grammar:
 *
 *   [filter icon] [Zeitraum] [Typ] [Quelle] … [Zurücksetzen]   [count]
 *
 * - Each dimension renders as ONE compact pill that is trigger and
 *   active-filter chip at once: inactive it shows just the dimension
 *   name ("Typ"), active it shows `Name: Wert`, picks up the primary
 *   accent, and grows a removable ✕. No second chip row, no duplicated
 *   state.
 * - Canonical order at the call sites: date range, type, source —
 *   surface-specific dimensions append after.
 * - Reset appears only while at least one dimension is active.
 * - Mobile (< sm): the rail is a horizontal scroll row (hidden
 *   scrollbar, edge-bleed) so pills never wrap into a tall block; the
 *   result count drops onto its own line.
 * - Purely presentational: filter state, query keys and fetching stay
 *   in the owning page/component — this file only renders the controls.
 *
 * A11y: every pill keeps an explicit `aria-label`; the per-pill clear
 * button carries `dataList.clearFilter` with the dimension name; touch
 * targets follow the dense-surface idiom (`min-h-11 sm:min-h-9`,
 * ui-guidelines §5).
 */

/** Shared pill chrome — trigger and chip in one element. */
const PILL_CLASSES =
  "border-border bg-card text-foreground inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm whitespace-nowrap shadow-xs transition-all duration-150 ease-out sm:min-h-9 h-auto py-1";
const PILL_ACTIVE_CLASSES = "border-primary/40 bg-primary/10";

function ClearPillButton({
  label,
  onClear,
}: {
  label: string;
  onClear: () => void;
}) {
  const { t } = useTranslations();
  return (
    <button
      type="button"
      aria-label={t("dataList.clearFilter", { label })}
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 absolute top-1/2 right-1.5 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-full outline-none focus-visible:ring-[3px]"
      onClick={onClear}
    >
      <X className="size-3.5" aria-hidden="true" />
    </button>
  );
}

export function FilterBar({
  isFiltered,
  onReset,
  count,
  children,
}: {
  /** True when at least one dimension is active — shows the reset button. */
  isFiltered: boolean;
  /** Clears every dimension back to its default. */
  onReset: () => void;
  /** Result count node (already translated/formatted by the caller). */
  count?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { t } = useTranslations();
  return (
    <div
      data-slot="filter-bar"
      className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
    >
      {/* Pill rail — horizontal scroll row below `sm` (hidden scrollbar,
          edge-bleed so the row scrolls to the screen edge), wrapping flex
          row on desktop. */}
      <div className="-mx-4 flex [scrollbar-width:none] items-center gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
        <ListFilter
          className="text-muted-foreground size-4 shrink-0"
          aria-hidden="true"
        />
        {children}
        {isFiltered && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground min-h-11 shrink-0 rounded-full sm:min-h-9"
            onClick={onReset}
          >
            {t("dataList.resetFilters")}
          </Button>
        )}
      </div>
      {count != null && (
        <span className="text-muted-foreground text-sm tabular-nums">
          {count}
        </span>
      )}
    </div>
  );
}

export interface FilterBarSelectOption {
  value: string;
  label: string;
}

/**
 * One enum dimension as a pill-shaped Radix Select. `allValue` is the
 * "no filter" sentinel (the surfaces use `"ALL"`); the pill counts as
 * active for any other value and then renders `label: valueLabel` plus
 * the clear ✕.
 */
export function FilterBarSelect({
  label,
  value,
  onValueChange,
  options,
  allValue = "ALL",
  allLabel,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: FilterBarSelectOption[];
  allValue?: string;
  allLabel: string;
}) {
  const active = value !== allValue;
  const activeLabel = active
    ? (options.find((o) => o.value === value)?.label ?? value)
    : null;
  return (
    <span className="relative inline-flex shrink-0">
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger
          aria-label={label}
          data-slot="filter-bar-pill"
          data-active={active ? "true" : "false"}
          className={cn(
            PILL_CLASSES,
            active && cn(PILL_ACTIVE_CLASSES, "pr-8"),
          )}
        >
          {active ? (
            <span className="truncate">
              <span className="text-muted-foreground">{label}: </span>
              {activeLabel}
            </span>
          ) : (
            <span className="text-muted-foreground">{label}</span>
          )}
        </SelectTrigger>
        {/* `position="popper"` is load-bearing: this trigger paints its
            own label spans and mounts no `SelectValue`, and Radix's
            default item-aligned placement silently skips ALL positioning
            when the value node is absent — the open menu then lays out
            below the height-locked app shell, fully off-viewport. Popper
            placement has no value-node dependency and anchors the menu
            under the pill like the date-range popover next to it. */}
        <SelectContent position="popper" align="start">
          <SelectItem value={allValue}>{allLabel}</SelectItem>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {active && (
        <ClearPillButton
          label={label}
          onClear={() => onValueChange(allValue)}
        />
      )}
    </span>
  );
}

/**
 * The date-range dimension as a pill-shaped Popover with the existing
 * from/to `DateInput` pair inside. Active as soon as either bound is
 * set; the pill then shows the formatted range and the clear ✕ resets
 * both bounds.
 */
export function FilterBarDateRange({
  label,
  from,
  to,
  onFromChange,
  onToChange,
  idPrefix,
}: {
  label: string;
  /** ISO day string (`YYYY-MM-DD`) or empty string. */
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  /** Unique prefix for the two input ids (label association). */
  idPrefix: string;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const active = from !== "" || to !== "";
  const display = active
    ? `${from ? fmt.dateShortSmart(from) : "…"}–${to ? fmt.dateShortSmart(to) : "…"}`
    : null;
  const clear = () => {
    onFromChange("");
    onToChange("");
  };
  return (
    <span className="relative inline-flex shrink-0">
      <Popover>
        <PopoverTrigger
          aria-label={label}
          data-slot="filter-bar-pill"
          data-active={active ? "true" : "false"}
          className={cn(
            PILL_CLASSES,
            "outline-none",
            "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
            active && cn(PILL_ACTIVE_CLASSES, "pr-8"),
          )}
        >
          {active ? (
            <span className="truncate">
              <span className="text-muted-foreground">{label}: </span>
              {display}
            </span>
          ) : (
            <span className="text-muted-foreground">{label}</span>
          )}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto space-y-3 p-4">
          <div className="flex flex-col gap-1">
            <Label
              htmlFor={`${idPrefix}-from`}
              className="text-muted-foreground text-xs"
            >
              {t("dataList.dateFrom")}
            </Label>
            <DateField
              id={`${idPrefix}-from`}
              className="w-44"
              value={from}
              max={to || undefined}
              onChange={onFromChange}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label
              htmlFor={`${idPrefix}-to`}
              className="text-muted-foreground text-xs"
            >
              {t("dataList.dateTo")}
            </Label>
            <DateField
              id={`${idPrefix}-to`}
              className="w-44"
              value={to}
              min={from || undefined}
              onChange={onToChange}
            />
          </div>
        </PopoverContent>
      </Popover>
      {active && <ClearPillButton label={label} onClear={clear} />}
    </span>
  );
}

/**
 * v1.18.5 — value-range filter pill (backlog G). Mirrors
 * `FilterBarDateRange` but over a numeric `[min, max]` band; either bound
 * may be left empty for an open-ended range. State stays as strings (the
 * raw input value) so the owning component controls coercion; empty string
 * means "unset". The pill shows `min – max` with an ellipsis for an open
 * bound, exactly as the date range does.
 */
export function FilterBarNumberRange({
  label,
  min,
  max,
  onMinChange,
  onMaxChange,
  idPrefix,
  fromLabel,
  toLabel,
}: {
  label: string;
  /** Raw input string (a number) or empty string when unset. */
  min: string;
  max: string;
  onMinChange: (value: string) => void;
  onMaxChange: (value: string) => void;
  /** Unique prefix for the two input ids (label association). */
  idPrefix: string;
  fromLabel: string;
  toLabel: string;
}) {
  const active = min !== "" || max !== "";
  const display = active ? `${min || "…"}–${max || "…"}` : null;
  const clear = () => {
    onMinChange("");
    onMaxChange("");
  };
  return (
    <span className="relative inline-flex shrink-0">
      <Popover>
        <PopoverTrigger
          aria-label={label}
          data-slot="filter-bar-pill"
          data-active={active ? "true" : "false"}
          className={cn(
            PILL_CLASSES,
            "outline-none",
            "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
            active && cn(PILL_ACTIVE_CLASSES, "pr-8"),
          )}
        >
          {active ? (
            <span className="truncate">
              <span className="text-muted-foreground">{label}: </span>
              {display}
            </span>
          ) : (
            <span className="text-muted-foreground">{label}</span>
          )}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto space-y-3 p-4">
          <div className="flex flex-col gap-1">
            <Label
              htmlFor={`${idPrefix}-min`}
              className="text-muted-foreground text-xs"
            >
              {fromLabel}
            </Label>
            <Input
              id={`${idPrefix}-min`}
              type="number"
              inputMode="decimal"
              className="w-44"
              value={min}
              onChange={(e) => onMinChange(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label
              htmlFor={`${idPrefix}-max`}
              className="text-muted-foreground text-xs"
            >
              {toLabel}
            </Label>
            <Input
              id={`${idPrefix}-max`}
              type="number"
              inputMode="decimal"
              className="w-44"
              value={max}
              onChange={(e) => onMaxChange(e.target.value)}
            />
          </div>
        </PopoverContent>
      </Popover>
      {active && <ClearPillButton label={label} onClear={clear} />}
    </span>
  );
}
