"use client";

import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

/**
 * The BMI view's divisor: the height of the record on screen, in metres,
 * squared. `useAuth()` is the person at the keyboard, and under a switch that
 * is the delegate, so inside somebody else's record the height comes from
 * `/api/insights/targets`, the route that knows which record is on screen
 * (the BMI page and the reference panel read the same cell). No height, no
 * BMI.
 */
export function useBmiDivisor(
  valueMode: "raw" | "bmi" | undefined,
): number | null {
  const { isAuthenticated, user } = useAuth();
  const { inSharedRecord } = useRecordCapabilities();
  const { data: targets } = useQuery({
    queryKey: queryKeys.insightsTargets(),
    queryFn: () =>
      apiGet<{ profile?: { heightCm: number | null } }>(
        "/api/insights/targets",
      ),
    enabled: isAuthenticated && valueMode === "bmi" && inSharedRecord,
  });
  if (valueMode !== "bmi") return null;
  const heightCm = inSharedRecord
    ? (targets?.profile?.heightCm ?? null)
    : (user?.heightCm ?? null);
  return heightCm ? (heightCm / 100) ** 2 : null;
}
