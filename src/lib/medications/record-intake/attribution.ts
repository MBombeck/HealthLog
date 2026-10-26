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
  findPinConflict,
  mayConvergeOntoSuppliedSlot,
  resolveForcedSlotForWrite,
  resolveSlotForWriteByBand,
  resolveSlotInstantForWrite,
} from "@/lib/medications/scheduling/slot-upsert";

/** A coded 422 refusal the route answers with `apiError`. */
export interface IntakeWriteRefusal {
  kind: "refused";
  message: string;
  errorCode: string;
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
  if (
    await findPinConflict({
      userId: user.id,
      medicationId: id,
      canonicalSlot,
      incomingTakenAt: resolvedTakenAt ?? null,
    })
  ) {
    annotate({
      action: { name: "medication.intake.force_slot.occupied" },
      meta: { medication_id: id },
    });
    return {
      kind: "refused",
      message: "forceSlotInstant already carries a recorded dose action",
      errorCode: "medications.intake.force_slot.occupied",
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
    skipped,
    scheduledFor,
    resolvedTakenAt,
    incomingScheduledFor,
  } = input;
  // A non-skip write on this route always carries a `takenAt` (defaulted to
  // now), so `resolvedTakenAt` is non-null here; the fallback only guards the
  // type.
  const attribution = await resolveSlotForWriteByBand({
    userId: user.id,
    medicationId: id,
    userTz: user.timezone,
    takenAt: resolvedTakenAt ?? incomingScheduledFor,
  });
  let canonicalSlot = attribution.slotInstant;
  // A band decision (slot or ad-hoc) is an AUTO binding; it also resets a
  // stale USER_PIN when this write converges onto a previously-pinned row.
  let attributionSource: AttributionSource = "AUTO";

  // The client can NAME the dose it is recording, and when it does, that
  // answer outranks the band. The Verlauf ledger's "Genommen" posts the
  // displayed slot's own anchor, and the medication card posts its
  // display-due slot; both mean "record THIS dose". Band attribution answers
  // a different question — which slot the take's clock time falls into — so
  // backfilling a slot from an earlier day matched no band, fell through to
  // the standalone insert, and left the named slot unserved: the entry
  // reverted to missed on the next read and the dose the user recorded was
  // filed on the wrong day.
  //
  // Only a REAL slot of this medication is honoured (the same band-anchor
  // validation the "diesem Slot zuordnen" pin runs), so an arbitrary client
  // instant still records ad-hoc rather than parking a live row on a
  // fabricated anchor. And only a slot that does not sit ahead of the take,
  // by the same forward guard the convergence probe uses — a
  // late-morning dose must never consume the evening slot.
  if (
    scheduledFor !== undefined &&
    mayConvergeOntoSuppliedSlot({
      skipped,
      takenAt: resolvedTakenAt,
      suppliedSlot: incomingScheduledFor,
    })
  ) {
    const namedSlot = await resolveForcedSlotForWrite({
      userId: user.id,
      medicationId: id,
      userTz: user.timezone,
      slotInstant: incomingScheduledFor,
    });
    // Only when the naming actually decides something the clock did not.
    // A dose taken inside its own window resolves to the same anchor either
    // way and stays an AUTO binding, so an ordinary on-time take is
    // unchanged. When the two disagree the binding rests on the user's
    // choice, which is what USER_PIN records — and the read ledger binds a
    // USER_PIN take by its stored anchor rather than by the clock, so a
    // backfilled dose reads under the slot it was recorded for instead of
    // falling back to ad-hoc.
    if (
      namedSlot !== null &&
      namedSlot.getTime() !== canonicalSlot?.getTime()
    ) {
      canonicalSlot = namedSlot;
      attributionSource = "USER_PIN";
    }
  }
  return { kind: "attributed", canonicalSlot, attributionSource };
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
  return attributeTake(input);
}
