import {
  reduceCurrentWindowStatus,
  type ScheduleWindowInput,
} from "@/lib/medications/window-status";

export interface DefaultMedicationOption {
  id: string;
  name: string;
  active: boolean;
  schedules: ScheduleWindowInput[];
  lastTakenAt: string | null;
  todayEventCount?: number | null;
  nextDueAt?: string | null;
  nextDueOverdue?: boolean;
}

export interface MedicationDueThresholds {
  lateMinutes: number;
  missedMinutes: number;
}

const DEFAULT_THRESHOLDS: MedicationDueThresholds = {
  lateMinutes: 120,
  missedMinutes: 240,
};

const DEFAULT_TIMEZONE = "Europe/Berlin";

/**
 * Pick the medication that should be pre-selected when an intake form opens.
 * Current, late, and overdue schedule windows win; otherwise the fallback is
 * the single active medication or the first active name alphabetically.
 */
export function pickDefaultMedicationId(
  options: DefaultMedicationOption[],
  now: Date = new Date(),
  thresholds: MedicationDueThresholds = DEFAULT_THRESHOLDS,
  tz: string = DEFAULT_TIMEZONE,
): string | null {
  const actives = options.filter((medication) => medication.active);
  if (actives.length === 0) return null;
  if (actives.length === 1) return actives[0].id;

  const due = actives.find((medication) => {
    const nextDueMs = medication.nextDueAt
      ? new Date(medication.nextDueAt).getTime()
      : Number.NaN;
    const status = reduceCurrentWindowStatus({
      schedules: medication.schedules,
      now,
      lateMinutes: thresholds.lateMinutes,
      missedMinutes: thresholds.missedMinutes,
      active: true,
      lastTakenAt: medication.lastTakenAt,
      todayEventCount: medication.todayEventCount ?? 0,
      tz,
      nextDue:
        medication.nextDueAt === undefined
          ? undefined
          : Number.isFinite(nextDueMs)
            ? {
                at: new Date(nextDueMs),
                overdue: medication.nextDueOverdue === true,
              }
            : null,
    });
    return status.status !== null && status.takenEarlyDaysAgo === null;
  });
  if (due) return due.id;

  const sorted = [...actives].sort((a, b) =>
    a.name.localeCompare(b.name, "de", { sensitivity: "base" }),
  );
  return sorted[0]?.id ?? null;
}

/**
 * Keep an explicit picker choice across data-driven re-renders. Until the user
 * chooses, the due-aware default remains derived from the latest read DTO.
 */
export function resolveMedicationSelectionId(
  options: DefaultMedicationOption[],
  userSelection: string | null,
  now: Date = new Date(),
  thresholds: MedicationDueThresholds = DEFAULT_THRESHOLDS,
  tz: string = DEFAULT_TIMEZONE,
): string | null {
  return userSelection ?? pickDefaultMedicationId(options, now, thresholds, tz);
}
