/**
 * The slot a take binds to when the client names one (`scheduledFor`), for
 * both intake write routes: `POST /api/medications/{id}/intake` and every
 * entry of `POST /api/medications/intake/bulk`.
 *
 * Band attribution answers which slot the take's clock time falls into. A
 * named slot answers which dose the person meant, and it outranks the band
 * when it is a real slot of the medication and the take counts for it:
 *
 *   - the slot lies behind the take (a late take, a backfill from an earlier
 *     day): it counts, however late, because the person named that dose;
 *   - the slot lies ahead of the take, and the take sits inside the slot's
 *     window (from its early grace on): it counts. That is the dose the
 *     today read shows as `due` before its time, taken half an hour early;
 *   - the slot lies ahead and the take sits before its window: it does not
 *     count. A late-morning take must never consume the evening slot; a take
 *     meant for a dose that is not open yet names it as `forceSlotInstant`.
 *
 * The bulk route bound by the band alone, so the same take answered a slot on
 * one route and an extra dose on the other, and two doses whose windows
 * overlap went to whichever anchor sat nearer, not to the one the person
 * tapped.
 */
import type { SlotBand } from "@/lib/medications/scheduling/attribution";
import {
  resolveForcedSlotBandForWrite,
  TAKEN_SLOT_FORWARD_GRACE_MS,
} from "@/lib/medications/scheduling/slot-upsert";

/**
 * A named instant this close to the band's slot names that slot: the minute
 * of slop the pin validation allows for a client-echoed anchor.
 */
const SAME_SLOT_MS = 60_000;

/** Whether a take at `takenAt` counts for the named slot's band. */
export function namedSlotCountsForTake(
  band: Pick<SlotBand, "at" | "earlyStart">,
  takenAt: Date,
): boolean {
  const take = takenAt.getTime();
  return (
    band.at.getTime() <= take + TAKEN_SLOT_FORWARD_GRACE_MS ||
    take >= band.earlyStart.getTime()
  );
}

export interface NamedTakeBinding {
  canonicalSlot: Date | null;
  /**
   * `AUTO` when the band decided (or agrees with the named slot), `USER_PIN`
   * when the named slot overrode it: the read ledger then binds the take by
   * its stored anchor rather than by the clock.
   */
  attributionSource: "AUTO" | "USER_PIN";
}

/**
 * Bind a take: the named slot when it counts for the take, otherwise the
 * band's slot (or none).
 */
export async function bindNamedTake(input: {
  userId: string;
  medicationId: string;
  userTz: string;
  takenAt: Date;
  /** The slot the band put the take on, or null. */
  bandSlot: Date | null;
  /** The client's `scheduledFor`, when it sent one. */
  namedSlot: Date | undefined;
}): Promise<NamedTakeBinding> {
  const byBand: NamedTakeBinding = {
    canonicalSlot: input.bandSlot,
    attributionSource: "AUTO",
  };
  if (input.namedSlot === undefined) return byBand;
  // The usual case: the band already put the take on the slot it names. No
  // second read of the schedule (the bulk route runs this per entry).
  if (
    input.bandSlot !== null &&
    Math.abs(input.bandSlot.getTime() - input.namedSlot.getTime()) <=
      SAME_SLOT_MS
  ) {
    return byBand;
  }
  const band = await resolveForcedSlotBandForWrite({
    userId: input.userId,
    medicationId: input.medicationId,
    userTz: input.userTz,
    slotInstant: input.namedSlot,
  });
  if (band === null || !namedSlotCountsForTake(band, input.takenAt)) {
    return byBand;
  }
  if (band.at.getTime() === input.bandSlot?.getTime()) return byBand;
  return { canonicalSlot: band.at, attributionSource: "USER_PIN" };
}
