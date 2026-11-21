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
import {
  slotLockKey,
  withSlotLock,
} from "@/lib/medications/scheduling/slot-lock";

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
  /** The `syncVersion` the client saw; a different one refuses the undo. */
  expectedSyncVersion?: number;
  /**
   * The idempotency key of the take the client wants to undo. A row that
   * carries another key holds someone else's take (a pill box this tap
   * converged onto answers `alreadyTaken` and keeps its key), so the undo is
   * refused.
   */
  expectedIdempotencyKey?: string;
  ipAddress: string;
  originDeviceToken: string | null;
}): Promise<"deleted" | "changedSinceSeen"> {
  const { user, medicationId: id, eventId, event } = input;

  // Serialised with every take of the slot (`slot-lock.ts`) and re-read
  // under the lock, so a take racing this undo never lands on the
  // tombstone, and a stale undo cannot remove a newer dose.
  const key = slotLockKey({
    userId: user.id,
    medicationId: id,
    slot: event.scheduledFor,
  });
  const verdict = await withSlotLock(prisma, key, async (tx) => {
    const current = await tx.medicationIntakeEvent.findUnique({
      where: { id: eventId },
      select: { syncVersion: true, idempotencyKey: true },
    });
    if (
      (input.expectedSyncVersion !== undefined &&
        current?.syncVersion !== input.expectedSyncVersion) ||
      (input.expectedIdempotencyKey !== undefined &&
        current?.idempotencyKey !== input.expectedIdempotencyKey)
    ) {
      return "changedSinceSeen" as const;
    }
    // A deleted dose record refunds its consumption stamp first (no-op for
    // a never-consumed row; a re-delete finds it cleared).
    await restoreForIntake({ client: prisma, userId: user.id, eventId });
    // Sync — soft-delete instead of a hard `delete`; see below.
    await tx.medicationIntakeEvent.update({
      where: { id: eventId },
      data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
    });
    return "deleted" as const;
  });
  if (verdict === "changedSinceSeen") return verdict;

  // Sync — soft-delete instead of a hard `delete`. An intake is an immutable
  // fact, so a "correction" is a tombstone + re-insert (never an in-place
  // edit). Setting `deletedAt` (+ bumping `syncVersion`) leaves the row in
  // place so the `/api/sync/changes` feed surfaces the deletion as a
  // tombstone keyed on the server `id` to paired clients offline at delete
  // time. Every today / compliance / list read filters `deletedAt: null`, so
  // the row is invisible to normal reads from here on. A re-delete re-bumps
  // harmlessly.

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
  return "deleted";
}

/**
 * The undo's optional preconditions. Absent means unchecked; sent means it
 * must be readable: `expectedSyncVersion` a whole number 0 to 999999999,
 * `expectedIdempotencyKey` 1 to 128 characters.
 */
export function readUndoPrecondition(params: URLSearchParams):
  | {
      ok: true;
      expectedSyncVersion: number | undefined;
      expectedIdempotencyKey: string | undefined;
    }
  | { ok: false; message: string } {
  const seen = params.get("expectedSyncVersion");
  if (seen !== null && !/^\d{1,9}$/.test(seen)) {
    return {
      ok: false,
      message: "expectedSyncVersion must be a whole number from 0",
    };
  }
  const ownKey = params.get("expectedIdempotencyKey");
  if (ownKey !== null && (ownKey.length === 0 || ownKey.length > 128)) {
    return {
      ok: false,
      message: "expectedIdempotencyKey must be 1 to 128 characters",
    };
  }
  return {
    ok: true,
    expectedSyncVersion: seen === null ? undefined : Number(seen),
    expectedIdempotencyKey: ownKey ?? undefined,
  };
}
