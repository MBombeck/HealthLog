"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { RecoveryKit } from "@/lib/recovery/kit-rules";

export type {
  KitKey,
  KitPlatform,
  RecoveryKit,
} from "@/lib/recovery/kit-rules";

/**
 * `GET /api/admin/recovery-kit`: key ids and fingerprints only. `enabled` lets
 * the dashboard banner ask only for an admin; the route itself is admin-only
 * and cookie-only.
 */
export function useRecoveryKit(enabled = true) {
  return useQuery({
    queryKey: queryKeys.adminRecoveryKit(),
    queryFn: () =>
      apiGet<RecoveryKit>("/api/admin/recovery-kit", {
        credentials: "include",
      }),
    enabled,
    staleTime: 60_000,
  });
}
