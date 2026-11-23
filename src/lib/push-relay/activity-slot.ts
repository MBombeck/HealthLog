/**
 * Matching the slot an app names for a Live Activity to the stored dose.
 *
 * The app derives the slot from its own copy of the schedule, to the minute
 * or the second; a rolling dose is stored to the millisecond the one before
 * it was taken at. So the two need not be equal, and an exact match left an
 * Activity of an answered dose running. Two doses of one medication are
 * never as close together as the tolerance.
 */
import { TRACKED_INTAKE_EVENT_WHERE } from "@/lib/medications/intake-tracking";

/** How far a named slot may lie from the stored instant of its dose. */
export const ACTIVITY_SLOT_TOLERANCE_MS = 59_999;

/** The stored instants that are the slot `slot` an Activity names. */
export function activitySlotWindow(slot: Date): { gte: Date; lte: Date } {
  return {
    gte: new Date(slot.getTime() - ACTIVITY_SLOT_TOLERANCE_MS),
    lte: new Date(slot.getTime() + ACTIVITY_SLOT_TOLERANCE_MS),
  };
}

/** Whether an Activity registered for `named` shows the dose stored at `stored`. */
export function sameActivitySlot(named: Date, stored: Date): boolean {
  return (
    Math.abs(named.getTime() - stored.getTime()) <= ACTIVITY_SLOT_TOLERANCE_MS
  );
}

/**
 * Whether a registered Activity shows the dose of `medicationId` stored at
 * `slot`: the same medication, and its named slot within the tolerance
 * ({@link sameActivitySlot}, the match the end path makes in the database
 * through {@link activitySlotWindow}). An Activity registered without a slot
 * shows every dose of its medication.
 */
export function activityShowsDose(
  activity: { medicationId: string; slotInstant: Date | null },
  medicationId: string,
  slot: Date,
): boolean {
  return (
    activity.medicationId === medicationId &&
    (activity.slotInstant === null ||
      sameActivitySlot(activity.slotInstant, slot))
  );
}

/**
 * The medications the server may start a Live Activity for, and keep one it
 * started running: tracked, active, neither paused nor ended, and with the
 * person's own Live Activity opt-in on the medication (`liveActivityEnabled`,
 * off by default), the switch the app plans its own Activities by.
 */
export const STARTABLE_MEDICATION_WHERE = {
  ...TRACKED_INTAKE_EVENT_WHERE.medication,
  active: true,
  pausedAt: null,
  endedAt: null,
  liveActivityEnabled: true,
} as const;
