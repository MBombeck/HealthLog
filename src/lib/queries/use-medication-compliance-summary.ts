"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { ComplianceDisplay } from "@/lib/analytics/compliance";

/**
 * One batched-summary row — the compact slice of the per-medication
 * compliance payload the cards render (rates, streak, the cadence-scaled
 * display block with `currentDose` / `currentCycle`). The heavy
 * `dailyCompliance` heatmap stays on the per-id endpoint the detail page
 * reads.
 */
export interface MedicationComplianceSummaryEntry {
  medicationId: string;
  applicable: boolean;
  notApplicableReason: "NO_LOCAL_SCHEDULE" | "INTAKE_NOT_TRACKED" | null;
  compliance7: { rate: number; streak: number };
  compliance30: { rate: number };
  complianceDisplay: ComplianceDisplay | null;
}

/**
 * v1.16.8 — the per-card compliance read, batched.
 *
 * Every medication card used to fire its own
 * `GET /api/medications/{id}/compliance` (N+1 over the grid, ~1 s cold
 * each). All cards now share ONE `GET /api/medications/compliance`
 * round trip under a single query key; each card `select`s its own row,
 * so a grid of mounted cards collapses into one request and one cache
 * entry. The key rides the `["medications"]` prefix, so every intake /
 * CRUD mutation that invalidates `medicationDependentKeys` refreshes it.
 *
 * Lives in one shared hook (not per-card `useQuery` calls) so the two
 * card variants can never register the same key with diverging fetch
 * shapes.
 *
 * Errors propagate — the queryFn deliberately does NOT catch. An earlier
 * revision swallowed failures to `null`, which froze every card on the
 * loading skeleton with no retry: the cached `null` looked like a
 * resolved success, so TanStack neither retried nor refetched. Letting
 * the rejection through restores the default retry/backoff, and `isError`
 * lets the cards swap the skeleton for a quiet same-footprint fallback
 * with a manual retry.
 */
/**
 * The ONE fetcher behind the shared summary key. Both hooks below (and
 * any future consumer) must ride this exact function so the key can
 * never be registered with diverging fetch shapes.
 */
function fetchComplianceSummary(): Promise<MedicationComplianceSummaryEntry[]> {
  return apiGet<MedicationComplianceSummaryEntry[]>(
    "/api/medications/compliance",
  );
}

export function useMedicationComplianceSummary(medicationId: string): {
  data: MedicationComplianceSummaryEntry | null | undefined;
  isError: boolean;
  refetch: () => void;
} {
  const { data, isError, refetch } = useQuery({
    queryKey: queryKeys.medicationComplianceSummary(),
    queryFn: fetchComplianceSummary,
    // Dose actions in this tab invalidate the key through
    // `medicationDependentKeys`. v1.16.12 (#316) — but a dose logged on
    // another surface (the iOS app) leaves this stale for up to the
    // window, so refetch on every mount: returning to the page reflects
    // cross-device intakes without a manual reload. The batched read is
    // one request per visit, server-cached.
    staleTime: 5 * 60 * 1000,
    refetchOnMount: "always",
    select: (rows: MedicationComplianceSummaryEntry[]) =>
      rows.find((row) => row.medicationId === medicationId) ?? null,
  });
  return { data, isError, refetch };
}

/**
 * v1.16.10 — the whole batched array, for consumers that need every
 * row at once (the table view's Therapietreue column sort). Same key,
 * same fetcher, no `select` — the per-row hook and this one share one
 * cache entry by construction.
 */
export function useMedicationComplianceSummaryAll(): {
  data: MedicationComplianceSummaryEntry[] | undefined;
} {
  const { data } = useQuery({
    queryKey: queryKeys.medicationComplianceSummary(),
    queryFn: fetchComplianceSummary,
    staleTime: 5 * 60 * 1000,
    // v1.16.12 (#316) — fresh on return-navigation (see the per-row hook).
    refetchOnMount: "always",
  });
  return { data };
}
