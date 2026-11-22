"use client";

/**
 * The quiet counts on two navigation entries (#1113): doses due on
 * Medications, check-ups due on Checkups, shown only above zero.
 *
 * One cheap read for both, `GET /api/nav/counts`, whose dose count is the dose
 * resolver's own answer and whose check-up count is the digest rail's rule
 * (`src/lib/navigation/nav-counts.ts`). The sidebar and the More sheet share
 * the cached answer; every dose write and every check-up write evicts it
 * (`queryKeys.navCounts()` in the dependent-key sets). Inside somebody else's
 * record no count is shown and nothing is asked.
 */
import { useQuery } from "@tanstack/react-query";

import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { apiGet } from "@/lib/api/api-fetch";
import type { NavCounts } from "@/lib/navigation/nav-counts";
import { queryKeys } from "@/lib/query-keys";

/** The count per navigation href, for the entries that carry one. */
export function navCountsByHref(
  counts: NavCounts | undefined,
): Record<string, number> {
  if (!counts) return {};
  return { "/medications": counts.dosesDue, "/checkups": counts.checkupsDue };
}

export function useNavCounts(enabled: boolean): Record<string, number> {
  const { inSharedRecord } = useRecordCapabilities();
  const active = enabled && !inSharedRecord;
  const counts = useQuery({
    queryKey: queryKeys.navCounts(),
    queryFn: () => apiGet<NavCounts>("/api/nav/counts"),
    enabled: active,
    staleTime: 60_000,
  });
  return active ? navCountsByHref(counts.data) : {};
}
