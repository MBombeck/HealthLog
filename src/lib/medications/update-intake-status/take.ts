/**
 * A "taken" status update on one intake row. The row already names its dose,
 * so the take keeps that slot (`resolveTakeSlotForExistingRow`): confirming
 * the injection site, re-marking a row, or marking an overdue reminder row as
 * taken never moves the dose off its slot by the clock time of the request.
 * A take that only documents an already-taken row (no `takenAt`) leaves its
 * time and slot untouched. `forceSlotInstant` pins onto a named real slot
 * (422 if it is not one). Mirrors the per-event PUT route.
 */
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
import {
  isRowWriteRefusal,
  moveRowToSlot,
  updateLiveRow,
  type RowWriteRefusal,
} from "@/lib/medications/scheduling/slot-move";
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
  takenVia: "WEB" | "APP";
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

/** The refusal of a by-id write that found its row gone or its slot taken. */
export function rowWriteRefused(reason: RowWriteRefusal): IntakeStatusRefusal {
  return reason === "gone"
    ? {
        kind: "refused",
        message: "Intake event not found",
        status: 404,
        errorCode: "medications.notFound",
      }
    : {
        kind: "refused",
        message: "The slot the dose would move to already holds a take",
        status: 422,
        errorCode: "medications.intake.force_slot.occupied",
      };
}

async function takeInPlace(
  input: TakeInput,
  resolvedTakenAt: Date,
  wasTaken: boolean,
  attributionSource: TargetSlot["attributionSource"],
) {
  const { userId, intakeId, existing, resolvedInjectionSite } = input;
  // Under the slot lock and only on a live row, so a take racing an undo
  // never lands on the tombstone.
  return updateLiveRow(
    {
      userId,
      medicationId: existing.medicationId,
      id: intakeId,
      slot: existing.scheduledFor,
    },
    {
      takenAt: resolvedTakenAt,
      skipped: false,
      // The person confirmed it; no longer automatic, and no longer a miss.
      autoRecorded: false,
      autoMissed: false,
      ...(!wasTaken && { takenVia: input.takenVia }),
      ...(attributionSource !== undefined && { attributionSource }),
      syncVersion: { increment: 1 },
      ...(resolvedInjectionSite !== null && {
        injectionSite: resolvedInjectionSite,
      }),
    },
    async (tx) => {
      await tx.medication.update({
        where: { id: existing.medicationId },
        data: { snoozedUntil: null },
      });
      // Consume on the genuine pending→taken (or skipped→taken)
      // transition; the stamp keeps a racing replay exactly-once.
      if (!wasTaken) {
        await consumeForIntake({
          client: tx,
          userId,
          medicationId: existing.medicationId,
          eventId: intakeId,
          intakeAt: resolvedTakenAt,
        });
      }
    },
  );
}

/**
 * The take re-attributed to a different slot: tombstone the source row and
 * route the dose through the shared canonical-slot upsert, in one locked
 * transaction (`slot-move.ts`). A target slot that already holds a take
 * refuses the move and leaves the source row as it was.
 *
 * The source row's consumption stamp is refunded and the converged row
 * consumes: a slot move is a re-binding of one real dose, so the stock nets
 * exactly one consumption.
 */
async function moveTake(
  input: TakeInput,
  resolvedTakenAt: Date,
  targetScheduledFor: Date,
  wasTaken: boolean,
  attributionSource: TargetSlot["attributionSource"],
) {
  const { userId, intakeId, existing, resolvedInjectionSite } = input;
  const medicationId = existing.medicationId;
  return moveRowToSlot(
    {
      userId,
      medicationId,
      id: intakeId,
      slot: existing.scheduledFor,
      target: targetScheduledFor,
    },
    (tx) =>
      applyCanonicalSlotWrite({
        client: tx,
        userId,
        medicationId,
        canonicalSlot: targetScheduledFor,
        takenAt: resolvedTakenAt,
        skipped: false,
        isExplicitTaken: true,
        isExplicitSkip: false,
        idempotencyKey: null,
        // The row the dose lands on says which transport wrote it, like
        // every other writer: the app's Bearer call `API`, the browser `WEB`.
        createSource: input.takenVia === "APP" ? "API" : "WEB",
        attributionSource,
        takenVia: input.takenVia,
        // A slot move is a re-binding, not a new dose: the original row's
        // site and dose override survive when the toggle carries none.
        injectionSite:
          resolvedInjectionSite ??
          (existing.injectionSite as InjectionSiteValue | null),
        doseTaken: existing.doseTaken,
      }),
    async (tx, applied) => {
      await restoreForIntake({ client: tx, userId, eventId: intakeId });
      await tx.medication.update({
        where: { id: medicationId },
        data: { snoozedUntil: null },
      });
      // A taken source WITHOUT a stamp is a pre-v1.16.10 row whose stock
      // moved through the legacy hook: the refund was a no-op, so consuming
      // on the target would double-charge.
      if (!wasTaken || existing.inventoryConsumption !== null) {
        await consumeForIntake({
          client: tx,
          userId,
          medicationId,
          eventId: applied.row.id,
          intakeAt: resolvedTakenAt,
        });
      }
      return applied.row;
    },
  );
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

  const written = !slotMoved
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
  if (isRowWriteRefusal(written)) return rowWriteRefused(written);
  return { kind: "updated" as const, row: written };
}
