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
 *   - anything else, or a day without an open slot, is an extra dose
 *     outside the schedule (no slot);
 *   - a skip always names the slot it skips (the nearest one on that day).
 *
 * The slots come from the server's dose ledger for the chosen day
 * (`openSlotsOf`), never from the schedule on the client: a weekly
 * medication's off day, an interval week that does not fall due and a rolling
 * cadence's gap have no slot there, and a slot already taken or skipped is
 * not offered again. The forced slot the server accepts
 * (`resolveForcedSlotForWrite`) is exactly a ledger slot instant.
 *
 * Pure.
 */

/** A ledger row as `GET /api/medications/[id]/dose-history` sends it. */
export interface DayLedgerRow {
  kind: "slot" | "ad_hoc";
  at: string;
  timeOfDay: string | null;
  state?: string | null;
}

/** A slot the chosen day really has: its `HH:mm` label and its instant. */
export interface DaySlot {
  slotHm: string;
  instant: Date;
}

/** The default on-time half-window in minutes (±1 h, the dose-window default). */
export const ON_TIME_MINUTES = 60;
/** Past this gap a take is clearly its own extra dose. */
export const NEAR_SLOT_CEILING_MINUTES = 240;

/**
 * The slots of one day's ledger a dose can still count for: slot rows inside
 * `[dayStart, dayEnd)`, minus those already taken or skipped, sorted.
 */
export function openSlotsOf(
  rows: readonly DayLedgerRow[],
  window: { dayStart: Date; dayEnd: Date },
): DaySlot[] {
  const slots: DaySlot[] = [];
  for (const row of rows) {
    if (row.kind !== "slot" || !row.timeOfDay) continue;
    if (row.state === "taken" || row.state === "skipped") continue;
    const instant = new Date(row.at);
    const ms = instant.getTime();
    if (Number.isNaN(ms)) continue;
    if (ms < window.dayStart.getTime() || ms >= window.dayEnd.getTime()) {
      continue;
    }
    slots.push({ slotHm: row.timeOfDay, instant });
  }
  return slots.sort((a, b) => a.instant.getTime() - b.instant.getTime());
}

export interface NearestSlot {
  slotHm: string;
  instant: Date;
  gapMinutes: number;
}

/** The open slot nearest to the chosen time, or null. */
export function nearestSlotForTake(
  takenAtLocal: string,
  slots: readonly DaySlot[],
): NearestSlot | null {
  const taken = new Date(takenAtLocal);
  if (Number.isNaN(taken.getTime())) return null;
  let best: NearestSlot | null = null;
  for (const { slotHm, instant } of slots) {
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
  slots: readonly DaySlot[];
  skipped: boolean;
  countNear: boolean;
}): SlotAttribution {
  const nearest = nearestSlotForTake(input.takenAtLocal, input.slots);
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
