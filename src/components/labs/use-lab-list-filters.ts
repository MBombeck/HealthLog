"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useUrlFilterSync,
  type UrlFilterSyncOptions,
} from "@/hooks/use-url-filter-sync";
import type { ModuleSortDir } from "@/lib/settings/module-list-layout";
import {
  labListFiltersToSearch,
  parseLabListSearchParams,
  type LabListFilters,
  type LabStatusFilter,
} from "./lab-list-filters";

export function useLabListFilters({
  defaultSort = "recentDesc",
}: {
  defaultSort?: ModuleSortDir;
} = {}) {
  const serialise = useCallback(
    (f: LabListFilters) => labListFiltersToSearch(f, defaultSort),
    [defaultSort],
  );

  const { filters, applyFilters, patchFilters } =
    useUrlFilterSync<LabListFilters>({
      parse: parseLabListSearchParams,
      serialise,
    });

  // Debounced search draft
  const [searchDraft, setSearchDraft] = useState(filters.q ?? "");
  const [lastUrlQ, setLastUrlQ] = useState(filters.q ?? "");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  if ((filters.q ?? "") !== lastUrlQ) {
    setLastUrlQ(filters.q ?? "");
    setSearchDraft(filters.q ?? "");
  }

  useEffect(() => {
    const handle = setTimeout(() => {
      const trimmed = searchDraft.trim();
      if (trimmed === (filters.q ?? "")) return;
      applyFilters(
        (current) =>
          trimmed === (current.q ?? "")
            ? current
            : { ...current, q: trimmed === "" ? undefined : trimmed },
        "replace",
      );
    }, 200);
    return () => clearTimeout(handle);
  }, [searchDraft, filters.q, applyFilters]);

  // "/" focuses search input anywhere on the page
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const setStatusFilter = useCallback(
    (value: LabStatusFilter | "ALL") => {
      patchFilters({
        status: value === "ALL" ? undefined : value,
      });
    },
    [patchFilters],
  );

  const setCategoryFilter = useCallback(
    (
      value: string,
      modeOrOptions: "push" | "replace" | UrlFilterSyncOptions = "push",
    ) => {
      patchFilters(
        {
          category: value === "ALL" ? undefined : value,
        },
        modeOrOptions,
      );
    },
    [patchFilters],
  );

  const setFromDay = useCallback(
    (value: string) => {
      patchFilters({ fromDay: value || undefined }, "replace");
    },
    [patchFilters],
  );

  const setToDay = useCallback(
    (value: string) => {
      patchFilters({ toDay: value || undefined }, "replace");
    },
    [patchFilters],
  );

  const setSortFilter = useCallback(
    (
      value: ModuleSortDir,
      modeOrOptions: "push" | "replace" | UrlFilterSyncOptions = "push",
    ) => {
      patchFilters(
        {
          sort: value === defaultSort ? undefined : value,
        },
        modeOrOptions,
      );
    },
    [defaultSort, patchFilters],
  );

  const resetFilters = useCallback(() => {
    setSearchDraft("");
    applyFilters({});
  }, [applyFilters]);

  return {
    filters,
    searchDraft,
    setSearchDraft,
    searchInputRef,
    setStatusFilter,
    setCategoryFilter,
    setFromDay,
    setToDay,
    setSortFilter,
    resetFilters,
  };
}
