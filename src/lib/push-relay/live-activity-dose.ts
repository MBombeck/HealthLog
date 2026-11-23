/**
 * The resolved dose a Live Activity shows: the intake row at its slot, read
 * through the same resolver the today list and the reminders use
 * (`medications/dose-state/resolve.ts`), with the slot's own snooze. Shared
 * by the relay pass (`live-activity.ts`) for starts, updates and the hold an
 * unreported start keeps on the next one.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { resolveDosesByRow } from "@/lib/medications/dose-state/today";
import { slotsHeldBySnooze } from "@/lib/medications/snooze-scope";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { activitySlotWindow } from "@/lib/push-relay/activity-slot";
import type { ActivityDose } from "@/lib/push-relay/live-activity-content";

const SNOOZE_SCHEDULE_SELECT = {
  windowStart: true,
  windowEnd: true,
  timesOfDay: true,
  reminderGraceMinutes: true,
  doseWindows: true,
} as const;

export const DOSE_ROW_SELECT = {
  id: true,
  medicationId: true,
  scheduledFor: true,
  medication: {
    select: {
      snoozedUntil: true,
      updatedAt: true,
      liveActivityEnabled: true,
      schedules: { select: SNOOZE_SCHEDULE_SELECT },
    },
  },
} as const;

type DoseRow = Prisma.MedicationIntakeEventGetPayload<{
  select: typeof DOSE_ROW_SELECT;
}>;

/**
 * The resolved doses of `rows`, in their order. A row the ledger places on
 * no slot has no dose state and is left out. The snooze is the slot's own,
 * by the rule the today list and the reminder worker share.
 */
export async function resolveRows(
  userId: string,
  rows: readonly DoseRow[],
  now: Date,
): Promise<ActivityDose[]> {
  if (rows.length === 0) return [];
  const userTz = await resolveUserTimezone(userId);
  const times = rows.map((r) => r.scheduledFor.getTime());
  const resolved = await resolveDosesByRow({
    userId,
    userTz,
    medications: rows.map((r) => r.medicationId),
    takenViaByRow: new Map(),
    from: new Date(Math.min(...times)),
    to: new Date(Math.max(...times) + 1),
    now,
  });
  const held = new Map<string, Set<number>>();
  for (const row of rows) {
    if (held.has(row.medicationId)) continue;
    held.set(
      row.medicationId,
      slotsHeldBySnooze({
        snoozedUntil: row.medication.snoozedUntil,
        snoozedAt: row.medication.updatedAt,
        schedules: row.medication.schedules,
        slotInstants: rows
          .filter((r) => r.medicationId === row.medicationId)
          .map((r) => r.scheduledFor),
        tz: userTz,
        now,
      }),
    );
  }
  return rows.flatMap((row) => {
    const dose = resolved.get(row.id);
    if (!dose) return [];
    const holds = held.get(row.medicationId)?.has(row.scheduledFor.getTime());
    return [
      {
        medicationId: row.medicationId,
        scheduledFor: row.scheduledFor,
        resolved: dose,
        snoozedUntil: holds ? row.medication.snoozedUntil : null,
        liveActivityEnabled: row.medication.liveActivityEnabled,
      },
    ];
  });
}

/** The resolved dose at `slot` of `medicationId`, or null when no row holds it. */
export async function doseAt(
  userId: string,
  medicationId: string,
  slot: Date,
  now: Date,
): Promise<ActivityDose | null> {
  const row = await prisma.medicationIntakeEvent.findFirst({
    where: {
      userId,
      medicationId,
      scheduledFor: activitySlotWindow(slot),
      deletedAt: null,
    },
    orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
    select: DOSE_ROW_SELECT,
  });
  if (!row) return null;
  const [dose] = await resolveRows(userId, [row], now);
  return dose ?? null;
}
