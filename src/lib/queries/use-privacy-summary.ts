"use client";

/**
 * The privacy facts the server states (`GET /api/settings/privacy-summary`):
 * the retention windows, the deletion grace window and the encryption-at-rest
 * summary. One reader for every surface that quotes them, so the privacy page
 * and the deletion dialogs share one cache entry with one shape.
 */
import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";

export interface PrivacySummary {
  retention: {
    coachMessagesDays: number;
    auditLogDays: number;
    deliveryLogDays: number;
    /** Days until an account, profile or wipe deletion completes; 0: at once. */
    accountDeletionGraceDays: number;
  };
  encryption: {
    algorithm: string;
    columnCount: number;
    modelCount: number;
  };
}

export function usePrivacySummary() {
  const { isAuthenticated } = useAuth();
  return useQuery({
    queryKey: queryKeys.privacySummary(),
    queryFn: () => apiGet<PrivacySummary>("/api/settings/privacy-summary"),
    enabled: isAuthenticated,
  });
}

/**
 * The deletion grace window in days, or null while it is not known (still
 * loading, or the read failed): a dialog that states it must not guess.
 * `pending` is true only while the first read is in flight, so a control can
 * wait for the number instead of showing a sentence it would then change.
 */
export function useAccountDeletionGrace(): {
  days: number | null;
  pending: boolean;
} {
  const { data, isPending, isError } = usePrivacySummary();
  return {
    days: data?.retention.accountDeletionGraceDays ?? null,
    pending: isPending && !isError,
  };
}
