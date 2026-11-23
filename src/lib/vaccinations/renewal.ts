/**
 * Whether a vaccination is still current, surfaced where the person looks.
 *
 * The data already exists and is the person's own: when a dose is logged, the
 * app offers to plan the booster from the catalogue's interval, and what the
 * person confirms becomes an ordinary reminder keyed on the antigen
 * (`MeasurementReminder.vaccinationAntigen`, minted in `booster-mint.ts`).
 * Logging the next dose re-anchors it. Its `nextDueAt` is the renewal date.
 * Until now it lived only on `/care`, and the vaccination page itself said
 * nothing about it.
 *
 * This module reads that date and resolves it to a state, once, on the
 * server, so the web page and the native client agree. It does NOT compute a
 * due date from age, history or the catalogue: an antigen with no confirmed
 * booster has no renewal here. That line is the one `series.ts` draws — due
 * computation from a person's history is a different kind of product — and it
 * is why the source is the confirmed reminder and nothing else.
 *
 * Pure: no DB read. The route owns the read and the grant check.
 */
import { calendarDaysUntil } from "@/lib/measurement-reminders/due-day";

/**
 * How close a renewal has to be before it counts as due soon. A month is
 * enough to book an appointment for a ten-year booster and still meaningful
 * for a seasonal one.
 */
export const VACCINATION_RENEWAL_SOON_DAYS = 30;

export type VaccinationRenewalState = "current" | "dueSoon" | "overdue";

/** One antigen's renewal, resolved. */
export interface VaccinationRenewalDTO {
  /** The component antigen slug the booster reminder keys on. */
  antigen: string;
  /** The reminder behind it, for a deep link to `/care`. */
  reminderId: string;
  /** ISO-8601 instant the booster is due. */
  dueAt: string;
  /**
   * Calendar days from today to `dueAt` on the person's own clock; negative
   * once it has passed. The same count the checkups page shows.
   */
  daysUntil: number;
  state: VaccinationRenewalState;
}

export interface RenewalReminderRow {
  id: string;
  vaccinationAntigen: string | null;
  nextDueAt: Date | null;
  enabled: boolean;
}

export function resolveRenewals(
  reminders: readonly RenewalReminderRow[],
  now: Date,
  timeZone: string,
): VaccinationRenewalDTO[] {
  const byAntigen = new Map<string, RenewalReminderRow & { due: Date }>();
  for (const reminder of reminders) {
    if (!reminder.enabled) continue;
    if (!reminder.vaccinationAntigen || !reminder.nextDueAt) continue;
    // The mint keeps one live reminder per antigen; should two exist anyway,
    // the earlier date is the one that needs the person first.
    const current = byAntigen.get(reminder.vaccinationAntigen);
    if (!current || reminder.nextDueAt < current.due) {
      byAntigen.set(reminder.vaccinationAntigen, {
        ...reminder,
        due: reminder.nextDueAt,
      });
    }
  }
  return [...byAntigen.values()]
    .map((reminder) => {
      const daysUntil = calendarDaysUntil(reminder.due, now, timeZone);
      const state: VaccinationRenewalState =
        daysUntil < 0
          ? "overdue"
          : daysUntil <= VACCINATION_RENEWAL_SOON_DAYS
            ? "dueSoon"
            : "current";
      return {
        antigen: reminder.vaccinationAntigen!,
        reminderId: reminder.id,
        dueAt: reminder.due.toISOString(),
        daysUntil,
        state,
      };
    })
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}
