/**
 * The detail snapshot as the wizard's edit payload: what "Edit" on the
 * detail page hydrates the wizard from. Split from
 * `./medication-detail-tabs.tsx`, which renders the page.
 */
import type { MedicationPayload } from "@/components/medications/wizard/wizard-payload";
import { parseScheduleRecurrence } from "@/lib/medication-schedule";

import type { MedicationDetailSnapshot } from "./medication-detail-tabs";

export function snapshotToWizardPayload(
  med: MedicationDetailSnapshot,
): MedicationPayload {
  return {
    id: med.id,
    name: med.name,
    dose: med.dose,
    category: med.category,
    treatmentClass: med.treatmentClass,
    deliveryForm: med.deliveryForm,
    dosesPerUnit: med.dosesPerUnit ?? null,
    unitsPerDose: med.unitsPerDose ?? 1,
    trackInjectionSites: med.trackInjectionSites ?? false,
    allowedInjectionSites: med.allowedInjectionSites ?? [],
    notificationsEnabled: med.notificationsEnabled,
    startsOn: med.startsOn ? new Date(med.startsOn) : null,
    endsOn: med.endsOn ? new Date(med.endsOn) : null,
    oneShot: med.oneShot ?? false,
    asNeeded: med.asNeeded ?? false,
    trackIntake: med.trackIntake !== false,
    autoMarkTaken: med.autoMarkTaken === true,
    note: med.note ?? null,
    leafletUrl: med.leafletUrl ?? null,
    schedules: med.schedules.map((s) => ({
      id: s.id,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      label: s.label ?? null,
      dose: s.dose ?? null,
      ...parseScheduleRecurrence(s.daysOfWeek),
      timesOfDay: s.timesOfDay,
      rrule: s.rrule ?? null,
      rollingIntervalDays: s.rollingIntervalDays ?? null,
      doseWindows: s.doseWindows ?? null,
    })),
  };
}
