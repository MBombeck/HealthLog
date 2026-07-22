"use client";

import { useQuery } from "@tanstack/react-query";

import { apiFetchRaw } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { InjectionSiteKey } from "@/lib/medications/injection-sites";

/**
 * v1.8.5 — read the user's global injection-site exclusion deny-list.
 *
 * Shared by every surface that constrains the injection-site picker: the
 * post-dose log dialog, the per-medication allowed-sites editor, and the
 * Settings exclusion editor. Cached generously — the value changes rarely
 * and the mutation invalidates `injectionSitePrefs()`.
 */
export function useGlobalExcludedInjectionSites(): InjectionSiteKey[] {
  const { data } = useQuery({
    queryKey: queryKeys.injectionSitePrefs(),
    queryFn: async () => {
      const res = await apiFetchRaw("/api/auth/me/injection-site-prefs");
      if (!res.ok) return [] as InjectionSiteKey[];
      const json = await res.json();
      return (json.data?.globalExcludedInjectionSites ??
        []) as InjectionSiteKey[];
    },
    staleTime: 5 * 60 * 1000,
  });
  return data ?? [];
}
