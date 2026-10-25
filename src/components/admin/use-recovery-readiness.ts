"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { RecoveryReadiness } from "@/lib/recovery/readiness-model";

export type {
  ReadinessSignal,
  ReadinessState,
  RecoveryReadiness,
} from "@/lib/recovery/readiness-model";

/** `GET /api/admin/recovery-readiness`; admin-only and cookie-only. */
export function useRecoveryReadiness() {
  return useQuery({
    queryKey: queryKeys.adminRecoveryReadiness(),
    queryFn: () =>
      apiGet<RecoveryReadiness>("/api/admin/recovery-readiness", {
        credentials: "include",
      }),
    staleTime: 60_000,
  });
}
