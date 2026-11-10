"use client";

/**
 * Per-list presentation for the labs, illness and checkups lists: card or
 * list view, a manual order, and (labs only) the sort and the categories.
 *
 * The choices live on the server (`GET/PUT /api/settings/module-list-layout`,
 * `User.moduleListLayoutJson`) so they follow a person to every device. Until
 * v1.44 they lived in this browser's `localStorage`, one key per list. Those
 * values are carried over, never reset: when the server holds nothing for a
 * list and this browser still has a value, the value is sent up once and the
 * browser copy is removed after the server confirmed it. While the first read
 * is in flight the browser copy (or the default) paints, so a person who
 * arranged a list does not see it jump back to the default order.
 *
 * The choice is presentational only: it reorders or reshapes what the page
 * already fetched, so a missing or stale value degrades to the server order.
 */

import { useCallback, useEffect, useMemo } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { useMounted } from "@/hooks/use-mounted";
import { apiGet, apiPut } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  isModuleListView,
  isModuleSortDir,
  moduleListDefaults,
  normaliseModuleListOrder,
  resolveModuleListLayout,
  type ModuleListKey,
  type ModuleListLayout,
  type ModuleListPrefs,
  type ModuleGroupBy,
  type ModuleGroupsOpen,
  type ModuleListView,
  type ModuleSortDir,
} from "@/lib/settings/module-list-layout";

export type {
  ModuleGroupBy,
  ModuleGroupsOpen,
  ModuleListKey,
  ModuleListPrefs,
  ModuleListView,
  ModuleSortDir,
} from "@/lib/settings/module-list-layout";

const ENDPOINT = "/api/settings/module-list-layout";

/** The browser key earlier releases stored a list's choices under. */
export function legacyModuleListStorageKey(list: ModuleListKey): string {
  return `healthlog:module-list-prefs:${list}`;
}

/**
 * Parse a browser-stored blob from before the server column. Anything
 * malformed collapses onto the defaults field by field. The browser never
 * held the category fields, so those always come from the defaults.
 */
export function parseModuleListPrefs(
  raw: string | null,
  defaults: ModuleListPrefs,
): ModuleListPrefs {
  if (!raw) return defaults;
  try {
    const blob = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...defaults,
      view: isModuleListView(blob.view) ? blob.view : defaults.view,
      order: normaliseModuleListOrder(blob.order) ?? [],
      sortDir: isModuleSortDir(blob.sortDir) ? blob.sortDir : defaults.sortDir,
    };
  } catch {
    return defaults;
  }
}

/**
 * The fields of a browser-stored value worth carrying over: the ones that
 * differ from the default. The old blob always held all three fields, so a
 * field equal to the default cannot be told apart from one never chosen and
 * is left to follow the default.
 */
export function legacyModuleListPatch(
  list: ModuleListKey,
  raw: string | null,
): Partial<ModuleListPrefs> {
  if (!raw) return {};
  const defaults = moduleListDefaults(list);
  const legacy = parseModuleListPrefs(raw, defaults);
  return {
    ...(legacy.view !== defaults.view ? { view: legacy.view } : {}),
    ...(legacy.order.length > 0 ? { order: legacy.order } : {}),
    ...(legacy.sortDir !== defaults.sortDir ? { sortDir: legacy.sortDir } : {}),
  };
}

/**
 * Apply a persisted id order to a live list. Items whose id appears in
 * `order` come first in that order; everything else keeps the input order
 * (the server default) after the ordered block. Ids in `order` but absent
 * from the data are silently dropped.
 */
export function applyOrder<T>(
  items: readonly T[],
  order: readonly string[],
  idOf: (item: T) => string,
): T[] {
  if (order.length === 0) return [...items];
  const rank = new Map(order.map((id, i) => [id, i]));
  const ordered: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    if (rank.has(idOf(item))) ordered.push(item);
    else rest.push(item);
  }
  ordered.sort((a, b) => rank.get(idOf(a))! - rank.get(idOf(b))!);
  return [...ordered, ...rest];
}

function readLegacy(list: ModuleListKey): string | null {
  try {
    return window.localStorage.getItem(legacyModuleListStorageKey(list));
  } catch {
    return null;
  }
}

function removeLegacy(list: ModuleListKey): void {
  try {
    window.localStorage.removeItem(legacyModuleListStorageKey(list));
  } catch {
    // Storage unavailable: nothing to remove.
  }
}

/** Lists already carried over (or checked) in this page load. */
const carriedOver = new Set<ModuleListKey>();

/**
 * Carry a browser-stored value up to the server, once, when the server holds
 * nothing for the list. A failed write leaves the browser copy in place and
 * tries again on the next mount; a list the server already holds keeps the
 * server value and drops the stale browser copy.
 */
export async function carryOverLegacyModuleListPrefs(deps: {
  list: ModuleListKey;
  layout: ModuleListLayout;
  queryClient: QueryClient;
}): Promise<void> {
  const { list, layout, queryClient } = deps;
  if (typeof window === "undefined" || carriedOver.has(list)) return;
  carriedOver.add(list);
  const raw = readLegacy(list);
  if (raw === null) return;
  if (layout.lists[list].saved) {
    removeLegacy(list);
    return;
  }
  const patch = legacyModuleListPatch(list, raw);
  if (Object.keys(patch).length === 0) {
    removeLegacy(list);
    return;
  }
  try {
    const saved = await apiPut<ModuleListLayout>(ENDPOINT, {
      version: 1,
      list,
      ...patch,
    });
    if (saved) queryClient.setQueryData(queryKeys.moduleListLayout(), saved);
    removeLegacy(list);
  } catch {
    carriedOver.delete(list);
  }
}

/** Forget which lists were carried over. Tests only. */
export function resetModuleListCarryOverForTests(): void {
  carriedOver.clear();
}

type Translator = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/**
 * Apply one field optimistically (the control has to feel instant), then
 * persist it. On failure the cache rolls back and a toast says so; a view or
 * sort change confirms with a toast, an order change is its own feedback.
 */
export async function runSetModuleListPrefs(deps: {
  list: ModuleListKey;
  patch: Partial<ModuleListPrefs>;
  queryClient: QueryClient;
  t: Translator;
}): Promise<void> {
  const { list, patch, queryClient, t } = deps;
  const key = queryKeys.moduleListLayout();
  if (queryClient.isFetching({ queryKey: key }) > 0) {
    await queryClient.cancelQueries({ queryKey: key });
  }
  const previous = queryClient.getQueryData<ModuleListLayout>(key);
  const base = previous ?? resolveModuleListLayout(null);
  queryClient.setQueryData<ModuleListLayout>(key, {
    ...base,
    lists: {
      ...base.lists,
      [list]: { ...base.lists[list], ...patch, saved: true },
    },
  });
  try {
    const saved = await apiPut<ModuleListLayout>(ENDPOINT, {
      version: 1,
      list,
      ...patch,
    });
    if (saved) queryClient.setQueryData(key, saved);
    if (
      patch.view !== undefined ||
      patch.sortDir !== undefined ||
      patch.groupBy !== undefined ||
      patch.groupsOpen !== undefined
    ) {
      toastWrittenOutcome("success", t("settings.saved"));
    }
  } catch (failure) {
    queryClient.setQueryData(key, previous);
    showErrorToast(t("settings.savingError"), { cause: failure });
  }
}

/**
 * Read + write one list's presentation. The server value once it is read;
 * before that, the browser copy from an earlier release, or the default.
 */
export function useModuleListPrefs(list: ModuleListKey): {
  prefs: ModuleListPrefs;
  isLoaded: boolean;
  setView: (view: ModuleListView) => void;
  setOrder: (order: string[]) => void;
  setSortDir: (sortDir: ModuleSortDir) => void;
  setGroupBy: (groupBy: ModuleGroupBy) => void;
  setGroupsOpen: (groupsOpen: ModuleGroupsOpen) => void;
} {
  const queryClient = useQueryClient();
  const { t } = useTranslations();

  const { data } = useQuery({
    queryKey: queryKeys.moduleListLayout(),
    queryFn: () => apiGet<ModuleListLayout>(ENDPOINT),
    staleTime: 5 * 60 * 1000,
  });

  const isLoaded = data !== undefined;

  useEffect(() => {
    if (!data) return;
    void carryOverLegacyModuleListPrefs({ list, layout: data, queryClient });
  }, [data, list, queryClient]);

  // The browser copy is read only after hydration, so the server render and
  // the first client paint agree (React #418). While the server entry is
  // unsaved (saved: false), the browser copy is preferred until carry-over
  // completes and a saved server entry arrives.
  const mounted = useMounted();
  const entry = data?.lists[list];
  const prefs = useMemo<ModuleListPrefs>(() => {
    if (entry?.saved) {
      return {
        view: entry.view,
        order: entry.order,
        sortDir: entry.sortDir,
        groupBy: entry.groupBy,
        groupsOpen: entry.groupsOpen,
      };
    }
    const defaults = moduleListDefaults(list);
    const fallback: ModuleListPrefs = entry
      ? {
          view: entry.view,
          order: entry.order,
          sortDir: entry.sortDir,
          groupBy: entry.groupBy,
          groupsOpen: entry.groupsOpen,
        }
      : defaults;
    if (!mounted) return fallback;
    const legacy = readLegacy(list);
    if (legacy !== null) {
      return parseModuleListPrefs(legacy, fallback);
    }
    return fallback;
  }, [entry, list, mounted]);

  const write = useCallback(
    (patch: Partial<ModuleListPrefs>) =>
      void runSetModuleListPrefs({ list, patch, queryClient, t }),
    [list, queryClient, t],
  );

  const setView = useCallback(
    (view: ModuleListView) => write({ view }),
    [write],
  );
  const setOrder = useCallback((order: string[]) => write({ order }), [write]);
  const setSortDir = useCallback(
    (sortDir: ModuleSortDir) => write({ sortDir }),
    [write],
  );

  const setGroupBy = useCallback(
    (groupBy: ModuleGroupBy) => write({ groupBy }),
    [write],
  );
  const setGroupsOpen = useCallback(
    (groupsOpen: ModuleGroupsOpen) => write({ groupsOpen }),
    [write],
  );

  return {
    prefs,
    isLoaded,
    setView,
    setOrder,
    setSortDir,
    setGroupBy,
    setGroupsOpen,
  };
}
