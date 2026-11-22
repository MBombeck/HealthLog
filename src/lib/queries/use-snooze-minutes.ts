"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { DEFAULT_SNOOZE_MINUTES } from "@/lib/medications/snooze-length";

/** The roaming notification prefs read the snooze length lives in. */
export function useSnoozePrefsQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.authNotificationPrefs(),
    queryFn: () =>
      apiGet<{ medication?: { snoozeMinutes?: number } }>(
        "/api/auth/me/notification-prefs",
      ),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/**
 * The person's snooze length in minutes ("Remind me later"), from the
 * roaming notification prefs every client shares. The default stands in
 * while the prefs load, so a label never waits for it. Not for the setting
 * itself: the card that edits the value reads `useSnoozePrefsQuery` and
 * shows a failed read as one, never the default as if it were stored.
 */
export function useSnoozeMinutes(enabled = true): number {
  const { data } = useSnoozePrefsQuery(enabled);
  return data?.medication?.snoozeMinutes ?? DEFAULT_SNOOZE_MINUTES;
}
