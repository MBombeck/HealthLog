"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { InjectionSiteKey } from "@/lib/medications/injection-sites";

/**
 * The stored deny-list, read fresh. A failed read throws: the Settings editor
 * writes the whole list back on every toggle, so a read that answered `[]`
 * for an error let one click replace every exclusion the account had.
 */
export async function fetchGlobalExcludedInjectionSites(): Promise<
  InjectionSiteKey[]
> {
  const data = await apiGet<{
    globalExcludedInjectionSites?: InjectionSiteKey[];
  }>("/api/auth/me/injection-site-prefs");
  return data?.globalExcludedInjectionSites ?? [];
}

/** One query for every surface that reads the list, so the cache is shared. */
export const injectionSitePrefsQuery = {
  queryKey: queryKeys.injectionSitePrefs(),
  queryFn: fetchGlobalExcludedInjectionSites,
  staleTime: 5 * 60 * 1000,
};

/**
 * v1.8.5 — read the user's global injection-site exclusion deny-list.
 *
 * Shared by every surface that constrains the injection-site picker: the
 * post-dose log dialog, the per-medication allowed-sites editor, and the
 * Settings exclusion editor. Cached generously — the value changes rarely
 * and the mutation invalidates `injectionSitePrefs()`. The pickers treat a
 * failed read as no exclusions (intake enforces the list server-side).
 */
export function useGlobalExcludedInjectionSites(): InjectionSiteKey[] {
  const { data } = useQuery(injectionSitePrefsQuery);
  return data ?? [];
}
