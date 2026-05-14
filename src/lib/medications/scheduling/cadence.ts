/**
 * v1.4.25 W19e — pure cadence helpers for the medication detail page.
 *
 * Reads existing `MedicationSchedule` rows (`windowStart`, `windowEnd`,
 * `daysOfWeek` encoded via `serializeScheduleRecurrence`) plus the
 * recorded `MedicationIntakeEvent` stream, projects an expected-dose
 * timeline over a configurable window, and pairs each expected dose
 * with the closest actual intake (if any).
 *
 * No DB access here — every function takes pre-fetched rows. The API
 * route owns the prisma queries; this module owns the math. Same
 * shape as the W19d side-effects pure helpers.
 *
 * Why we do this client-side / server-side both: the section card on
 * the detail page renders a 30-day mini-chart; the same math feeds
 * the API JSON that drives the Compliance chips. Sharing one pure
 * module keeps the two surfaces from drifting.
 */

import { parseScheduleRecurrence } from "@/lib/medication-schedule";

export interface ScheduleLike {
  /** "HH:mm" 24h, user-tz reference (per existing schema). */
  windowStart: string;
  /** "HH:mm" 24h. May wrap midnight (`windowEnd < windowStart`). */
  windowEnd: string;
  /** Encoded recurrence string per `serializeScheduleRecurrence`. */
  daysOfWeek: string | null;
}

export interface IntakeEventLike {
  scheduledFor: Date;
  takenAt: Date | null;
  skipped: boolean;
}

/** One slot the schedule expected the user to dose. */
export interface ExpectedDose {
  /** Midnight of the local day this dose was expected. */
  day: Date;
  /** Start of the dose window for this day (Date with HH:mm applied). */
  windowStart: Date;
  /** End of the dose window for this day. */
  windowEnd: Date;
  /** Index into the parent schedules array (stable for chart layout). */
  scheduleIndex: number;
}

/** One slot paired with the closest matching intake event (if any). */
export interface PairedDose extends ExpectedDose {
  /** The matched intake event, or null if missed. */
  match: IntakeEventLike | null;
  /** Computed status. */
  status: "taken" | "skipped" | "missed" | "upcoming";
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/**
 * Match window for pairing an actual intake event to an expected
 * dose: +/- 12 hours around the slot's center.
 *
 * Rationale: the existing classifyIntakeTiming uses a 1-hour grace
 * before the window + ~2-hour late tolerance after. For cadence
 * visualisation we want a wider matching radius so users who logged a
 * weekly shot a day late still see it paired with that week's slot
 * (and the slot reads `taken`, not `missed` followed by an "extra").
 */
const PAIR_RADIUS_MS = 12 * 60 * 60 * 1000;

/** Build a Date for "HH:mm" applied to the local-day boundary of `day`. */
function applyTime(day: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
}

/** Snap a Date down to the local midnight. */
function startOfLocalDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

/** Snap a Date down to the Sunday-rooted local week. */
function startOfLocalWeek(d: Date): Date {
  const r = startOfLocalDay(d);
  r.setDate(r.getDate() - r.getDay());
  return r;
}

/**
 * Expand a single schedule into the list of dose slots it would have
 * generated between `from` (inclusive) and `to` (exclusive).
 *
 * Handles:
 *   - Daily cadence (no daysOfWeek restriction, intervalWeeks=1)
 *   - Weekly cadence (specific weekdays, intervalWeeks=1)
 *   - Bi-/tri-/quad-weekly cadence (intervalWeeks 2-4; phase is anchored
 *     to the week containing the medication's start, approximated here
 *     by the week containing `from` since the caller passes a stable
 *     anchor and we just need consistent every-Nth-week emission).
 *   - Overnight windows where `windowEnd < windowStart`.
 */
export function expandScheduleSlots(
  schedule: ScheduleLike,
  scheduleIndex: number,
  from: Date,
  to: Date,
  anchor: Date = from,
): ExpectedDose[] {
  if (to <= from) return [];

  const recurrence = parseScheduleRecurrence(schedule.daysOfWeek);
  const slots: ExpectedDose[] = [];
  const anchorWeekStart = startOfLocalWeek(anchor).getTime();

  const cursor = startOfLocalDay(from);
  const end = startOfLocalDay(to);
  // Iterate one extra day so an overnight window starting on `end - 1`
  // still emits — but the slot is only retained when `windowStart < to`.
  for (let day = cursor; day <= end; day = new Date(day.getTime() + DAY_MS)) {
    // Day-of-week constraint
    const dow = day.getDay();
    if (
      recurrence.daysOfWeek.length > 0 &&
      !recurrence.daysOfWeek.includes(dow)
    ) {
      continue;
    }

    // Multi-week interval constraint
    if (recurrence.intervalWeeks > 1) {
      const thisWeekStart = startOfLocalWeek(day).getTime();
      const weeksFromAnchor = Math.round(
        (thisWeekStart - anchorWeekStart) / WEEK_MS,
      );
      if (((weeksFromAnchor % recurrence.intervalWeeks) + recurrence.intervalWeeks) % recurrence.intervalWeeks !== 0) {
        continue;
      }
    }

    const wStart = applyTime(day, schedule.windowStart);
    let wEnd = applyTime(day, schedule.windowEnd);
    // Overnight window: windowEnd <= windowStart means next day.
    if (wEnd <= wStart) {
      wEnd = new Date(wEnd.getTime() + DAY_MS);
    }

    if (wStart >= to) continue;
    if (wEnd <= from) continue;

    slots.push({
      day,
      windowStart: wStart,
      windowEnd: wEnd,
      scheduleIndex,
    });
  }

  return slots;
}

/**
 * Pair each expected dose with its closest matching actual intake. An
 * intake "matches" a slot if its scheduledFor or takenAt lands within
 * `PAIR_RADIUS_MS` of the slot's window centre and no closer slot
 * claims it first.
 *
 * Determines status:
 *   - upcoming : slot is in the future (windowEnd > now)
 *   - taken    : matched event has takenAt != null and not skipped
 *   - skipped  : matched event is explicitly skipped
 *   - missed   : no match and slot is in the past
 */
export function pairDoses(
  slots: ExpectedDose[],
  events: IntakeEventLike[],
  now: Date,
): PairedDose[] {
  const claimed = new Set<number>();
  const result: PairedDose[] = [];

  // Sort slots by window centre so the earlier slot picks its match
  // first; same shape as the reminder-worker's "process schedules in
  // window order" loop.
  const sorted = [...slots].sort(
    (a, b) =>
      (a.windowStart.getTime() + a.windowEnd.getTime()) / 2 -
      (b.windowStart.getTime() + b.windowEnd.getTime()) / 2,
  );

  for (const slot of sorted) {
    const centre = (slot.windowStart.getTime() + slot.windowEnd.getTime()) / 2;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < events.length; i++) {
      if (claimed.has(i)) continue;
      const evt = events[i];
      const t = (evt.takenAt ?? evt.scheduledFor).getTime();
      const dist = Math.abs(t - centre);
      if (dist <= PAIR_RADIUS_MS && dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    let status: PairedDose["status"];
    let match: IntakeEventLike | null = null;
    if (bestIdx >= 0) {
      claimed.add(bestIdx);
      match = events[bestIdx];
      if (match.skipped) status = "skipped";
      else if (match.takenAt) status = "taken";
      else if (slot.windowEnd > now) status = "upcoming";
      else status = "missed";
    } else if (slot.windowEnd > now) {
      status = "upcoming";
    } else {
      status = "missed";
    }

    result.push({ ...slot, match, status });
  }

  // Restore the chronological order callers expect.
  return result.sort((a, b) => a.windowStart.getTime() - b.windowStart.getTime());
}

/**
 * Returns the next expected dose after `asOf`, expanding the given
 * schedules across the next `lookaheadDays`. Null when no schedule
 * has any upcoming slot in the lookahead window (e.g. paused med).
 */
export function computeNextDose(
  schedules: ScheduleLike[],
  asOf: Date,
  lookaheadDays = 14,
  anchor?: Date,
): ExpectedDose | null {
  const to = new Date(asOf.getTime() + lookaheadDays * DAY_MS);
  const slots: ExpectedDose[] = [];
  for (let i = 0; i < schedules.length; i++) {
    slots.push(...expandScheduleSlots(schedules[i], i, asOf, to, anchor ?? asOf));
  }
  if (slots.length === 0) return null;
  return slots.sort(
    (a, b) => a.windowStart.getTime() - b.windowStart.getTime(),
  )[0];
}

/**
 * 30-day (or other window) timeline of paired doses, oldest first.
 * The chart on the detail page maps each entry to one cell on the
 * track / heatmap.
 */
export function buildCadenceTimeline(
  schedules: ScheduleLike[],
  events: IntakeEventLike[],
  asOf: Date,
  windowDays = 30,
  anchor?: Date,
): PairedDose[] {
  const from = new Date(asOf.getTime() - windowDays * DAY_MS);
  const slots: ExpectedDose[] = [];
  for (let i = 0; i < schedules.length; i++) {
    slots.push(
      ...expandScheduleSlots(schedules[i], i, from, asOf, anchor ?? from),
    );
  }
  return pairDoses(slots, events, asOf);
}

/**
 * Count missed (no-taken-no-skipped, past-window) doses across a
 * rolling window. Distinct from the existing
 * `calculateCompliance({ days }).missed` which counts against the
 * expected count rather than pair-matching events; the W19e chips
 * read this for the "Missed last 30 days" value because it agrees
 * exactly with the timeline the user sees in the visualisation.
 */
export function missedDoses(
  schedules: ScheduleLike[],
  events: IntakeEventLike[],
  asOf: Date,
  windowDays = 30,
  anchor?: Date,
): number {
  const timeline = buildCadenceTimeline(
    schedules,
    events,
    asOf,
    windowDays,
    anchor,
  );
  return timeline.filter((d) => d.status === "missed").length;
}
