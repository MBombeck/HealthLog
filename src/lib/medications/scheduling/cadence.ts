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
 *
 * v1.4.25 W21 Fix-O — the local-day boundary helpers accept an
 * optional IANA `timeZone` argument (`Europe/Berlin`, `Asia/Tokyo`,
 * …). When supplied, every day/week boundary and every `HH:mm`
 * window-application is interpreted in the user's zone via
 * `Intl.DateTimeFormat` rather than the host's system time. The
 * cadence route resolves the zone through `resolveUserTimezone()`
 * and threads it through every helper. Omitting the argument falls
 * back to system-local — the legacy single-tz behaviour the v1.4.25
 * W19e tests pin.
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

interface WallClockParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Compute the wall-clock parts of `date` interpreted in the user's
 * timezone. When `tz` is omitted, falls back to the system-local
 * representation so the legacy single-tz callers keep their existing
 * shape (the v1.4.25 W19e callers were system-local by construction).
 */
function wallClockInTz(date: Date, tz: string | undefined): WallClockParts {
  if (!tz) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
      weekday: date.getDay(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "0";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAY_MAP[get("weekday")] ?? 0,
  };
}

/**
 * Compute the UTC offset (in minutes) of `tz` at the given instant.
 * Positive east of UTC. Honours DST because Intl does.
 */
function tzOffsetMinutes(date: Date, tz: string): number {
  const parts = wallClockInTz(date, tz);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return Math.round((asIfUtc - date.getTime()) / 60000);
}

/**
 * Build a Date instant for `YYYY-MM-DD HH:mm:ss` interpreted in the
 * supplied timezone. Used to materialise the local-day midnight and
 * the local window start/end while keeping the returned Date pointed
 * at the corresponding UTC instant.
 */
function instantInTz(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string | undefined,
): Date {
  if (!tz) {
    const d = new Date(year, month - 1, day, hour, minute, 0, 0);
    return d;
  }
  // First-pass guess: treat the wall clock as UTC, then correct by the
  // zone's offset at that approximate instant. Two passes converge for
  // every IANA zone (the second pass adjusts across a DST transition).
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  for (let i = 0; i < 2; i++) {
    const offsetMin = tzOffsetMinutes(guess, tz);
    guess = new Date(
      Date.UTC(year, month - 1, day, hour, minute, 0, 0) - offsetMin * 60_000,
    );
  }
  return guess;
}

/** Build a Date for "HH:mm" applied to the user-local day boundary of `day`. */
function applyTime(day: Date, hhmm: string, tz: string | undefined): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const parts = wallClockInTz(day, tz);
  return instantInTz(parts.year, parts.month, parts.day, h, m, tz);
}

/** Snap a Date down to the user-local midnight. */
function startOfLocalDay(d: Date, tz: string | undefined): Date {
  const parts = wallClockInTz(d, tz);
  return instantInTz(parts.year, parts.month, parts.day, 0, 0, tz);
}

/** Snap a Date down to the Sunday-rooted user-local week. */
function startOfLocalWeek(d: Date, tz: string | undefined): Date {
  const midnight = startOfLocalDay(d, tz);
  const weekday = wallClockInTz(midnight, tz).weekday;
  return new Date(midnight.getTime() - weekday * DAY_MS);
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
  timeZone?: string,
): ExpectedDose[] {
  if (to <= from) return [];

  const recurrence = parseScheduleRecurrence(schedule.daysOfWeek);
  const slots: ExpectedDose[] = [];
  const anchorWeekStart = startOfLocalWeek(anchor, timeZone).getTime();

  const cursor = startOfLocalDay(from, timeZone);
  const end = startOfLocalDay(to, timeZone);
  // Iterate one extra day so an overnight window starting on `end - 1`
  // still emits — but the slot is only retained when `windowStart < to`.
  // Step by adding 25h then snapping back to local midnight so DST
  // spring-forward / fall-back days still advance by exactly one
  // calendar day.
  for (
    let day = cursor;
    day.getTime() <= end.getTime();
    day = startOfLocalDay(new Date(day.getTime() + 25 * 60 * 60 * 1000), timeZone)
  ) {
    // Day-of-week constraint
    const dow = wallClockInTz(day, timeZone).weekday;
    if (
      recurrence.daysOfWeek.length > 0 &&
      !recurrence.daysOfWeek.includes(dow)
    ) {
      continue;
    }

    // Multi-week interval constraint
    if (recurrence.intervalWeeks > 1) {
      const thisWeekStart = startOfLocalWeek(day, timeZone).getTime();
      const weeksFromAnchor = Math.round(
        (thisWeekStart - anchorWeekStart) / WEEK_MS,
      );
      if (((weeksFromAnchor % recurrence.intervalWeeks) + recurrence.intervalWeeks) % recurrence.intervalWeeks !== 0) {
        continue;
      }
    }

    const wStart = applyTime(day, schedule.windowStart, timeZone);
    let wEnd = applyTime(day, schedule.windowEnd, timeZone);
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
  timeZone?: string,
): ExpectedDose | null {
  const to = new Date(asOf.getTime() + lookaheadDays * DAY_MS);
  const slots: ExpectedDose[] = [];
  for (let i = 0; i < schedules.length; i++) {
    slots.push(
      ...expandScheduleSlots(schedules[i], i, asOf, to, anchor ?? asOf, timeZone),
    );
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
  timeZone?: string,
): PairedDose[] {
  const from = new Date(asOf.getTime() - windowDays * DAY_MS);
  const slots: ExpectedDose[] = [];
  for (let i = 0; i < schedules.length; i++) {
    slots.push(
      ...expandScheduleSlots(
        schedules[i],
        i,
        from,
        asOf,
        anchor ?? from,
        timeZone,
      ),
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
  timeZone?: string,
): number {
  const timeline = buildCadenceTimeline(
    schedules,
    events,
    asOf,
    windowDays,
    anchor,
    timeZone,
  );
  return timeline.filter((d) => d.status === "missed").length;
}
