/**
 * Correct one recorded dose: `PUT /api/medications/{id}/intake/{eventId}`.
 *
 * The route authenticates (MANAGE over the `medications` section), finds the
 * live event, and parses the body; everything from the start-date floor to the
 * cross-device sync tail runs here, in the order it always ran. A correction
 * that keeps the dose on its slot edits the row in place; one that moves it
 * tombstones the original and converges onto the target slot through the
 * shared canonical-slot write.
 */
import type { MedicationIntakeEvent } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { overwriteDetails } from "@/lib/sharing/audit-details";
import type { SessionUser } from "@/lib/auth/session-user";
import type { updateIntakeEventSchema } from "@/lib/validations/medication";
import {
  consumeForIntake,
  restoreForIntake,
} from "@/lib/medications/inventory/consumption";
import { reconcileOneShotState } from "@/lib/medications/lifecycle";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { queueMedicationIntakeSync } from "@/lib/notifications/medication-intake-sync";
import { refreshDoseSlot } from "@/lib/medications/dose-day-refresh";
import { dayKeyForUserTz } from "@/lib/measurements/consolidation-tz";
import {
  applyCanonicalSlotWrite,
  findPinConflict,
  resolveForcedSlotForWrite,
  resolveSlotForWriteByBand,
} from "@/lib/medications/scheduling/slot-upsert";
import { dateOnlyKey } from "@/lib/tz/date-only";
import type { z } from "zod/v4";

export type IntakeEventEdit = z.output<typeof updateIntakeEventSchema>;

/** A coded 422 refusal the route answers with `apiError`. */
export interface IntakeEditRefusal {
  ok: false;
  message: string;
  errorCode: string;
}

type AttributionSource = "AUTO" | "USER_PIN";

interface EditContext {
  user: Pick<SessionUser, "id" | "timezone">;
  medicationId: string;
  eventId: string;
  event: MedicationIntakeEvent;
}

/**
 * The live event a correction may edit, or null for the route's 404. A
 * tombstoned event 404s on PUT; the `deletedAt: null` filter refuses to
 * resurrect-edit a soft-deleted intake.
 */
export async function findEditableIntakeEvent(input: {
  userId: string;
  medicationId: string;
  eventId: string;
}): Promise<MedicationIntakeEvent | null> {
  const event = await prisma.medicationIntakeEvent.findFirst({
    where: { id: input.eventId, deletedAt: null },
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

/**
 * Start-date guard on an edited `takenAt` (audit P0-4). The schema bounds the
 * instant to a plausible absolute range; this check adds the per-medication
 * floor: a take cannot predate the day the medication starts (calendar-day
 * comparison in the user's timezone, so a take in the early hours of the
 * start day never false-rejects).
 */
async function refuseTakeBeforeStart(
  ctx: EditContext,
  data: IntakeEventEdit,
): Promise<IntakeEditRefusal | null> {
  const { user, medicationId: id, eventId } = ctx;
  if (data.takenAt instanceof Date) {
    const medication = await prisma.medication.findFirst({
      where: { id, userId: user.id },
      select: { startsOn: true },
    });
    if (medication?.startsOn) {
      const takenDay = dayKeyForUserTz(data.takenAt, user.timezone);
      const startsOnDay = dateOnlyKey(medication.startsOn);
      if (takenDay < startsOnDay) {
        annotate({
          action: {
            name: "medications.intake.event.update.before-start-date",
          },
          meta: { medication_id: id, event_id: eventId },
        });
        return {
          ok: false,
          message: "takenAt is before the medication's start date",
          errorCode: "medications.intake.taken_at.before_start",
        };
      }
    }
  }
  return null;
}

/**
 * Re-run window-band attribution when the edit moves `takenAt` or `skipped`,
 * so an edited time re-binds to the correct slot instead of leaving
 * `scheduledFor` stale (audit HIGH-4). Precedence:
 *   1. an explicit `scheduledFor` in the body wins (deliberate override);
 *   2. else `forceSlotInstant` pins onto a named real slot (422 if it is
 *      not a slot of this med), standalone too, no takenAt / skipped change
 *      required ("Slot zuordnen" from the ledger kebab), and the row is
 *      stamped USER_PIN so the read ledger binds it by anchor instead of
 *      degrading the off-window take back to ad-hoc;
 *   3. else an explicit `forceSlotInstant: null` UNPINS ("Zuordnung lösen"):
 *      re-attribute the take by band on its takenAt (ad-hoc when no band
 *      matches). The release is itself a deliberate binding decision, so the
 *      row KEEPS `USER_PIN` provenance ("attribution user-fixed": onto a slot
 *      OR deliberately ad-hoc). The persisted marker is what keeps the
 *      nightly slot dedup from snapping the released row back into the
 *      cluster the user just detached it from;
 *   4. else a taken edit attributes by band (slot anchor on match, the
 *      take's own time on a miss → ad-hoc), provenance AUTO;
 *   5. a skip / pending edit keeps the existing `scheduledFor` anchor.
 */
async function resolveEditAttribution(
  ctx: EditContext,
  data: IntakeEventEdit,
  next: {
    nextTakenAt: Date | null;
    nextSkipped: boolean;
    takenOrSkippedChanged: boolean;
  },
): Promise<
  | IntakeEditRefusal
  | {
      ok: true;
      resolvedScheduledFor: Date | undefined;
      attributionSource: AttributionSource | undefined;
    }
> {
  const { user, medicationId: id, eventId } = ctx;
  const { nextTakenAt, nextSkipped, takenOrSkippedChanged } = next;
  let resolvedScheduledFor: Date | undefined = data.scheduledFor;
  let attributionSource: AttributionSource | undefined;
  if (resolvedScheduledFor === undefined) {
    if (data.forceSlotInstant !== undefined && data.forceSlotInstant !== null) {
      const forced = await resolveForcedSlotForWrite({
        userId: user.id,
        medicationId: id,
        userTz: user.timezone,
        slotInstant: data.forceSlotInstant,
      });
      if (forced === null) {
        annotate({
          action: { name: "medication.intake.force_slot.invalid" },
          meta: { medication_id: id, event_id: eventId },
        });
        return {
          ok: false,
          message:
            "forceSlotInstant is not a scheduled slot of this medication",
          errorCode: "medications.intake.force_slot.invalid",
        };
      }
      // Refuse to pin onto a slot another recorded action already serves
      // (excluding the row being edited): the explicit-write last-write-wins
      // rule would silently overwrite that dose record. The ledger UI only
      // offers the pin for unserved slots, so this only fires for stale
      // clients / raw API calls.
      if (
        await findPinConflict({
          userId: user.id,
          medicationId: id,
          canonicalSlot: forced,
          incomingTakenAt: nextSkipped ? null : nextTakenAt,
          excludeEventId: eventId,
        })
      ) {
        annotate({
          action: { name: "medication.intake.force_slot.occupied" },
          meta: { medication_id: id, event_id: eventId },
        });
        return {
          ok: false,
          message: "forceSlotInstant already carries a recorded dose action",
          errorCode: "medications.intake.force_slot.occupied",
        };
      }
      resolvedScheduledFor = forced;
      attributionSource = "USER_PIN";
    } else if (
      (data.forceSlotInstant === null || takenOrSkippedChanged) &&
      nextTakenAt !== null &&
      !nextSkipped
    ) {
      const attribution = await resolveSlotForWriteByBand({
        userId: user.id,
        medicationId: id,
        userTz: user.timezone,
        takenAt: nextTakenAt,
      });
      // band.at on match; the take's own time on a miss (ad-hoc).
      resolvedScheduledFor = attribution.slotInstant ?? nextTakenAt;
      // An explicit unpin stays user-fixed (USER_PIN) even on the released
      // row; a plain taken/skipped edit re-attributes AUTO.
      attributionSource = data.forceSlotInstant === null ? "USER_PIN" : "AUTO";
    } else if (data.forceSlotInstant === null) {
      // Unpin on a row that is not a confirmed take (skip / pending):
      // nothing to re-attribute, but the provenance still resets — a
      // skip / pending row anchors on its slot by construction, so there
      // is no user-fixed ad-hoc decision to persist.
      attributionSource = "AUTO";
    }
    // skip / pending edits leave `scheduledFor` on the existing anchor.
  }
  return { ok: true, resolvedScheduledFor, attributionSource };
}

/**
 * The slot is unchanged — a bare in-place update can never collide with a
 * sibling row (it is its own slot).
 */
async function editIntakeInPlace(
  ctx: EditContext,
  data: IntakeEventEdit,
  edit: {
    attributionSource: AttributionSource | undefined;
    nextTakenAt: Date | null;
    nextSkipped: boolean;
    wasTaken: boolean;
  },
) {
  const { user, medicationId: id, eventId } = ctx;
  const { attributionSource, nextTakenAt, nextSkipped, wasTaken } = edit;
  const updated = await prisma.medicationIntakeEvent.update({
    where: { id: eventId },
    data: {
      ...(data.takenAt !== undefined && { takenAt: data.takenAt }),
      ...(data.skipped !== undefined && { skipped: data.skipped }),
      // Binding provenance: pin / unpin / band re-attribution stamps it even
      // when the anchor itself did not move (e.g. a pin onto the slot the row
      // already sits on, or an unpin whose band re-attribution lands on the
      // same anchor).
      ...(attributionSource !== undefined && { attributionSource }),
      // An edit of the outcome is the person's own record.
      ...((data.takenAt !== undefined || data.skipped !== undefined) && {
        autoRecorded: false,
      }),
      // Sync — bump the reconciliation counter on every server-side mutation
      // so the `/api/sync/changes` feed echoes a monotonic value to paired
      // clients.
      syncVersion: { increment: 1 },
    },
  });
  // Inventory follows the post-edit state: an edit that moves the row INTO
  // taken consumes; a row that stays taken keeps its stamp untouched (the
  // stamp freezes what the original take pulled, even when `unitsPerDose`
  // changed since, and a pre-stamp legacy row must not retro-consume); a row
  // edited out of taken (skip flip, takenAt cleared) refunds its stamp.
  if (nextTakenAt !== null && !nextSkipped) {
    if (!wasTaken) {
      await consumeForIntake({
        client: prisma,
        userId: user.id,
        medicationId: id,
        eventId,
        intakeAt: nextTakenAt,
      });
    }
  } else {
    await restoreForIntake({
      client: prisma,
      userId: user.id,
      eventId,
    });
  }
  return updated;
}

/**
 * The edit moved the dose to a different slot. Tombstone the original row
 * (the iOS "a correction is a tombstone + re-insert" model the DELETE handler
 * documents) and route the corrected dose through the shared canonical-slot
 * upsert, which converges onto any row already at the target slot (a pending
 * REMINDER row) rather than bare-updating into an occupied slot and risking a
 * P2002 (audit HIGH-4).
 *
 * The source row's consumption stamp is refunded BEFORE the tombstone; the
 * consume on the converged row below nets the move to exactly one
 * consumption.
 */
async function moveIntakeToSlot(
  ctx: EditContext,
  move: {
    targetScheduledFor: Date;
    attributionSource: AttributionSource | undefined;
    nextTakenAt: Date | null;
    nextSkipped: boolean;
    wasTaken: boolean;
  },
) {
  const { user, medicationId: id, eventId, event } = ctx;
  const {
    targetScheduledFor,
    attributionSource,
    nextTakenAt,
    nextSkipped,
    wasTaken,
  } = move;
  await restoreForIntake({
    client: prisma,
    userId: user.id,
    eventId,
  });
  await prisma.medicationIntakeEvent.update({
    where: { id: eventId },
    data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
  });
  const applied = await applyCanonicalSlotWrite({
    client: prisma,
    userId: user.id,
    medicationId: id,
    canonicalSlot: targetScheduledFor,
    takenAt: nextSkipped ? null : nextTakenAt,
    skipped: nextSkipped,
    isExplicitTaken: !nextSkipped && nextTakenAt !== null,
    isExplicitSkip: nextSkipped,
    idempotencyKey: null,
    // The converged row keeps the ORIGINAL's provenance. This used to be a
    // hardcoded `"WEB"`, which said "somebody typed this in the browser"
    // about an Apple Health dose whose time was corrected. Under MANAGE the
    // sentence would be wrong about a second person as well.
    createSource: event.source,
    attributionSource,
    // A slot move is a re-binding, not a new dose: the original row's
    // recorded injection site and dose override ride along onto the
    // converged row instead of being tombstoned away.
    injectionSite: event.injectionSite,
    doseTaken: event.doseTaken,
  });
  // A taken source WITHOUT a stamp is a legacy row whose stock moved through
  // the old take-time hook: the refund above was a no-op, so consuming on the
  // converged row would double-charge — skip it. Every other taken outcome
  // nets the move to exactly one consumption.
  if (
    nextTakenAt !== null &&
    !nextSkipped &&
    (!wasTaken || event.inventoryConsumption !== null)
  ) {
    await consumeForIntake({
      client: prisma,
      userId: user.id,
      medicationId: id,
      eventId: applied.row.id,
      intakeAt: nextTakenAt,
    });
  }
  return applied.row;
}

/** Correct one dose; the event is the live row the route found. */
export async function updateIntakeEvent(
  input: EditContext & {
    data: IntakeEventEdit;
    ipAddress: string | null;
    originDeviceToken: string | null;
  },
) {
  const { user, medicationId: id, eventId, event, data } = input;
  const ctx: EditContext = { user, medicationId: id, eventId, event };

  const beforeStart = await refuseTakeBeforeStart(ctx, data);
  if (beforeStart) return beforeStart;

  // The post-edit state of the row (current values where the body omits a
  // field) — drives the re-attribution decision.
  const nextTakenAt = data.takenAt !== undefined ? data.takenAt : event.takenAt;
  const nextSkipped = data.skipped !== undefined ? data.skipped : event.skipped;
  const takenOrSkippedChanged =
    (data.takenAt !== undefined &&
      data.takenAt?.getTime() !== event.takenAt?.getTime()) ||
    (data.skipped !== undefined && data.skipped !== event.skipped);

  const attribution = await resolveEditAttribution(ctx, data, {
    nextTakenAt,
    nextSkipped,
    takenOrSkippedChanged,
  });
  if (!attribution.ok) return attribution;
  const { resolvedScheduledFor, attributionSource } = attribution;

  const targetScheduledFor = resolvedScheduledFor ?? event.scheduledFor;
  const slotMoved =
    targetScheduledFor.getTime() !== event.scheduledFor.getTime();

  // Transition gate for the inventory hooks. Only an edit moving the row INTO
  // taken may consume; a row that was already taken keeps its stamp frozen (a
  // stamped row would no-op anyway, and a legacy taken row — NULL stamp, stock
  // already moved by the old hook at take time — must never retro-consume on
  // a time correction).
  const wasTaken = event.takenAt !== null && !event.skipped;

  const updated = !slotMoved
    ? await editIntakeInPlace(ctx, data, {
        attributionSource,
        nextTakenAt,
        nextSkipped,
        wasTaken,
      })
    : await moveIntakeToSlot(ctx, {
        targetScheduledFor,
        attributionSource,
        nextTakenAt,
        nextSkipped,
        wasTaken,
      });

  await auditLog("medication.intake.update", {
    userId: user.id,
    ipAddress: input.ipAddress,
    // What the correction moved. A dose edit changes when a dose is
    // recorded as taken, which is exactly what a clinician reads back.
    details: {
      eventId,
      medicationId: id,
      ...overwriteDetails({
        before: {
          scheduledFor: event.scheduledFor,
          takenAt: event.takenAt,
          skipped: event.skipped,
        },
        // The slot-write result carries the canonical four. The injection
        // site and the dose override are not compared here because the move
        // path copies them onto the converged row by construction — there is
        // no edit of them to report.
        after: {
          scheduledFor: updated.scheduledFor,
          takenAt: updated.takenAt,
          skipped: updated.skipped,
        },
      }),
    },
  });

  annotate({
    action: {
      name: "medication.intake.update",
      entity_type: "intake_event",
      entity_id: eventId,
    },
    meta: { medication_id: id },
  });

  // Bust per-user medications + compliance + achievement caches so the next
  // read reflects the edited event.
  invalidateUserMedications(user.id, { evict: true });

  // Refresh the rows derived from both the old + new scheduledFor day-keys
  // when the dose moved across a day boundary (band re-attribution can move
  // it as well as an explicit edit); if the slot is unchanged the second call
  // collapses to a no-op upsert.
  await refreshDoseSlot({
    userId: user.id,
    medicationId: id,
    scheduledFor: event.scheduledFor,
    tz: user.timezone,
  });
  if (slotMoved) {
    await refreshDoseSlot({
      userId: user.id,
      medicationId: id,
      scheduledFor: targetScheduledFor,
      tz: user.timezone,
    });
  }

  // Re-evaluate the one-shot active flag. A skip-flip on the single live
  // intake of a one-shot medication should reactivate it (the dose is no
  // longer logged), and the reverse case should deactivate again. No-op for
  // non-one-shot medications.
  await reconcileOneShotState(prisma, id, user.id);

  // (#22) — silent cross-device intake sync: an edited dose must reconcile on
  // the user's other iOS devices too. Coalesced per user, best-effort — never
  // affects the response.
  queueMedicationIntakeSync({
    userId: user.id,
    originDeviceToken: input.originDeviceToken,
  });

  return { ok: true as const, row: updated };
}
