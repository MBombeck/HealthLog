/**
 * Which scheduled dose a logged intake counts for, said before it is saved.
 *
 * The three ways to log an intake used to ask this three ways: one form had
 * a "Schedule slot" picker, one asked "Attribute to this slot?" after the
 * save, one did not ask at all. The one intake form now reads the answer off
 * the chosen time and says it in words under the fields ("Counts for the
 * 08:00 dose"), and the write carries it:
 *
 *   - a take within the on-time half-window of a slot counts for it
 *     (`scheduledFor`, the server's canonical slot upsert);
 *   - a take further off but plausibly that dose (up to four hours) counts
 *     for it as late, unless the person switches that off (`forceSlotInstant`,
 *     the pin the history used to offer after the save);
 *   - anything else, or a medication without dose times, is an extra dose
 *     outside the schedule (no slot);
 *   - a skip always names the slot it skips (the nearest one on that day).
 *
 * Pure; the instants are read in the browser's zone, as the date-time field
 * writes them.
 */

export interface SlotSchedule {
  timesOfDay?: string[] | null;
  windowStart?: string | null;
}

/** The default on-time half-window in minutes (±1 h, the dose-window default). */
export const ON_TIME_MINUTES = 60;
/** Past this gap a take is clearly its own extra dose. */
export const NEAR_SLOT_CEILING_MINUTES = 240;

/** Distinct `HH:mm` dose times across the schedules, sorted. */
export function slotTimesOf(schedules: readonly SlotSchedule[]): string[] {
  const times = new Set<string>();
  for (const s of schedules) {
    if (s.timesOfDay && s.timesOfDay.length > 0) {
      for (const tod of s.timesOfDay) times.add(tod);
    } else if (s.windowStart) {
      times.add(s.windowStart);
    }
  }
  return Array.from(times).sort((a, b) => a.localeCompare(b));
}

/** The slot instant on the local day of `takenAtLocal` for an `HH:mm` slot. */
export function slotInstantOnDay(
  takenAtLocal: string,
  slotHm: string,
): Date | null {
  const datePart = takenAtLocal.slice(0, 10);
  if (datePart.length !== 10) return null;
  const d = new Date(`${datePart}T${slotHm}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface NearestSlot {
  slotHm: string;
  instant: Date;
  gapMinutes: number;
}

/** The dose time nearest to the chosen time on its own day, or null. */
export function nearestSlotForTake(
  takenAtLocal: string,
  times: readonly string[],
): NearestSlot | null {
  const taken = new Date(takenAtLocal);
  if (Number.isNaN(taken.getTime())) return null;
  let best: NearestSlot | null = null;
  for (const slotHm of times) {
    const instant = slotInstantOnDay(takenAtLocal, slotHm);
    if (!instant) continue;
    const gapMinutes = Math.abs(instant.getTime() - taken.getTime()) / 60_000;
    if (!best || gapMinutes < best.gapMinutes) {
      best = { slotHm, instant, gapMinutes };
    }
  }
  return best;
}

/** How a take sits against its nearest slot. */
export function classifyTake(
  nearest: NearestSlot | null,
): "exact" | "near" | "extra" {
  if (!nearest) return "extra";
  if (nearest.gapMinutes <= ON_TIME_MINUTES) return "exact";
  if (nearest.gapMinutes <= NEAR_SLOT_CEILING_MINUTES) return "near";
  return "extra";
}

export type SlotAttribution =
  | { kind: "slot"; slot: NearestSlot }
  | { kind: "late"; slot: NearestSlot }
  | { kind: "extra"; nearSlot: NearestSlot | null }
  | { kind: "skip"; slot: NearestSlot }
  | { kind: "none" };

/**
 * What the form will record. `countNear` is the person's switch for a take
 * near, but outside, a slot's on-time window (default on).
 */
export function attributeIntake(input: {
  takenAtLocal: string;
  times: readonly string[];
  skipped: boolean;
  countNear: boolean;
}): SlotAttribution {
  const nearest = nearestSlotForTake(input.takenAtLocal, input.times);
  if (input.skipped) {
    return nearest ? { kind: "skip", slot: nearest } : { kind: "none" };
  }
  const how = classifyTake(nearest);
  if (how === "exact" && nearest) return { kind: "slot", slot: nearest };
  if (how === "near" && nearest) {
    return input.countNear
      ? { kind: "late", slot: nearest }
      : { kind: "extra", nearSlot: nearest };
  }
  return { kind: "extra", nearSlot: null };
}

/** The slot fields of the intake POST for an attribution. */
export function slotFieldsOf(attribution: SlotAttribution): {
  scheduledFor?: string;
  forceSlotInstant?: string;
} {
  switch (attribution.kind) {
    case "slot":
    case "skip":
      return { scheduledFor: attribution.slot.instant.toISOString() };
    case "late":
      return { forceSlotInstant: attribution.slot.instant.toISOString() };
    default:
      return {};
  }
}
