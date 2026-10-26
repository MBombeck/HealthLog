/**
 * Which slot one bulk intake entry binds to.
 *
 * Taken writes attribute through the window-band engine (the SAME minter the
 * read ledger + the compliance % consume), so a bulk-synced take binds to a
 * slot identically to the single-route write. The optional
 * `forceSlotInstant` pins an off-window take onto a named real slot. Pending
 * echoes and skips carry no take to attribute by, so they keep the canonical
 * anchor snap that binds them to the projector/worker-minted slot row.
 */
import type { SessionUser } from "@/lib/auth/session-user";
import {
  findPinConflict,
  resolveForcedSlotForWrite,
  resolveSlotForWriteByBand,
  resolveSlotInstantForWrite,
  slotHeldByAnotherDose,
} from "@/lib/medications/scheduling/slot-upsert";
import type { BulkIntakeEntry } from "./batch-state";

export interface EntryAttribution {
  canonicalSlot: Date | null;
  /**
   * Binding provenance: USER_PIN on the forced path, AUTO on a band
   * decision. Pending echoes / skips carry no decision (undefined → the
   * upsert leaves an existing USER_PIN untouched).
   */
  attributionSource: "AUTO" | "USER_PIN" | undefined;
  /**
   * Set when the band slot is held by a different dose and this take is
   * recorded unscheduled; it must not converge onto any slot row.
   */
  heldByAnotherDose: boolean;
}

interface EntryContext {
  user: Pick<SessionUser, "id" | "timezone">;
  entry: BulkIntakeEntry;
  incomingScheduledFor: Date;
}

async function attributePin(
  ctx: EntryContext,
  forceSlotInstant: Date,
): Promise<EntryAttribution | { reason: string }> {
  const { user, entry } = ctx;
  const canonicalSlot = await resolveForcedSlotForWrite({
    userId: user.id,
    medicationId: entry.medicationId,
    userTz: user.timezone,
    slotInstant: forceSlotInstant,
  });
  if (canonicalSlot === null) {
    // Mirrors the single route's 422 (`medications.intake.force_slot
    // .invalid`) as a per-entry skip so one bad pin never fails the
    // batch.
    return { reason: "force_slot_invalid" };
  }
  // Refuse to pin onto a slot another recorded action
  // already serves: the explicit-write last-write-wins rule would
  // silently overwrite that dose record. Per-entry skip, mirroring
  // the single route's 422 `medications.intake.force_slot.occupied`.
  if (
    await findPinConflict({
      userId: user.id,
      medicationId: entry.medicationId,
      canonicalSlot,
      incomingTakenAt: entry.takenAt ?? null,
    })
  ) {
    return { reason: "force_slot_occupied" };
  }
  return {
    canonicalSlot,
    attributionSource: "USER_PIN",
    heldByAnotherDose: false,
  };
}

async function attributeTake(ctx: EntryContext): Promise<EntryAttribution> {
  const { user, entry } = ctx;
  const attribution = await resolveSlotForWriteByBand({
    userId: user.id,
    medicationId: entry.medicationId,
    userTz: user.timezone,
    takenAt: entry.takenAt as Date,
  });
  let canonicalSlot = attribution.slotInstant;
  let heldByAnotherDose = false;
  // An external dose record (a HealthKit dose event) whose band slot
  // already carries a different recorded dose is an extra dose, not a
  // correction of that one. Converging would overwrite the slot's
  // take last-write-wins and the extra dose would exist nowhere; it is
  // recorded as its own unscheduled dose instead.
  if (
    canonicalSlot !== null &&
    entry.externalId !== undefined &&
    (await slotHeldByAnotherDose({
      userId: user.id,
      medicationId: entry.medicationId,
      canonicalSlot,
      takenAt: entry.takenAt as Date,
      externalId: entry.externalId,
      scheduledFor: entry.scheduledFor ?? null,
      userTz: user.timezone,
    }))
  ) {
    canonicalSlot = null;
    heldByAnotherDose = true;
  }
  return { canonicalSlot, attributionSource: "AUTO", heldByAnotherDose };
}

/**
 * The slot of one entry, or the per-entry skip reason of a bad pin. The
 * write flags say what the entry is: an offline-sync replay echoes a PENDING
 * projection (no `takenAt`, `skipped:false`) for a slot the user may already
 * have actioned; an explicit `takenAt` or `skipped:true` is a real user
 * action and applies last-write-wins.
 */
export async function attributeEntry(
  ctx: EntryContext,
  flags: { isExplicitTaken: boolean; isExplicitSkip: boolean },
): Promise<EntryAttribution | { reason: string }> {
  const { user, entry, incomingScheduledFor } = ctx;
  if (flags.isExplicitTaken && entry.forceSlotInstant !== undefined) {
    return attributePin(ctx, entry.forceSlotInstant);
  }
  if (flags.isExplicitTaken) {
    return attributeTake(ctx);
  }
  if (flags.isExplicitSkip && entry.scheduledFor === undefined) {
    // A slot-less deliberate skip resolves by band
    // membership on the skip moment, exactly like a take does. The
    // defaulted-now snap below only reaches the tight reminder-grace
    // window, so a skip tapped 20 minutes past the dose time inserted
    // an orphan ad-hoc skip row while the slot's pending REMINDER row
    // stayed open and later auto-missed — the user's deliberate skip
    // recorded as a miss.
    const attribution = await resolveSlotForWriteByBand({
      userId: user.id,
      medicationId: entry.medicationId,
      userTz: user.timezone,
      takenAt: incomingScheduledFor,
    });
    return {
      canonicalSlot: attribution.slotInstant,
      attributionSource: undefined,
      heldByAnotherDose: false,
    };
  }
  // Source-agnostic anchor snap for pending echoes + skips.
  // iOS posts the reminder actions here (source API); without this
  // they inserted a SECOND row for a slot already carrying the
  // projector/worker's pending REMINDER row (the unique key includes
  // `source`, and the iOS-vs-server `scheduledFor` drifts by a
  // minute). Snap onto the canonical slot instant and update the
  // existing row in place.
  const canonicalSlot = await resolveSlotInstantForWrite({
    userId: user.id,
    medicationId: entry.medicationId,
    userTz: user.timezone,
    incoming: incomingScheduledFor,
    // Only a client-supplied `scheduledFor` names a real slot. A
    // defaulted-now write must not snap across the wide ±halfGap
    // window onto a far slot (phantom morning dose).
    instantIsExplicit: entry.scheduledFor !== undefined,
    // Pending echoes / skips never record a take; a pending sync
    // echo legitimately maps to a future slot, so the taken
    // future-slot guard stays off here.
    isTakenWrite: false,
  });
  return {
    canonicalSlot,
    attributionSource: undefined,
    heldByAnotherDose: false,
  };
}
