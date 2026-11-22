"use client";

/**
 * The quiet counts on two navigation entries (#1113): doses due on
 * Medications, check-ups due on Checkups. Shown only when above zero, nowhere
 * else.
 *
 * No new request for either. The doses are read from the today list the
 * medication cards already hold (`GET /api/medications/intake?scope=today`,
 * which projects the day's rows and is too heavy to ask for on every page):
 * the observer here never fetches, so the count appears once a page that
 * shows doses has loaded them and follows that cache from then on. The
 * check-ups are the reminder list the dashboard tile and the checkups page
 * read (`GET /api/measurement-reminders`), a short list shared through the
 * same cache key.
 */
import { useQuery } from "@tanstack/react-query";

import type { TodayDoseRow } from "@/components/medications/card-parts/use-dose-snooze";
import { useMeasurementReminders } from "@/hooks/use-measurement-reminders";
import { apiGet } from "@/lib/api/api-fetch";
import { useDisplayTimezone } from "@/lib/i18n/context";
import {
  isDueNowDue,
  relativeDueKey,
} from "@/lib/measurement-reminders/due-day";
import { queryKeys } from "@/lib/query-keys";

/** Doses whose window is open or past and not yet answered. */
export function dosesDueCount(
  rows: ReadonlyArray<Pick<TodayDoseRow, "state">> | undefined,
): number {
  return (rows ?? []).filter(
    (row) => row.state === "due" || row.state === "overdue",
  ).length;
}

/** Check-ups due today or overdue, not paused and not snoozed. */
export function checkupsDueCount(
  reminders:
    | ReadonlyArray<{
        enabled: boolean;
        nextDueAt: string | null;
        snoozedUntil: string | null;
      }>
    | undefined,
  now: number,
  timeZone: string,
): number {
  return (reminders ?? []).filter((r) => {
    if (!r.enabled) return false;
    if (r.snoozedUntil && Date.parse(r.snoozedUntil) > now) return false;
    return isDueNowDue(relativeDueKey(r.nextDueAt, now, timeZone));
  }).length;
}

/** The count per navigation href, only for entries that carry one. */
export function useNavCounts(enabled: boolean): Record<string, number> {
  const timeZone = useDisplayTimezone();
  const doses = useQuery({
    queryKey: queryKeys.medicationIntakeToday(),
    queryFn: () =>
      apiGet<TodayDoseRow[]>("/api/medications/intake?scope=today"),
    // Read-only observer of the cards' cache: never fetches on its own.
    enabled: false,
  });
  const reminders = useMeasurementReminders(enabled);
  if (!enabled) return {};
  return {
    "/medications": dosesDueCount(doses.data),
    // Due as of the moment the list was read, the clock the list is true at.
    "/checkups": checkupsDueCount(
      reminders.data,
      reminders.dataUpdatedAt,
      timeZone,
    ),
  };
}
