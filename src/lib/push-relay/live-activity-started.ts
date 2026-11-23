/**
 * The dose a server-started Live Activity shows, for the device that runs it.
 *
 * A relay start carries the content state only (`HealthLogDoseAttributes`,
 * attributes `{"v":1}`), never the dose: the relay and Apple see that a dose
 * is due, not which. The server keeps the dose of the device's last start
 * (`laStartedMedicationId`, `laStartedSlot`) and hands it to the app over
 * the authenticated channel only: `push.device.liveActivityStarted` on
 * `GET /api/auth/me` and in the `POST /api/devices` answer.
 *
 * It is null until the relay accepted the start (`laStartedAt`): a start
 * still in flight, or one that failed, started nothing on the device
 * (`live-activity-settle.ts`). It is null again once there is nothing left
 * to show: the slot was taken, skipped
 * or turned missed, its row is gone, the medication was paused, ended or
 * deleted, or its Live Activity opt-in (`liveActivityEnabled`) was turned
 * off. The server ends an Activity only in those cases
 * (`liveActivityEndState`, and the relay pass for a server-started Activity
 * whose medication may no longer have one), so an ended Activity reads null
 * too. An Activity
 * the person dismissed on the device keeps the value until the slot is
 * answered; the app knows it dismissed it, and the stored dose also keeps
 * the next pass from starting the same dose again.
 */
import { prisma } from "@/lib/db";
import { STARTABLE_MEDICATION_WHERE } from "@/lib/push-relay/activity-slot";

export interface LiveActivityStarted {
  medicationId: string;
  slotInstant: string;
}

export async function liveActivityStartedOf(device: {
  userId: string;
  laStartedMedicationId: string | null;
  laStartedSlot: Date | null;
  laStartedAt: Date | null;
}): Promise<LiveActivityStarted | null> {
  const { userId, laStartedMedicationId, laStartedSlot, laStartedAt } = device;
  if (!laStartedMedicationId || !laStartedSlot || !laStartedAt) return null;
  const open = await prisma.medicationIntakeEvent.findFirst({
    where: {
      userId,
      medicationId: laStartedMedicationId,
      scheduledFor: laStartedSlot,
      deletedAt: null,
      takenAt: null,
      skipped: false,
      autoMissed: false,
      medication: STARTABLE_MEDICATION_WHERE,
    },
    select: { id: true },
  });
  // One live row per slot (migration 0515), so an open row is the answer.
  if (!open) return null;
  return {
    medicationId: laStartedMedicationId,
    slotInstant: laStartedSlot.toISOString(),
  };
}
