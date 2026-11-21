"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { DEFAULT_SNOOZE_MINUTES } from "@/lib/medications/snooze-length";

/**
 * The person's snooze length in minutes ("Remind me later"), from the
 * roaming notification prefs every client shares. The default stands in
 * while the prefs load, so a label never waits for it.
 */
export function useSnoozeMinutes(enabled = true): number {
  const { data } = useQuery({
    queryKey: queryKeys.authNotificationPrefs(),
    queryFn: () =>
      apiGet<{ medication?: { snoozeMinutes?: number } }>(
        "/api/auth/me/notification-prefs",
      ),
    enabled,
    staleTime: 5 * 60_000,
  });
  return data?.medication?.snoozeMinutes ?? DEFAULT_SNOOZE_MINUTES;
}
