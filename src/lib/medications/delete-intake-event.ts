/**
 * Undo one recorded dose: `DELETE /api/medications/{id}/intake/{eventId}`.
 *
 * A soft delete: the row stays, the sync feed carries the tombstone, and the
 * inventory stamp is refunded. The route authenticates (MANAGE over the
 * `medications` section) and answers the 404; the rest runs here.
 */
import type { MedicationIntakeEvent } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import type { SessionUser } from "@/lib/auth/session-user";
import { restoreForIntake } from "@/lib/medications/inventory/consumption";
import { reconcileOneShotState } from "@/lib/medications/lifecycle";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { queueMedicationIntakeSync } from "@/lib/notifications/medication-intake-sync";
import { refreshDoseSlot } from "@/lib/medications/dose-day-refresh";

/**
 * The event under this medication and record, tombstoned or not (a re-delete
 * re-bumps harmlessly), or null for the route's 404.
 */
export async function findDeletableIntakeEvent(input: {
  userId: string;
  medicationId: string;
  eventId: string;
}): Promise<MedicationIntakeEvent | null> {
  const event = await prisma.medicationIntakeEvent.findUnique({
    where: { id: input.eventId },
  });
  if (
    !event ||
    event.userId !== input.userId ||
    event.medicationId !== input.medicationId
  ) {
    return null;
  }
  return event;
}

export async function deleteIntakeEvent(input: {
  user: Pick<SessionUser, "id" | "timezone">;
  medicationId: string;
  eventId: string;
  event: MedicationIntakeEvent;
  ipAddress: string;
  originDeviceToken: string | null;
}): Promise<void> {
  const { user, medicationId: id, eventId, event } = input;

  // A deleted dose record refunds its consumption stamp (no-op for a
  // never-consumed row; a re-delete finds it cleared).
  await restoreForIntake({
    client: prisma,
    userId: user.id,
    eventId,
  });

  // Sync — soft-delete instead of a hard `delete`. An intake is an immutable
  // fact, so a "correction" is a tombstone + re-insert (never an in-place
  // edit). Setting `deletedAt` (+ bumping `syncVersion`) leaves the row in
  // place so the `/api/sync/changes` feed surfaces the deletion as a
  // tombstone keyed on the server `id` to paired clients offline at delete
  // time. Every today / compliance / list read filters `deletedAt: null`, so
  // the row is invisible to normal reads from here on. A re-delete re-bumps
  // harmlessly.
  await prisma.medicationIntakeEvent.update({
    where: { id: eventId },
    data: {
      deletedAt: new Date(),
      syncVersion: { increment: 1 },
    },
  });

  await auditLog("medication.intake.delete", {
    userId: user.id,
    ipAddress: input.ipAddress,
    details: { eventId, medicationId: id },
  });

  annotate({
    action: {
      name: "medication.intake.delete",
      entity_type: "intake_event",
      entity_id: eventId,
    },
    meta: { medication_id: id },
  });

  // Bust per-user medications + compliance + achievement caches so the next
  // read reflects the deletion.
  invalidateUserMedications(user.id, { evict: true });

  // Refresh the rows derived from the day the deleted event sat on.
  await refreshDoseSlot({
    userId: user.id,
    medicationId: id,
    scheduledFor: event.scheduledFor,
    tz: user.timezone,
  });

  // Re-evaluate the one-shot active flag. Deleting the single live intake of
  // a one-shot medication reactivates it so the dashboard / lists / worker
  // pick it back up. No-op for non-one-shot medications.
  await reconcileOneShotState(prisma, id, user.id);

  // (#22) — silent cross-device intake sync: an undone dose must reconcile on
  // the user's other iOS devices (the widget count and a pending Live
  // Activity both change). Coalesced per user, best-effort — never affects
  // the response.
  queueMedicationIntakeSync({
    userId: user.id,
    originDeviceToken: input.originDeviceToken,
  });
}
