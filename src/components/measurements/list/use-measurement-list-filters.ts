"use client";

import { useEffect, useState } from "react";

import { useTableSort } from "@/hooks/use-table-sort";
import { useUrlFilterSync } from "@/hooks/use-url-filter-sync";

import {
  measurementListFiltersToSearch,
  numericInputOrUndefined,
  parseMeasurementListSearchParams,
} from "../measurement-list-filters";

import {
  CUMULATIVE_TYPES,
  MEASUREMENT_DESC_COLUMNS,
  dayBoundaryIso,
} from "./list-model";

/**
 * The list's view state: the filters, the page, the sort and the page-scoped
 * selection, and what the read derives from them.
 *
 * Filters are URL-owned (`?type&source&from&to&min&max`, the documents-vault
 * pattern), so a filtered view survives navigation, reload and back/forward,
 * and the `?type=` deep links simply are the filter state. With `lockedType`
 * the list is pinned to one metric, the URL belongs to the page around it,
 * and the remaining filters stay in memory.
 *
 * Every filter, page or sort change resets to page 1 and clears the
 * selection, whose rows are about to unmount; the selection never reaches
 * past the painted page.
 */
export function useMeasurementListFilters(lockedType: string | undefined) {
  const { filters, applyFilters, patchFilters } = useUrlFilterSync({
    parse: parseMeasurementListSearchParams,
    serialise: measurementListFiltersToSearch,
    syncToUrl: lockedType === undefined,
  });
  const typeFilter = lockedType ?? filters.type ?? "ALL";
  // `ALL` clears the source filter; an empty date string clears its bound.
  const sourceFilter = filters.source ?? "ALL";
  const fromDay = filters.fromDay ?? "";
  const toDay = filters.toDay ?? "";
  // The value-range inputs fire per keystroke, so they edit a local draft
  // that debounces into the URL (200 ms, replace: never a history entry per
  // keystroke); an external URL change (back button, deep link) re-seeds the
  // draft through the render-phase adjustment below, like the vault's search.
  const urlValueRange = `${filters.valueMin ?? ""}\u0000${filters.valueMax ?? ""}`;
  const [valueDraft, setValueDraft] = useState(() => ({
    min: filters.valueMin ?? "",
    max: filters.valueMax ?? "",
  }));
  const [lastUrlValueRange, setLastUrlValueRange] = useState(urlValueRange);
  if (urlValueRange !== lastUrlValueRange) {
    setLastUrlValueRange(urlValueRange);
    setValueDraft({
      min: filters.valueMin ?? "",
      max: filters.valueMax ?? "",
    });
  }
  const [page, setPage] = useState(1);
  // Shared column-sort state (measuredAt opens descending).
  const {
    sortBy,
    sortDir,
    toggleSort: applySort,
  } = useTableSort({
    defaultColumn: "measuredAt",
    defaultDir: "desc",
    descColumns: MEASUREMENT_DESC_COLUMNS,
  });

  // The ids selected on the CURRENT page. Every read intersects it with the
  // painted page, so the bulk payload is page-bounded (at most a page, well
  // under the server's cap of 200) and an id that falls off the page after
  // a refetch simply stops counting.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const clearSelection = () => setSelectedIds(new Set());

  // Discrete facet changes push (Back steps through filter states, like the
  // vault's chips); the committed date bounds replace, so a from/to pair set
  // in one sitting does not cost two Back presses.
  const resetPage = () => {
    setPage(1);
    clearSelection();
  };
  const setTypeFilter = (value: string) => {
    patchFilters({ type: value === "ALL" ? undefined : value });
    resetPage();
  };
  const setSourceFilter = (value: string) => {
    patchFilters({ source: value === "ALL" ? undefined : value });
    resetPage();
  };
  const setFromDay = (value: string) => {
    patchFilters({ fromDay: value || undefined }, "replace");
    resetPage();
  };
  const setToDay = (value: string) => {
    patchFilters({ toDay: value || undefined }, "replace");
    resetPage();
  };
  const setValueMinInput = (value: string) => {
    setValueDraft((prev) => ({ ...prev, min: value }));
    resetPage();
  };
  const setValueMaxInput = (value: string) => {
    setValueDraft((prev) => ({ ...prev, max: value }));
    resetPage();
  };
  // One push clears every facet (and so one Back restores them); the value
  // draft is cleared directly, since a bound that never reached the URL has
  // no change to re-seed from.
  const resetFilters = () => {
    applyFilters({});
    setValueDraft({ min: "", max: "" });
    resetPage();
  };

  // The draft debounces into the URL; a bound that does not normalise to a
  // finite number never reaches it (non-numeric input means "unset").
  useEffect(() => {
    const handle = setTimeout(() => {
      const min = numericInputOrUndefined(valueDraft.min);
      const max = numericInputOrUndefined(valueDraft.max);
      if (
        (min ?? "") === (filters.valueMin ?? "") &&
        (max ?? "") === (filters.valueMax ?? "")
      ) {
        return;
      }
      patchFilters({ valueMin: min, valueMax: max }, "replace");
    }, 200);
    return () => clearTimeout(handle);
  }, [valueDraft, filters, patchFilters]);

  const goToPage = (updater: (p: number) => number) => {
    setPage(updater);
    clearSelection();
  };

  // The rows re-order and the list snaps back to page 1.
  function toggleSort(column: string) {
    applySort(column);
    resetPage();
  }

  // A cumulative type (steps, active energy, distance, flights, daylight)
  // collapses to one row per profile-zone day through the route's
  // `groupBy=day` mode, never listing per-sample chunks by default; sleep
  // collapses server-side to one row per night (time asleep). Both page
  // server-side over their synthesised rows.
  const isCumulativeFilter = CUMULATIVE_TYPES.has(typeFilter);
  const isSleepFilter = typeFilter === "SLEEP_DURATION";
  const isDayGroupedFilter = isCumulativeFilter || isSleepFilter;

  const fromIso = dayBoundaryIso(fromDay, "start");
  const toIso = dayBoundaryIso(toDay, "end");
  const sourceEq = sourceFilter === "ALL" ? undefined : sourceFilter;
  // The value range applies to the raw per-sample list only: a day sum or a
  // night total is not a raw `value`, so its pill is hidden for those types.
  const valueMin =
    filters.valueMin !== undefined ? Number(filters.valueMin) : undefined;
  const valueMax =
    filters.valueMax !== undefined ? Number(filters.valueMax) : undefined;
  const listMode: "raw" | "groupBy=day" | "sleep-night" = isSleepFilter
    ? "sleep-night"
    : isCumulativeFilter
      ? "groupBy=day"
      : "raw";

  return {
    typeFilter,
    sourceFilter,
    fromDay,
    toDay,
    valueMinInput: valueDraft.min,
    valueMaxInput: valueDraft.max,
    page,
    sortBy,
    sortDir,
    selectedIds,
    setSelectedIds,
    clearSelection,
    setTypeFilter,
    setSourceFilter,
    setFromDay,
    setToDay,
    setValueMinInput,
    setValueMaxInput,
    resetFilters,
    goToPage,
    toggleSort,
    isCumulativeFilter,
    isDayGroupedFilter,
    fromIso,
    toIso,
    sourceEq,
    valueMin,
    valueMax,
    listMode,
  };
}

export type MeasurementListFilters = ReturnType<
  typeof useMeasurementListFilters
>;
