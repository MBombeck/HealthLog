"use client";

/**
 * Two pieces the detail page shares: the next dose in the card's phrasing
 * ("Today, 08:00"), and the reminder plan in words, which the reminder
 * phases sheet leads with.
 */

import { useQuery } from "@tanstack/react-query";

import { useWeekdayLabel } from "@/components/medications/card-parts/medication-next-last-slot";
import { useAuth } from "@/hooks/use-auth";
import { apiGet } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { resolveNextDueDayLabel } from "@/lib/medications/next-due-day-label";
import { queryKeys } from "@/lib/query-keys";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

/** "Today, 08:00", "Tomorrow, 08:00", "Mon, 08:00" or the date: the card's phrasing. */
export function useNextDoseText(): (at: string) => string {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const weekday = useWeekdayLabel();
  const { user } = useAuth();
  const tz = user?.timezone || DEFAULT_TIMEZONE;
  return (at) => {
    const label = resolveNextDueDayLabel(new Date(at), new Date(), tz);
    const day =
      label.kind === "today"
        ? t("medications.today")
        : label.kind === "tomorrow"
          ? t("medications.tomorrow")
          : label.kind === "weekday"
            ? weekday(label.weekday)
            : fmt.dateWithWeekdaySmart(label.instant);
    return `${day}, ${fmt.time(at)}`;
  };
}

/**
 * What the reminders for the next dose will do, in words: when it is due,
 * when it turns overdue, and when it counts as missed. The instants are the
 * resolved dose's (`complianceDisplay.currentDose`, `dose-state/resolve.ts`),
 * so the sentence says what the history, the card and the reminders will
 * actually do, and not a window recomputed here.
 */
export function ReminderPlanLine({ medicationId }: { medicationId: string }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const nextDoseText = useNextDoseText();
  // The detail page's compliance read, same key and shape.
  const { data } = useQuery({
    queryKey: queryKeys.medicationCompliance(medicationId),
    queryFn: async () => {
      try {
        return await apiGet<{
          complianceDisplay: {
            currentDose: {
              targetAt: string | null;
              dueAt: string | null;
              overdueSince: string | null;
              missedAfter: string | null;
            };
          } | null;
        }>(`/api/medications/${medicationId}/compliance`);
      } catch {
        return null;
      }
    },
    staleTime: 30_000,
  });
  const dose = data?.complianceDisplay?.currentDose;
  if (!dose?.targetAt || !dose.overdueSince || !dose.missedAfter) return null;
  return (
    <p className="text-foreground text-sm" data-slot="medication-reminder-plan">
      {t("medications.detail.notifications.plan", {
        dose: nextDoseText(dose.targetAt),
        overdue: fmt.time(dose.overdueSince),
        missed: fmt.time(dose.missedAfter),
      })}
    </p>
  );
}
