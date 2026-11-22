/**
 * The one rule for what a take recorded at a given moment does for the dose
 * a control names, shared by every take control in the web app: the intake
 * form, the medication card, the detail page and the table.
 *
 * The card's "Take (07:00 PM)" used to post the evening slot as
 * `scheduledFor` at noon. The server does not bind a named slot that lies
 * ahead of the take (a late-morning dose must never consume the evening
 * slot), so it filed an extra dose and the card said "taken" while the
 * 19:00 dose stayed open. The intake form already asked the right question;
 * this is that question, in one place:
 *
 *   - within the on-time half-window of the slot (an hour), the take counts
 *     for it through the server's band (`scheduledFor`);
 *   - further off, up to six hours, it still counts for that dose, pinned by
 *     the person's choice (`forceSlotInstant`, the server's USER_PIN), early
 *     before the slot and late after it;
 *   - further off than that it is an extra dose outside the plan
 *     (`extraDose`), and the control has to say so before the tap.
 *
 * A slot whose dose is already due, overdue or missed is not measured by
 * the gap: the server binds a named slot that lies behind the take, so
 * `scheduledFor` records it ("a late take still counts"). The card pins a
 * take on a slot still ahead whenever it counts (`cardTakeSlot`), because the
 * server never binds a named slot ahead of the take by `scheduledFor`; a pin
 * reads on time when the take falls inside the band's early grace.
 *
 * Client-safe and pure.
 */
import { DOSE_WINDOW_DEFAULTS } from "@/lib/medications/scheduling/dose-window-defaults";

/** The on-time half-window, in minutes (the dose-window default). */
export const ON_TIME_MINUTES = DOSE_WINDOW_DEFAULTS.dailyOnTimeMinutes;
/**
 * Past this gap a take answers no slot: six hours, the reach of the server's
 * nearest-slot rule (`NEAREST_SLOT_REACH_MS` in
 * `src/lib/medications/scheduling/nearest-open-slot.ts` is this constant).
 * A take that names no slot inside it is bound to the nearest open one by
 * the server; so a control that says "extra dose" inside it would be wrong,
 * and one that sends `extraDose` keeps the person's choice.
 */
export const NEAR_SLOT_CEILING_MINUTES = 360;

/** How far a take sits from the slot it is measured against. */
export type TakeReach = "exact" | "near" | "extra";

export function takeReach(gapMinutes: number): TakeReach {
  const gap = Math.abs(gapMinutes);
  if (gap <= ON_TIME_MINUTES) return "exact";
  if (gap <= NEAR_SLOT_CEILING_MINUTES) return "near";
  return "extra";
}

/**
 * What a take does for the slot a control names:
 *
 *   - `slot`   — counts for it through the server's band (`scheduledFor`);
 *   - `pinned` — counts for it by the person's choice (`forceSlotInstant`);
 *   - `extra`  — an extra dose outside the plan (no slot field).
 */
export type TakeBinding = "slot" | "pinned" | "extra";

/** The slot fields of an intake POST for a take of `binding` on `at`. */
export function takeSlotFields(
  binding: TakeBinding,
  at: Date,
): { scheduledFor?: string; forceSlotInstant?: string } {
  switch (binding) {
    case "slot":
      return { scheduledFor: at.toISOString() };
    case "pinned":
      return { forceSlotInstant: at.toISOString() };
    default:
      return {};
  }
}

/** The POST fields of a take: the slot fields, or the extra-dose flag. */
export function takeFields(
  binding: TakeBinding,
  at: Date,
): {
  scheduledFor?: string;
  forceSlotInstant?: string;
  extraDose?: true;
} {
  switch (binding) {
    case "extra":
      return { extraDose: true };
    default:
      return takeSlotFields(binding, at);
  }
}
