"use client";

import * as React from "react";
import { Search, X } from "lucide-react";

import {
  FilterBar,
  FilterBarDateRange,
  FilterBarSelect,
  type FilterBarSelectOption,
} from "@/components/ui/filter-bar";
import { Input } from "@/components/ui/input";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { labSourceLabelKey } from "@/lib/i18n/source-labels";
import {
  isLabStatusFilter,
  type LabListFilters,
  type LabStatusFilter,
} from "./lab-list-filters";
import type { LabOverviewCategoryDto } from "./types";

export interface LabFilterRailProps {
  filters: LabListFilters;
  searchDraft: string;
  onSearchChange: (value: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onStatusChange: (status: LabStatusFilter | "ALL") => void;
  onCategoryChange: (category: string) => void;
  onSourceChange: (source: string) => void;
  onFromDayChange: (from: string) => void;
  onToDayChange: (to: string) => void;
  onResetFilters: () => void;
  isFiltered: boolean;
  categories?: LabOverviewCategoryDto[] | null;
  /** The sources the markers' newest readings carry, in display order. */
  sources?: readonly string[];
  total?: number;
}

export function LabFilterRail({
  filters,
  searchDraft,
  onSearchChange,
  searchInputRef,
  onStatusChange,
  onCategoryChange,
  onSourceChange,
  onFromDayChange,
  onToDayChange,
  onResetFilters,
  isFiltered,
  categories,
  sources,
  total,
}: LabFilterRailProps) {
  const { t, tCount } = useTranslations();
  const fmt = useFormatters();

  const statusOptions: FilterBarSelectOption[] = [
    { value: "abnormal", label: t("labs.filter.statusAbnormal") },
    { value: "in-range", label: t("labs.range.inRange") },
    { value: "below", label: t("labs.range.below") },
    { value: "above", label: t("labs.range.above") },
  ];

  // The server's categories in the server's order, so the pill follows the
  // saved category order. One category is nothing to choose between, unless
  // a link already filters by it and the pill is the way to clear it.
  const categoryOptions: FilterBarSelectOption[] = (categories ?? []).map(
    (c) => ({
      value: c.key,
      label: c.label,
    }),
  );

  // Like the categories: one source is nothing to choose between, unless a
  // link already filters by it and the pill is the way to clear it.
  const sourceOptions: FilterBarSelectOption[] = (sources ?? []).flatMap(
    (source) => {
      const key = labSourceLabelKey(source);
      return key ? [{ value: source, label: t(key) }] : [];
    },
  );

  // Search sits beside the rail rather than in it: below `sm` the rail is
  // the shared horizontal scroll row, and a full-width input inside it
  // would leave the filter icon stranded on a line of its own.
  return (
    <div
      data-slot="lab-filter-rail"
      className="flex flex-col gap-3 sm:flex-row sm:items-start"
    >
      <div className="relative w-full sm:w-56 sm:shrink-0">
        <Search
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          aria-hidden="true"
        />
        <Input
          ref={searchInputRef}
          type="search"
          value={searchDraft}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t("labs.filter.searchPlaceholder")}
          aria-label={t("labs.filter.searchLabel")}
          aria-keyshortcuts="/"
          className="w-full min-w-0 pr-11 pl-9 [&::-webkit-search-cancel-button]:appearance-none"
        />
        {searchDraft === "" ? (
          <kbd
            aria-hidden="true"
            className="border-border text-muted-foreground pointer-events-none absolute top-1/2 right-2.5 hidden -translate-y-1/2 rounded border px-1.5 font-mono text-xs sm:inline-block"
          >
            /
          </kbd>
        ) : (
          <button
            type="button"
            onClick={() => {
              onSearchChange("");
              // The button goes away with the text; focus stays in the field.
              searchInputRef.current?.focus();
            }}
            aria-label={t("labs.filter.clearSearch")}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 absolute top-1/2 right-0 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-full outline-none focus-visible:ring-[3px] sm:size-10"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="min-w-0 sm:flex-1">
        <FilterBar
          isFiltered={isFiltered}
          onReset={onResetFilters}
          count={
            total !== undefined
              ? tCount("labs.filter.markerCount", total, {
                  count: fmt.integer(total),
                })
              : undefined
          }
        >
          <FilterBarDateRange
            label={t("labs.filter.lastMeasured")}
            from={filters.fromDay ?? ""}
            to={filters.toDay ?? ""}
            onFromChange={onFromDayChange}
            onToChange={onToDayChange}
            idPrefix="labs-filter-date"
          />

          <FilterBarSelect
            label={t("labs.filter.statusLabel")}
            value={filters.status ?? "ALL"}
            onValueChange={(val) => {
              if (isLabStatusFilter(val)) onStatusChange(val);
            }}
            options={statusOptions}
            allValue="ALL"
            allLabel={t("labs.filter.statusAll")}
          />

          {(categoryOptions.length > 1 || filters.category) && (
            <FilterBarSelect
              label={t("labs.filter.categoryLabel")}
              value={filters.category ?? "ALL"}
              onValueChange={onCategoryChange}
              options={categoryOptions}
              allValue="ALL"
              allLabel={t("labs.filter.categoryAll")}
            />
          )}
          {(sourceOptions.length > 1 || filters.source) && (
            <FilterBarSelect
              label={t("dataList.sourceLabel")}
              value={filters.source ?? "ALL"}
              onValueChange={onSourceChange}
              options={sourceOptions}
              allValue="ALL"
              allLabel={t("dataList.allSources")}
            />
          )}
        </FilterBar>
      </div>
    </div>
  );
}
