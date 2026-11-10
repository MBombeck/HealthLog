"use client";

import * as React from "react";
import { Search, X } from "lucide-react";

import {
  FilterBar,
  FilterBarDateRange,
  FilterBarSelect,
  FILTER_BAR_PILL_CLASSES,
  type FilterBarSelectOption,
} from "@/components/ui/filter-bar";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import {
  isModuleSortDir,
  type ModuleSortDir,
} from "@/lib/settings/module-list-layout";
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
  onSortChange: (sort: ModuleSortDir) => void;
  onResetFilters: () => void;
  isFiltered: boolean;
  categories?: LabOverviewCategoryDto[] | null;
  total?: number;
  currentSortDir: ModuleSortDir;
  hasManualOrder?: boolean;
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
  onSortChange,
  onResetFilters,
  isFiltered,
  categories,
  total,
  currentSortDir,
  hasManualOrder,
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

  const sortOptions: FilterBarSelectOption[] = [
    { value: "recentDesc", label: t("labs.sort.recentDesc") },
    { value: "recentAsc", label: t("labs.sort.recentAsc") },
    { value: "alphaAsc", label: t("labs.sort.alphaAsc") },
    { value: "alphaDesc", label: t("labs.sort.alphaDesc") },
    ...(hasManualOrder
      ? [{ value: "manual", label: t("labs.sort.manual") }]
      : []),
  ];

  const currentSortLabel =
    sortOptions.find((o) => o.value === currentSortDir)?.label ?? currentSortDir;

  return (
    <div data-slot="lab-filter-rail" className="space-y-3">
      <FilterBar
        isFiltered={isFiltered}
        onReset={onResetFilters}
        railClassName="max-sm:mx-0 max-sm:flex-wrap max-sm:overflow-visible max-sm:px-0 sm:min-w-0 sm:flex-1"
        count={
          total !== undefined
            ? tCount("labs.filter.markerCount", total, {
                count: fmt.integer(total),
              })
            : undefined
        }
      >
        <div className="relative w-full shrink-0 sm:w-56">
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
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 absolute top-1/2 right-0 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-full outline-none focus-visible:ring-[3px]"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>

        <FilterBarDateRange
          label={t("dataList.dateRange")}
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

        <span className="relative inline-flex shrink-0">
          <Select
            value={currentSortDir}
            onValueChange={(val) => {
              if (isModuleSortDir(val)) onSortChange(val);
            }}
          >
            <SelectTrigger
              aria-label={`${t("labs.sort.heading")}: ${currentSortLabel}`}
              data-slot="filter-bar-pill"
              className={FILTER_BAR_PILL_CLASSES}
            >
              <span className="truncate">
                <span className="text-muted-foreground">{t("labs.sort.heading")}: </span>
                {currentSortLabel}
              </span>
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {sortOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </span>
      </FilterBar>
    </div>
  );
}
