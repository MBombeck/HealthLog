/**
 * A "taken" status update on one intake row. The row already names its dose,
 * so the take keeps that slot (`resolveTakeSlotForExistingRow`): confirming
 * the injection site, re-marking a row, or marking an overdue reminder row as
 * taken never moves the dose off its slot by the clock time of the request.
 * A take that only documents an already-taken row (no `takenAt`) leaves its
 * time and slot untouched. `forceSlotInstant` pins onto a named real slot
 * (422 if it is not one). Mirrors the per-event PUT route.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import {
  applyCanonicalSlotWrite,
  resolveForcedSlotForWrite,
} from "@/lib/medications/scheduling/slot-upsert";
import { resolveTakeSlotForExistingRow } from "@/lib/medications/scheduling/existing-row-slot";
import {
  consumeForIntake,
  restoreForIntake,
} from "@/lib/medications/inventory/consumption";
import type { InjectionSiteValue } from "@/lib/validations/medication";
import type { IntakeStatusRefusal, StatusUpdateEvent } from "./admission";

interface TakeInput {
  userId: string;
  intakeId: string;
  existing: StatusUpdateEvent;
  takenAt: Date | undefined;
  forceSlotInstant: Date | undefined;
  resolvedInjectionSite: InjectionSiteValue | null;
  userTz: string;
}

interface TargetSlot {
  slot: Date;
  /** Undefined leaves the stored provenance as it is. */
  attributionSource: "AUTO" | "USER_PIN" | undefined;
}

async function targetSlotOf(
  input: TakeInput,
  resolvedTakenAt: Date,
  documentsOnly: boolean,
): Promise<TargetSlot | IntakeStatusRefusal> {
  const { userId, existing, intakeId, forceSlotInstant, userTz } = input;
  if (forceSlotInstant !== undefined) {
    const forced = await resolveForcedSlotForWrite({
      userId,
      medicationId: existing.medicationId,
      userTz,
      slotInstant: forceSlotInstant,
    });
    if (forced === null) {
      annotate({
        action: { name: "medication.intake.force_slot.invalid" },
        meta: { medication_id: existing.medicationId, intake_id: intakeId },
      });
      return {
        kind: "refused",
        message: "forceSlotInstant is not a scheduled slot of this medication",
        status: 422,
        errorCode: "medications.intake.force_slot.invalid",
      };
    }
    return { slot: forced, attributionSource: "USER_PIN" };
  }
  // Nothing about the dose changes, so nothing about its binding does.
  if (documentsOnly) {
    return { slot: existing.scheduledFor, attributionSource: undefined };
  }
  const bound = await resolveTakeSlotForExistingRow({
    userId,
    medicationId: existing.medicationId,
    userTz,
    rowScheduledFor: existing.scheduledFor,
    rowWasTaken: existing.takenAt !== null && !existing.skipped,
    takenAt: resolvedTakenAt,
  });
  return {
    slot: bound.slotInstant,
    attributionSource: bound.attributionSource,
  };
}

async function takeInPlace(
  input: TakeInput,
  resolvedTakenAt: Date,
  wasTaken: boolean,
  attributionSource: TargetSlot["attributionSource"],
) {
  const { userId, intakeId, existing, resolvedInjectionSite } = input;
  const [updated] = await prisma.$transaction([
    prisma.medicationIntakeEvent.update({
      where: { id: intakeId },
      // Bump the reconciliation counter on every
      // server-side mutation so the delta feed echoes a monotonic value.
      data: {
        takenAt: resolvedTakenAt,
        skipped: false,
        // The person confirmed it; no longer automatic, and no longer a miss.
        autoRecorded: false,
        autoMissed: false,
        ...(attributionSource !== undefined && { attributionSource }),
        syncVersion: { increment: 1 },
        // Persist the resolved site on the taken branch.
        ...(resolvedInjectionSite !== null && {
          injectionSite: resolvedInjectionSite,
        }),
      },
    }),
    prisma.medication.update({
      where: { id: existing.medicationId },
      data: { snoozedUntil: null },
    }),
  ]);
  // The toggle recorded a take; consume inventory units
  // on the genuine pending→taken (or skipped→taken) transition. The
  // stamp additionally keeps a racing replay exactly-once.
  if (!wasTaken) {
    await consumeForIntake({
      client: prisma,
      userId,
      medicationId: existing.medicationId,
      eventId: intakeId,
      intakeAt: resolvedTakenAt,
    });
  }
  return updated;
}

/**
 * The take re-attributed to a different slot. Tombstone the source row and
 * route the dose through the shared canonical-slot upsert, which converges
 * onto any row already at the target slot rather than bare-updating into an
 * occupied slot (P2002-safe).
 *
 * Refund the source row's consumption stamp BEFORE the tombstone, then
 * consume on the converged row below: a slot move is a re-binding of one
 * real dose, so the stock nets exactly one consumption.
 */
async function moveTake(
  input: TakeInput,
  resolvedTakenAt: Date,
  targetScheduledFor: Date,
  wasTaken: boolean,
  attributionSource: TargetSlot["attributionSource"],
) {
  const { userId, intakeId, existing, resolvedInjectionSite } = input;
  await restoreForIntake({
    client: prisma,
    userId,
    eventId: intakeId,
  });
  await prisma.medicationIntakeEvent.update({
    where: { id: intakeId },
    data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
  });
  const applied = await applyCanonicalSlotWrite({
    client: prisma,
    userId,
    medicationId: existing.medicationId,
    canonicalSlot: targetScheduledFor,
    takenAt: resolvedTakenAt,
    skipped: false,
    isExplicitTaken: true,
    isExplicitSkip: false,
    idempotencyKey: null,
    createSource: "WEB",
    attributionSource,
    // Carry the recorded site / dose override across the
    // tombstone + re-insert: a slot move is a re-binding, not a new
    // dose, so the original row's documentation must survive when the
    // toggle write itself carries none.
    injectionSite:
      resolvedInjectionSite ??
      (existing.injectionSite as InjectionSiteValue | null),
    doseTaken: existing.doseTaken,
  });
  await prisma.medication.update({
    where: { id: existing.medicationId },
    data: { snoozedUntil: null },
  });
  // Consume on the converged row (the old row's stamp
  // was refunded above, so the move nets one consumption). A taken
  // source WITHOUT a stamp is a pre-v1.16.10 row whose stock moved
  // through the legacy hook: the refund above was a no-op, so
  // consuming on the target would double-charge — skip it.
  if (!wasTaken || existing.inventoryConsumption !== null) {
    await consumeForIntake({
      client: prisma,
      userId,
      medicationId: existing.medicationId,
      eventId: applied.row.id,
      intakeAt: resolvedTakenAt,
    });
  }
  return applied.row;
}

/** Record the take, in place or on the slot it now binds to. */
export async function applyTakenStatus(input: TakeInput) {
  // Transition gate for the inventory consume. Only
  // a row moving INTO taken may consume; a re-take of an already-
  // taken row (e.g. a time correction) leaves its stamp frozen, and a
  // pre-v1.16.10 taken row (NULL stamp, stock already moved by the
  // legacy hook at take time) must never retro-consume.
  const wasTaken = input.existing.takenAt !== null && !input.existing.skipped;
  // A "taken" on a row that is already taken, without a time, documents the
  // dose (the injection site confirmed after the tap) and is not a new take:
  // its recorded time stays.
  const documentsOnly =
    wasTaken &&
    input.takenAt === undefined &&
    input.forceSlotInstant === undefined;
  const resolvedTakenAt =
    input.takenAt ??
    (documentsOnly && input.existing.takenAt !== null
      ? input.existing.takenAt
      : new Date());

  const target = await targetSlotOf(input, resolvedTakenAt, documentsOnly);
  if ("kind" in target) return target;
  const targetScheduledFor = target.slot;

  const slotMoved =
    targetScheduledFor.getTime() !== input.existing.scheduledFor.getTime();

  const updated = !slotMoved
    ? await takeInPlace(
        input,
        resolvedTakenAt,
        wasTaken,
        target.attributionSource,
      )
    : await moveTake(
        input,
        resolvedTakenAt,
        targetScheduledFor,
        wasTaken,
        target.attributionSource,
      );
  return { kind: "updated" as const, row: updated };
}
