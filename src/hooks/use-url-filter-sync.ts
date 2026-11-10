"use client";

import { useCallback, useMemo, useState } from "react";

import { setAllParams, useUrlSearch, writeUrlState } from "@/lib/url-state";

/**
 * URL-owned filter state — the documents-vault pattern
 * (`src/components/documents/documents-view.tsx`), extracted so the
 * measurements and mood management lists carry the same contract: the page's
 * filter object is parsed from the live query string and every change writes
 * the serialised form back through the router, so a filtered view survives
 * navigation, reload, back/forward and sharing.
 *
 * `parse` and `serialise` must be inverse, module-level functions (stable
 * identities): round-tripping is what keeps a deep link and the UI agreeing,
 * and `serialise` omits defaults so the unfiltered view keeps a bare URL.
 *
 * Mode grammar (matching the vault): a discrete facet change (`push`, the
 * default) creates a history entry so Back steps through filter states, like
 * the vault's kind/year chips; high-frequency typed input passes `replace` so
 * the history never fills with keystrokes, like the vault's debounced search.
 *
 * Reads and writes go through `@/lib/url-state`: the filters parse from the
 * live address bar, and `applyFilters` takes either the next filters or an
 * updater that receives the live ones at the moment of the write. A change
 * computed from a rendered copy wrote the previous filters back when Next
 * adopted an earlier write a render late (clearing the vault's filters left
 * `?encounter=` behind).
 *
 * `syncToUrl: false` keeps the identical contract in component memory only —
 * for a list embedded under a URL that belongs to another surface (the
 * type-locked insights readings subpage).
 */
export interface UrlFilterSyncOptions {
  /** A new history entry (`push`) or the current one rewritten (`replace`). */
  mode?: "push" | "replace";
  /** Wait two painted frames before writing (a write made while mounting). */
  afterPaint?: boolean;
}

export function useUrlFilterSync<T>({
  parse,
  serialise,
  syncToUrl = true,
}: {
  parse: (params: URLSearchParams) => T;
  serialise: (filters: T) => string;
  syncToUrl?: boolean;
}): {
  filters: T;
  applyFilters: (
    next: T | ((current: T) => T),
    modeOrOptions?: "push" | "replace" | UrlFilterSyncOptions,
  ) => void;
  /** Merge `patch` into the live filters (the common facet change). */
  patchFilters: (
    patch: Partial<T>,
    modeOrOptions?: "push" | "replace" | UrlFilterSyncOptions,
  ) => void;
} {
  const params = useUrlSearch();

  const urlFilters = useMemo(() => parse(params), [parse, params]);

  // Memory-only fallback for `syncToUrl: false`. The hook always mounts both
  // sources (hooks are unconditional); only one is read.
  const [localFilters, setLocalFilters] = useState<T>(() =>
    parse(new URLSearchParams()),
  );

  const applyFilters = useCallback(
    (
      next: T | ((current: T) => T),
      modeOrOptions: "push" | "replace" | UrlFilterSyncOptions = "push",
    ) => {
      const options: UrlFilterSyncOptions =
        typeof modeOrOptions === "string"
          ? { mode: modeOrOptions }
          : modeOrOptions;
      const resolve = (current: T): T =>
        typeof next === "function" ? (next as (c: T) => T)(current) : next;
      if (!syncToUrl) {
        setLocalFilters(resolve);
        return;
      }
      writeUrlState(
        (live) => {
          const search = serialise(resolve(parse(live)));
          setAllParams(search)(live);
        },
        { mode: options.mode ?? "push", afterPaint: options.afterPaint },
      );
    },
    [syncToUrl, serialise, parse],
  );

  const patchFilters = useCallback(
    (
      patch: Partial<T>,
      modeOrOptions: "push" | "replace" | UrlFilterSyncOptions = "push",
    ) => applyFilters((current) => ({ ...current, ...patch }), modeOrOptions),
    [applyFilters],
  );

  return {
    filters: syncToUrl ? urlFilters : localFilters,
    applyFilters,
    patchFilters,
  };
}
