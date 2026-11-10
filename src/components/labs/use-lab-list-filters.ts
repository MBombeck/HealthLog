"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useUrlFilterSync,
  type UrlFilterSyncOptions,
} from "@/hooks/use-url-filter-sync";
import {
  labListFiltersToSearch,
  parseLabListSearchParams,
  type LabListFilters,
  type LabStatusFilter,
} from "./lab-list-filters";

export function useLabListFilters() {
  const { filters, applyFilters, patchFilters } =
    useUrlFilterSync<LabListFilters>({
      parse: parseLabListSearchParams,
      serialise: labListFiltersToSearch,
    });

  // The field edits a draft; the URL takes it, trimmed, 200 ms after the
  // last keystroke. A `q` the URL gains from elsewhere (back/forward, a
  // shared link, Reset) replaces the draft. One the draft wrote itself
  // does not: adopting it would drop a trailing space ("vitamin " became
  // "vitamin", and the next letter ran on), or a letter typed while the
  // write was landing.
  const urlQ = filters.q ?? "";
  const [searchDraft, setSearchDraft] = useState(urlQ);
  const [lastUrlQ, setLastUrlQ] = useState(urlQ);
  const [ownWrite, setOwnWrite] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  if (urlQ !== lastUrlQ) {
    setLastUrlQ(urlQ);
    if (urlQ === ownWrite) setOwnWrite(null);
    else if (urlQ !== searchDraft.trim()) setSearchDraft(urlQ);
  }

  useEffect(() => {
    const handle = setTimeout(() => {
      const trimmed = searchDraft.trim();
      if (trimmed === (filters.q ?? "")) return;
      setOwnWrite(trimmed);
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

  // "/" focuses the search field, unless the key is meant for something
  // else: a field being typed in, or an open dialog, menu or list whose
  // focus must not jump to the page behind it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.defaultPrevented ||
        event.isComposing
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable ||
          target.closest(
            '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
          ))
      ) {
        return;
      }
      // No field on screen (loading, an error, nothing recorded yet): the
      // key stays the browser's.
      const input = searchInputRef.current;
      if (!input || !input.isConnected) return;
      event.preventDefault();
      input.focus();
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
    resetFilters,
  };
}
