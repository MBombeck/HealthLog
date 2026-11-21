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
import { Button } from "@/components/ui/button";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { ALL_MEDICATION_CATEGORIES } from "@/lib/medications/category-filter";

export interface MedicationFilterRailProps {
  searchText: string;
  onSearchChange: (value: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  category: string;
  onCategoryChange: (category: string) => void;
  categoryOptions: FilterBarSelectOption[];
  canManageCategories?: boolean;
  onOpenManageCategories?: () => void;
  showCategoryFilter?: boolean;
  fromDay: string;
  toDay: string;
  onFromDayChange: (from: string) => void;
  onToDayChange: (to: string) => void;
  onResetFilters: () => void;
  isFiltered: boolean;
  total?: number;
}

export function MedicationFilterRail({
  searchText,
  onSearchChange,
  searchInputRef,
  category,
  onCategoryChange,
  categoryOptions,
  canManageCategories = false,
  onOpenManageCategories,
  showCategoryFilter = true,
  fromDay,
  toDay,
  onFromDayChange,
  onToDayChange,
  onResetFilters,
  isFiltered,
  total,
}: MedicationFilterRailProps) {
  const { t, tCount } = useTranslations();
  const fmt = useFormatters();
  const isReversed = fromDay !== "" && toDay !== "" && fromDay > toDay;

  return (
    <div
      data-slot="medication-filter-rail"
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
          value={searchText}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t("medications.filter.searchPlaceholder")}
          aria-label={t("medications.filter.searchLabel")}
          aria-keyshortcuts="/"
          className="w-full min-w-0 pr-11 pl-9 [&::-webkit-search-cancel-button]:appearance-none"
        />
        {searchText === "" ? (
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
              searchInputRef.current?.focus();
            }}
            aria-label={t("medications.filter.clearSearch")}
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
              ? tCount("medications.filter.count", total, {
                  count: fmt.integer(total),
                })
              : undefined
          }
        >
          <FilterBarDateRange
            label={t("medications.filter.treatmentPeriod")}
            from={fromDay}
            to={toDay}
            onFromChange={onFromDayChange}
            onToChange={onToDayChange}
            idPrefix="medications-filter-date"
          />

          {showCategoryFilter && (
            <>
              <FilterBarSelect
                label={t("medications.category.filter.label")}
                value={category}
                onValueChange={onCategoryChange}
                options={categoryOptions}
                allValue={ALL_MEDICATION_CATEGORIES}
                allLabel={t("medications.category.filter.all")}
              />

              {canManageCategories && onOpenManageCategories && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground min-h-11 shrink-0 rounded-full sm:min-h-9"
                  onClick={onOpenManageCategories}
                  data-slot="medication-categories-manage"
                >
                  {t("medications.category.custom.manage")}
                </Button>
              )}
            </>
          )}
        </FilterBar>
        {isReversed && (
          <p
            role="alert"
            data-slot="medication-filter-date-error"
            className="text-destructive mt-2 text-xs font-medium"
          >
            {t("medications.course.error.invalidRange")}
          </p>
        )}
      </div>
    </div>
  );
}
