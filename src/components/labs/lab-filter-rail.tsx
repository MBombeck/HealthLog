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
  onFromDayChange: (from: string) => void;
  onToDayChange: (to: string) => void;
  onResetFilters: () => void;
  isFiltered: boolean;
  categories?: LabOverviewCategoryDto[] | null;
  total?: number;
}

export function LabFilterRail({
  filters,
  searchDraft,
  onSearchChange,
  searchInputRef,
  onStatusChange,
  onCategoryChange,
  onFromDayChange,
  onToDayChange,
  onResetFilters,
  isFiltered,
  categories,
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

  const categoryOptions: FilterBarSelectOption[] = (categories ?? []).map(
    (c) => ({
      value: c.key,
      label: c.label,
    }),
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
            onClick={() => onSearchChange("")}
            aria-label={t("labs.filter.clearSearch")}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 absolute top-1/2 right-0 inline-flex size-11 -translate-y-1/2 sm:size-10 items-center justify-center rounded-full outline-none focus-visible:ring-[3px]"
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

          {categoryOptions.length > 0 && (
            <FilterBarSelect
              label={t("labs.filter.categoryLabel")}
              value={filters.category ?? "ALL"}
              onValueChange={onCategoryChange}
              options={categoryOptions}
              allValue="ALL"
              allLabel={t("labs.filter.categoryAll")}
            />
          )}
        </FilterBar>
      </div>
    </div>
  );
}
