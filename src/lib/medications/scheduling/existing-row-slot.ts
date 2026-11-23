/**
 * Which slot a take recorded on an EXISTING intake row binds to.
 *
 * A row already names its dose: its `scheduledFor`. The status route
 * (`POST /api/medications/intake`) and the per-event PUT both address one
 * concrete row, so that anchor is the binding, the same way the per-medication
 * route honours a slot the client names. Re-binding by the clock time of the
 * take alone moved a confirmed dose off its slot whenever "now" sat in no
 * band: saving the injection site a moment after a late take, or marking an
 * overdue reminder row as taken, tombstoned the slot row, filed the dose as
 * ad-hoc, and left the slot to read as missed.
 *
 * Two cases, by what the row held before the write:
 *
 *   - An OPEN row (pending, or skipped and now taken) answers the dose it
 *     was minted for. Its anchor wins when it is a real slot of the medication
 *     and does not sit ahead of the take (the forward guard of the
 *     per-medication route: a late-morning take never consumes the evening
 *     slot). Marking an overdue reminder row as taken is that dose, taken late.
 *   - A TAKEN row whose time is corrected follows the band when the corrected
 *     time falls in a slot's window (the time edit says which dose it was);
 *     when it falls in none, the row keeps its own anchor under the same
 *     checks rather than dropping to ad-hoc.
 *
 * When the band agrees with the anchor the binding is AUTO; when only the
 * row's anchor holds it, it is USER_PIN, which is what the read ledger and the
 * compliance engine bind by anchor rather than by clock. Everything else is
 * band attribution, ad-hoc at the take's time on a miss.
 */
import {
  mayConvergeOntoSuppliedSlot,
  resolveForcedSlotForWrite,
  resolveSlotForWriteByBand,
} from "@/lib/medications/scheduling/slot-upsert";

export interface ExistingRowTakeSlot {
  slotInstant: Date;
  attributionSource: "AUTO" | "USER_PIN";
}

export async function resolveTakeSlotForExistingRow(input: {
  userId: string;
  medicationId: string;
  userTz: string;
  rowScheduledFor: Date;
  /** Whether the row was already taken before this write. */
  rowWasTaken: boolean;
  takenAt: Date;
}): Promise<ExistingRowTakeSlot> {
  const { userId, medicationId, userTz, rowScheduledFor, takenAt } = input;
  const band = await resolveSlotForWriteByBand({
    userId,
    medicationId,
    userTz,
    takenAt,
  });
  if (input.rowWasTaken && band.slotInstant !== null) {
    return { slotInstant: band.slotInstant, attributionSource: "AUTO" };
  }
  if (
    mayConvergeOntoSuppliedSlot({
      skipped: false,
      takenAt,
      suppliedSlot: rowScheduledFor,
    })
  ) {
    const own = await resolveForcedSlotForWrite({
      userId,
      medicationId,
      userTz,
      slotInstant: rowScheduledFor,
    });
    if (own !== null) {
      return {
        slotInstant: own,
        attributionSource:
          band.slotInstant?.getTime() === own.getTime() ? "AUTO" : "USER_PIN",
      };
    }
  }
  return {
    slotInstant: band.slotInstant ?? takenAt,
    attributionSource: "AUTO",
  };
}
