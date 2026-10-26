"use client";

import { useEffect, useRef, useState } from "react";

import { useUrlFilterSync } from "@/hooks/use-url-filter-sync";
import type { InboundDocumentKindValue } from "@/lib/validations/inbound-documents";

import { parseVaultSearchParams, vaultFiltersToSearch } from "../vault-utils";

/**
 * The vault's URL-owned filter state (`?q&kind&episode&encounter&year`), so
 * every view is shareable, back-button-safe and deep-linkable. The search
 * draft debounces into the URL and `/` focuses it from anywhere on the page.
 */
export function useVaultFilters() {
  // The parse/serialise round trip stays in `vault-utils.ts`; the router
  // plumbing lives in the shared hook (which the measurements and mood
  // lists reuse — this surface is the pattern's origin).
  const { filters, applyFilters } = useUrlFilterSync({
    parse: parseVaultSearchParams,
    serialise: vaultFiltersToSearch,
  });

  // Search draft debounces into the URL (200 ms); an external URL change
  // (back button, deep link) re-seeds the draft — render-phase derived-state
  // adjustment, not an effect.
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
      // Live filters, not the rendered ones a "Clear filters" just removed.
      applyFilters(
        (current) =>
          trimmed === (current.q ?? "")
            ? current
            : { ...current, q: trimmed === "" ? undefined : trimmed },
        "replace",
      );
    }, 200);
    return () => clearTimeout(handle);
  }, [searchDraft, filters, applyFilters]);

  // `/` focuses the search from anywhere on the page.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey)
        return;
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

  // Every facet toggles against the live filters (`applyFilters` updater).
  const toggleKind = (kind: InboundDocumentKindValue) => {
    applyFilters((current) => {
      const kinds = new Set(current.kinds ?? []);
      if (kinds.has(kind)) kinds.delete(kind);
      else kinds.add(kind);
      return {
        ...current,
        kinds: kinds.size > 0 ? [...kinds].sort() : undefined,
      };
    }, "push");
  };

  const toggleEpisode = (episodeId: string) => {
    applyFilters(
      (current) => ({
        ...current,
        episodeId: current.episodeId === episodeId ? undefined : episodeId,
      }),
      "push",
    );
  };

  const toggleEncounter = (encounterId: string) => {
    applyFilters(
      (current) => ({
        ...current,
        encounterId:
          current.encounterId === encounterId ? undefined : encounterId,
      }),
      "push",
    );
  };

  const toggleYear = (year: number) => {
    applyFilters(
      (current) => ({
        ...current,
        year: current.year === year ? undefined : year,
      }),
      "push",
    );
  };

  const clearFilters = () => {
    setSearchDraft("");
    applyFilters({}, "push");
  };

  return {
    filters,
    searchDraft,
    setSearchDraft,
    searchInputRef,
    toggleKind,
    toggleEpisode,
    toggleEncounter,
    toggleYear,
    clearFilters,
  };
}

export type VaultFilters = ReturnType<typeof useVaultFilters>;
