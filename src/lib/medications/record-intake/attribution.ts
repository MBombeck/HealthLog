/**
 * Which slot a dose posted to `POST /api/medications/{id}/intake` binds to,
 * and the binding provenance it records.
 *
 * Window-band slot attribution (replacing the wide ±6h `snapToleranceMs`
 * nearest-snap). The take is bound to a slot by membership in that slot's
 * configurable dose window — the SAME bands the read ledger + the compliance
 * % consume, so the three surfaces can never disagree. A take that lands in
 * no window is ad-hoc (`canonicalSlot` null) and records as a standalone
 * "taken now" row; PRN meds always insert standalone. Resolved BEFORE the
 * idempotency/dedup window so a scheduled dose routes through the slot upsert
 * (which is itself the dedup).
 *
 *   - SKIP: a skip is logged against a slot deliberately (it carries no
 *     `takenAt` to attribute by), so it keeps the canonical `scheduledFor`
 *     snap that binds it to the slot's pending REMINDER row.
 *   - TAKEN: attribute by `takenAt` band membership. The optional
 *     `forceSlotInstant` pins an off-window take onto a chosen real slot
 *     ("diesem Slot zuordnen?"); a pin that is not a real slot is a 422.
 */
import { annotate } from "@/lib/logging/context";
import type { SessionUser } from "@/lib/auth/session-user";
import {
  findPinConflictRow,
  pinConflictWire,
} from "@/lib/medications/scheduling/pin-conflict";
import {
  resolveForcedSlotForWrite,
  resolveSlotForWriteByBand,
  resolveSlotInstantForWrite,
} from "@/lib/medications/scheduling/slot-upsert";
import { bindNamedTake } from "@/lib/medications/scheduling/named-slot";

/** A coded 422 refusal the route answers with `apiError`. */
export interface IntakeWriteRefusal {
  kind: "refused";
  message: string;
  errorCode: string;
  /** On an occupied pin: the slot and the take that holds it. */
  meta?: ReturnType<typeof pinConflictWire>;
}

export type AttributionSource = "AUTO" | "USER_PIN";

export interface IntakeAttribution {
  kind: "attributed";
  canonicalSlot: Date | null;
  /**
   * USER_PIN on the forced "diesem Slot zuordnen" path, AUTO when band
   * attribution decided. Skips carry no binding decision (undefined → column
   * untouched/default).
   */
  attributionSource: AttributionSource | undefined;
}

interface AttributionInput {
  user: Pick<SessionUser, "id" | "timezone">;
  medicationId: string;
  skipped: boolean;
  scheduledFor: Date | undefined;
  forceSlotInstant: Date | undefined;
  /** A take recorded as an extra dose outside the plan. */
  extraDose?: boolean;
  resolvedTakenAt: Date | null;
  incomingScheduledFor: Date;
}

async function attributeSkip(input: AttributionInput): Promise<Date | null> {
  const { user, medicationId: id, scheduledFor, incomingScheduledFor } = input;
  if (scheduledFor === undefined) {
    // A slot-less deliberate skip resolves by band membership
    // on the skip moment, like a take does. The defaulted-now snap only
    // reached the tight reminder-grace window, so a skip tapped past it
    // landed as an orphan ad-hoc row while the slot's pending REMINDER
    // row stayed open to auto-miss.
    const attribution = await resolveSlotForWriteByBand({
      userId: user.id,
      medicationId: id,
      userTz: user.timezone,
      takenAt: incomingScheduledFor,
    });
    return attribution.slotInstant;
  }
  return resolveSlotInstantForWrite({
    userId: user.id,
    medicationId: id,
    userTz: user.timezone,
    incoming: incomingScheduledFor,
    instantIsExplicit: true,
    isTakenWrite: false,
  });
}

async function attributePin(
  input: AttributionInput,
  forceSlotInstant: Date,
): Promise<IntakeAttribution | IntakeWriteRefusal> {
  const { user, medicationId: id, resolvedTakenAt } = input;
  const canonicalSlot = await resolveForcedSlotForWrite({
    userId: user.id,
    medicationId: id,
    userTz: user.timezone,
    slotInstant: forceSlotInstant,
  });
  if (canonicalSlot === null) {
    annotate({
      action: { name: "medication.intake.force_slot.invalid" },
      meta: { medication_id: id },
    });
    return {
      kind: "refused",
      message: "forceSlotInstant is not a scheduled slot of this medication",
      errorCode: "medications.intake.force_slot.invalid",
    };
  }
  // Refuse to pin onto a slot another recorded action already
  // serves: the explicit-write last-write-wins rule would silently
  // overwrite that dose record. The ledger UI only offers the pin for
  // unserved slots, so this only fires for stale clients / raw API calls.
  const held = await findPinConflictRow({
    userId: user.id,
    medicationId: id,
    canonicalSlot,
    incomingTakenAt: resolvedTakenAt ?? null,
  });
  if (held) {
    annotate({
      action: { name: "medication.intake.force_slot.occupied" },
      meta: { medication_id: id },
    });
    return {
      kind: "refused",
      message: "forceSlotInstant already carries a recorded dose action",
      errorCode: "medications.intake.force_slot.occupied",
      meta: pinConflictWire(held),
    };
  }
  return { kind: "attributed", canonicalSlot, attributionSource: "USER_PIN" };
}

async function attributeTake(
  input: AttributionInput,
): Promise<IntakeAttribution> {
  const {
    user,
    medicationId: id,
    scheduledFor,
    resolvedTakenAt,
    incomingScheduledFor,
  } = input;
  // A non-skip write on this route always carries a `takenAt` (defaulted to
  // now), so `resolvedTakenAt` is non-null here; the fallback only guards the
  // type.
  const takenAt = resolvedTakenAt ?? incomingScheduledFor;
  const attribution = await resolveSlotForWriteByBand({
    userId: user.id,
    medicationId: id,
    userTz: user.timezone,
    takenAt,
  });
  // The client can NAME the dose it is recording (the Verlauf ledger's
  // "Genommen", the card's take of an open dose, the app on every write), and
  // a named real slot outranks the band when the take counts for it: behind
  // the take however late, ahead of it only from the slot's window on. The
  // one rule both intake routes share (`named-slot.ts`).
  const bound = await bindNamedTake({
    userId: user.id,
    medicationId: id,
    userTz: user.timezone,
    takenAt,
    bandSlot: attribution.slotInstant,
    namedSlot: scheduledFor === undefined ? undefined : incomingScheduledFor,
  });
  return { kind: "attributed", ...bound };
}

/** The slot the dose binds to, or the coded refusal of a bad pin. */
export async function resolveIntakeAttribution(
  input: AttributionInput,
): Promise<IntakeAttribution | IntakeWriteRefusal> {
  if (input.skipped) {
    return {
      kind: "attributed",
      canonicalSlot: await attributeSkip(input),
      attributionSource: undefined,
    };
  }
  if (input.forceSlotInstant !== undefined) {
    return attributePin(input, input.forceSlotInstant);
  }
  // An extra dose answers no slot. Stored as a released pin (USER_PIN on its
  // own instant), so no reader binds it to a band afterwards either.
  if (input.extraDose === true) {
    return {
      kind: "attributed",
      canonicalSlot: null,
      attributionSource: "USER_PIN",
    };
  }
  return attributeTake(input);
}
