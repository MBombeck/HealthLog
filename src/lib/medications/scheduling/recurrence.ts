/**
 * v1.5.0 — canonical recurrence engine for medication scheduling.
 *
 * Single source of truth for "what dose slots does this schedule emit
 * between A and B?" The canonical engine is introduced in this release;
 * the v1.5.0 cut wires only the reminder worker (via
 * `worker-helpers.ts`) through it. The today-projector
 * (`expandTodayIntakes`), the cadence chart (`expandScheduleSlots`),
 * the medication card (`getNextOccurrenceTimestamp`), and the
 * form-level helpers continue on the legacy walker through v1.5.x and
 * migrate in v1.5.1 per the read-flip plan.
 *
 * Dispatch tiers (first matching tier wins):
 *
 *   1. **One-shot** (`medication.oneShot === true`) — single slot at
 *      the anchor date, one per `timesOfDay` entry.
 *   2. **Rolling** (`schedule.rollingIntervalDays !== null`) — next
 *      slot is `lastIntakeAt + N days` (or `startsOn + N days` if
 *      the user has never logged an intake). Only the immediately
 *      next slot is emitted; further slots depend on the user
 *      actually logging the intake.
 *   3. **RRULE** (`schedule.rrule !== null`) — RFC 5545 expansion
 *      via the `rrule` npm lib. Day-anchored dates are returned in
 *      UTC by the library; each `timesOfDay` entry is then applied
 *      to that day in the user's IANA timezone (DST-aware via
 *      `wallClockInTz`).
 *   4. **Legacy fallback** — both `rrule` and `rollingIntervalDays`
 *      are NULL and `oneShot` is false. Decodes the legacy
 *      `daysOfWeek` string via `parseScheduleRecurrence` and emits
 *      weekly slots. **Honours `intervalWeeks > 1` correctly** —
 *      the existing `expandTodayIntakes` skipped it (the legacy
 *      bi-weekly worker bug R-3 finding 5 calls out); this engine
 *      anchors the week phase to `startsOn ?? createdAt` and emits
 *      on the matching weeks only.
 *
 * Pure functions, no DB access. Caller fetches `lastIntakeAt`
 * (latest `MedicationIntakeEvent.takenAt`) and threads it through
 * `RecurrenceContext`.
 */

import { RRule } from "rrule";

import { annotate } from "@/lib/logging/context";
import { parseScheduleRecurrence } from "@/lib/medication-schedule";
import { wallClockInTz } from "@/lib/tz/wall-clock";

/**
 * v1.7.0 — schedule-type discriminator on the canonical schedule.
 * SCHEDULED keeps the rrule / rolling / legacy dispatch unchanged. PRN
 * emits no slots (it is as-needed — never projected, reminded, or
 * counted in compliance-expected, but still loggable). CYCLIC gates
 * whichever inner cadence (rrule / legacy) the schedule describes by an
 * N-weeks-on / M-weeks-off phase anchored to `startsOn ?? createdAt`.
 */
export const SCHEDULE_TYPES = ["SCHEDULED", "PRN", "CYCLIC"] as const;
export type ScheduleType = (typeof SCHEDULE_TYPES)[number];

export interface CanonicalSchedule {
  id: string;
  rrule: string | null;
  rollingIntervalDays: number | null;
  timesOfDay: string[];
  /**
   * Legacy fallback fields. Read-only — the engine consults these
   * only when `rrule` and `rollingIntervalDays` are both NULL and
   * `oneShot` is false. Pre-v1.5 rows always populate these.
   */
  daysOfWeek: string | null;
  windowStart: string;
  windowEnd: string;
  reminderGraceMinutes: number | null;
  /**
   * v1.7.0 — schedule type. Defaults to SCHEDULED for every pre-v1.7
   * row. PRN short-circuits the engine to zero slots; CYCLIC wraps the
   * inner cadence with an on/off-week phase gate.
   */
  scheduleType: ScheduleType;
  /** v1.7.0 — cyclic "on" weeks. Only read when `scheduleType === "CYCLIC"`. */
  cyclicOnWeeks: number | null;
  /** v1.7.0 — cyclic "off" weeks. Only read when `scheduleType === "CYCLIC"`. */
  cyclicOffWeeks: number | null;
}

export interface RecurrenceContext {
  /** The parent medication. */
  medication: {
    id: string;
    startsOn: Date | null;
    endsOn: Date | null;
    oneShot: boolean;
    createdAt: Date;
  };
  /** The user's IANA timezone (e.g. "Europe/Berlin"). */
  timeZone: string;
  /**
   * Latest `MedicationIntakeEvent.takenAt` for this medication.
   * Used only by rolling schedules. Null when the user has never
   * logged an intake (rolling then anchors on `startsOn ?? createdAt`).
   */
  lastIntakeAt: Date | null;
}

export interface Occurrence {
  /**
   * The start instant of this occurrence. The `timeOfDay` is applied
   * to the day in the user's timezone, with DST handled correctly via
   * the existing `wallClockInTz` two-pass solver.
   */
  at: Date;
  /**
   * The grace-window end instant. Computed from
   * `reminderGraceMinutes` when set, otherwise from the legacy
   * `windowEnd - windowStart` span.
   */
  graceUntil: Date;
  /**
   * Which `timesOfDay` entry this occurrence corresponds to (or
   * `windowStart` when falling back to legacy). Lets the UI label
   * "Morning dose" vs "Evening dose" of the same day.
   */
  timeOfDay: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const DEFAULT_GRACE_MINUTES = 60;
const ONE_MINUTE_MS = 60_000;

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Emit every occurrence in `[from, to]` (inclusive of both ends) in
 * chronological order. Pure: no DB access, no side effects.
 */
export function occurrencesBetween(
  schedule: CanonicalSchedule,
  from: Date,
  to: Date,
  ctx: RecurrenceContext,
): Occurrence[] {
  if (to.getTime() < from.getTime()) return [];

  // v1.7.0 — PRN (as-needed) emits no scheduled slots. It is loggable
  // through the intake route but never projected, reminded, or counted
  // in compliance-expected. The early return keeps every downstream
  // surface (projector, worker, compliance) PRN-aware in one place.
  if (schedule.scheduleType === "PRN") return [];

  let slots: Occurrence[];
  if (ctx.medication.oneShot) {
    slots = expandOneShot(schedule, ctx, from, to);
  } else if (schedule.rollingIntervalDays !== null) {
    slots = expandRolling(schedule, ctx, from, to);
  } else if (schedule.rrule !== null) {
    slots = expandRrule(schedule, ctx, from, to);
  } else {
    slots = expandLegacy(schedule, ctx, from, to);
  }

  // v1.7.0 — CYCLIC gate. Drop any slot that lands in an "off" week of
  // the N-on / M-off cycle. The inner cadence (rrule / legacy / rolling
  // / one-shot) still decides which days emit within an "on" week; this
  // only suppresses the off-week slots. Composes with `intervalWeeks`
  // (the inner legacy stride) because the two phase computations are
  // independent: the legacy stride filters weeks first, the cyclic gate
  // filters the surviving slots second.
  if (schedule.scheduleType === "CYCLIC") {
    return slots.filter((s) => isInCyclicOnWeek(s.at, schedule, ctx));
  }
  return slots;
}

/**
 * v1.7.0 — true when `instant` falls in an "on" week of the cyclic
 * on/off phase. The anchor is the medication's `startsOn ?? createdAt`,
 * snapped to its UTC week start. `phase = weeksFromAnchor mod
 * (on + off)`; the slot survives iff `phase < on`. A non-positive or
 * missing `cyclicOnWeeks` keeps every slot (defensive — the route + Zod
 * require a positive value for CYCLIC, but the engine never throws on a
 * malformed row).
 */
function isInCyclicOnWeek(
  instant: Date,
  schedule: CanonicalSchedule,
  ctx: RecurrenceContext,
): boolean {
  const onWeeks = schedule.cyclicOnWeeks;
  const offWeeks = schedule.cyclicOffWeeks ?? 0;
  if (onWeeks === null || onWeeks <= 0) return true;
  const cycleLen = onWeeks + offWeeks;
  if (cycleLen <= 0) return true;

  const anchor = ctx.medication.startsOn ?? ctx.medication.createdAt;
  const anchorWeekStart = startOfUtcWeek(anchor).getTime();
  const instantWeekStart = startOfUtcWeek(instant).getTime();
  const weeksFromAnchor = Math.round(
    (instantWeekStart - anchorWeekStart) / WEEK_MS,
  );
  const phase = ((weeksFromAnchor % cycleLen) + cycleLen) % cycleLen;
  return phase < onWeeks;
}

/**
 * Compute the next occurrence strictly after `after`. Returns null
 * when the schedule has terminated (one-shot anchor in the past;
 * `endsOn` already crossed; rolling with neither a last intake nor a
 * `startsOn` to anchor against).
 *
 * Implementation: walks forward in chunks (90 days for RRULE/legacy,
 * one rolling cycle for rolling) until an occurrence is found or the
 * `endsOn` boundary is reached. Caps at ~10 years out so a broken
 * RRULE never spins.
 */
export function nextOccurrenceAfter(
  schedule: CanonicalSchedule,
  after: Date,
  ctx: RecurrenceContext,
): Occurrence | null {
  // v1.7.0 — PRN never has a next due instant.
  if (schedule.scheduleType === "PRN") return null;

  const endsOn = ctx.medication.endsOn;
  const hardCap = new Date(after.getTime() + 365 * 10 * DAY_MS);
  const limit = endsOn
    ? new Date(Math.min(endOfUtcDay(endsOn).getTime(), hardCap.getTime()))
    : hardCap;

  const cyclic = schedule.scheduleType === "CYCLIC";

  // One-shot is single-slot — fast path. (One-shot is never cyclic, but
  // gate defensively so a malformed row can't surface an off-week slot.)
  if (ctx.medication.oneShot) {
    const slots = expandOneShot(
      schedule,
      ctx,
      new Date(after.getTime() + 1),
      limit,
    );
    for (const s of slots) {
      if (s.at.getTime() <= after.getTime()) continue;
      if (cyclic && !isInCyclicOnWeek(s.at, schedule, ctx)) continue;
      return s;
    }
    return null;
  }

  // Rolling is also single-slot (only emits the immediately next).
  if (schedule.rollingIntervalDays !== null) {
    const slots = expandRolling(
      schedule,
      ctx,
      new Date(after.getTime() + 1),
      limit,
    );
    for (const s of slots) {
      if (s.at.getTime() <= after.getTime()) continue;
      if (cyclic && !isInCyclicOnWeek(s.at, schedule, ctx)) continue;
      return s;
    }
    return null;
  }

  // Calendar cadences — walk in 90-day chunks.
  //
  // Defence-in-depth alongside the 10-year `hardCap`: every chunk
  // costs one `rrule.between(...)` invocation (the rrule lib's
  // internal MAXYEAR=9999 bounds each call, but the chunk count
  // itself is unbounded). Cap the walk at MAX_CHUNKS so a pathological
  // RRULE that emits very rarely (e.g. `FREQ=YEARLY;BYMONTHDAY=29;
  // BYMONTH=2`) cannot spend an open-ended amount of time iterating
  // the engine. Returns null on cap-hit, matching the "schedule has
  // terminated" contract.
  const MAX_CHUNKS = 80;
  const chunkMs = 90 * DAY_MS;
  let cursor = new Date(after.getTime() + 1);
  let chunks = 0;
  while (cursor.getTime() <= limit.getTime()) {
    if (chunks++ >= MAX_CHUNKS) return null;
    const chunkEnd = new Date(
      Math.min(cursor.getTime() + chunkMs, limit.getTime()),
    );
    const slots = occurrencesBetween(schedule, cursor, chunkEnd, ctx);
    for (const s of slots) {
      if (s.at.getTime() > after.getTime()) return s;
    }
    cursor = new Date(chunkEnd.getTime() + 1);
  }
  return null;
}

/**
 * Convenience predicate: does this schedule emit an occurrence at
 * exactly `instant` (within a 1-minute tolerance)?
 */
export function matchesInstant(
  schedule: CanonicalSchedule,
  instant: Date,
  ctx: RecurrenceContext,
): boolean {
  const from = new Date(instant.getTime() - ONE_MINUTE_MS);
  const to = new Date(instant.getTime() + ONE_MINUTE_MS);
  const slots = occurrencesBetween(schedule, from, to, ctx);
  return slots.some(
    (s) => Math.abs(s.at.getTime() - instant.getTime()) <= ONE_MINUTE_MS,
  );
}

// ────────────────────────────────────────────────────────────────────
// Dispatch — one-shot
// ────────────────────────────────────────────────────────────────────

function expandOneShot(
  schedule: CanonicalSchedule,
  ctx: RecurrenceContext,
  from: Date,
  to: Date,
): Occurrence[] {
  const anchor = ctx.medication.startsOn ?? ctx.medication.createdAt;
  const times = effectiveTimesOfDay(schedule);
  const slots: Occurrence[] = [];
  for (const time of times) {
    const at = applyTimeOfDayToDate(anchor, time, ctx.timeZone);
    if (at.getTime() < from.getTime() || at.getTime() > to.getTime()) continue;
    slots.push(buildOccurrence(at, time, schedule));
  }
  return slots.sort((a, b) => a.at.getTime() - b.at.getTime());
}

// ────────────────────────────────────────────────────────────────────
// Dispatch — rolling
// ────────────────────────────────────────────────────────────────────

/**
 * Rolling cadence — "every N days from last intake". Emits one
 * occurrence at `(lastIntakeAt ?? startsOn ?? createdAt) + N days`,
 * applied at the first `timesOfDay` entry (or `windowStart`).
 *
 * Design choice: only the FIRST time-of-day entry is emitted even
 * when multiple are configured. The rolling semantic — "every N days
 * from when I last took it" — doesn't compose cleanly with multiple
 * per-day intakes; the canonical rolling case is a once-weekly
 * injection. A future revision could fan out, but that's a UX
 * decision (does logging the morning intake re-anchor the evening
 * intake?), not an engine one.
 *
 * Only the immediately-next slot is returned. Past rolling slots are
 * historical intake events, not "expected slots" the schedule
 * predicts forward.
 */
function expandRolling(
  schedule: CanonicalSchedule,
  ctx: RecurrenceContext,
  from: Date,
  to: Date,
): Occurrence[] {
  const n = schedule.rollingIntervalDays;
  if (n === null || n <= 0) return [];
  const anchor =
    ctx.lastIntakeAt ?? ctx.medication.startsOn ?? ctx.medication.createdAt;

  const nextDue = new Date(anchor.getTime() + n * DAY_MS);

  // endsOn cap.
  if (
    ctx.medication.endsOn &&
    nextDue.getTime() > endOfUtcDay(ctx.medication.endsOn).getTime()
  ) {
    return [];
  }

  const time = schedule.timesOfDay[0] ?? schedule.windowStart;
  const at = applyTimeOfDayToDate(nextDue, time, ctx.timeZone);
  if (at.getTime() < from.getTime() || at.getTime() > to.getTime()) return [];

  return [buildOccurrence(at, time, schedule)];
}

// ────────────────────────────────────────────────────────────────────
// Dispatch — RRULE
// ────────────────────────────────────────────────────────────────────

function expandRrule(
  schedule: CanonicalSchedule,
  ctx: RecurrenceContext,
  from: Date,
  to: Date,
): Occurrence[] {
  const rruleStr = schedule.rrule;
  if (!rruleStr) return [];

  const dtstart = ctx.medication.startsOn ?? ctx.medication.createdAt;
  const dtstartLine = `DTSTART:${formatUtcBasic(startOfUtcDay(dtstart))}`;
  // Skip the engine-side UNTIL suffix when the user's RRULE already
  // bounds the recurrence with COUNT or UNTIL — RFC 5545 forbids both
  // (and any two-UNTIL collision), and RRule.fromString throws on the
  // duplicate, silently collapsing the schedule to zero slots.
  const userBoundsRecurrence = /(?:^|;)(?:COUNT|UNTIL)=/.test(rruleStr);
  const untilSuffix =
    ctx.medication.endsOn && !userBoundsRecurrence
      ? `;UNTIL=${formatUtcBasic(endOfUtcDay(ctx.medication.endsOn))}`
      : "";
  const full = `${dtstartLine}\nRRULE:${rruleStr}${untilSuffix}`;

  let rule: RRule;
  try {
    rule = RRule.fromString(full);
  } catch {
    annotate({
      action: { name: "medication.recurrence.parse_error" },
      meta: { rrule: rruleStr },
    });
    return [];
  }

  // Walk a generously padded day-anchor window so a per-day timesOfDay
  // expansion still hits the requested [from, to] after the time-of-day
  // is applied. The rrule lib's day-anchored dates land at midnight UTC
  // of the BYDAY/BYMONTHDAY day; the time-of-day might push back across
  // a day boundary in some timezones, so widen the window by 2 days on
  // each side.
  const padded = 2 * DAY_MS;
  const after = new Date(from.getTime() - padded);
  const before = new Date(to.getTime() + padded);
  const dayAnchors = rule.between(after, before, true);

  const times = effectiveTimesOfDay(schedule);
  const slots: Occurrence[] = [];
  for (const anchor of dayAnchors) {
    for (const time of times) {
      const at = applyTimeOfDayToDate(anchor, time, ctx.timeZone);
      if (at.getTime() < from.getTime()) continue;
      if (at.getTime() > to.getTime()) continue;
      slots.push(buildOccurrence(at, time, schedule));
    }
  }
  return slots.sort((a, b) => a.at.getTime() - b.at.getTime());
}

// ────────────────────────────────────────────────────────────────────
// Dispatch — legacy fallback
// ────────────────────────────────────────────────────────────────────

function expandLegacy(
  schedule: CanonicalSchedule,
  ctx: RecurrenceContext,
  from: Date,
  to: Date,
): Occurrence[] {
  const recurrence = parseScheduleRecurrence(schedule.daysOfWeek);
  const anchor = ctx.medication.startsOn ?? ctx.medication.createdAt;
  const anchorWeekStartUtc = startOfUtcWeek(anchor).getTime();
  const times = effectiveTimesOfDay(schedule);

  const slots: Occurrence[] = [];
  // Iterate every UTC day in [from-1, to+1] to cover any time-of-day
  // that might land in [from, to] after applying the local-tz HH:mm.
  const start = startOfUtcDay(new Date(from.getTime() - DAY_MS));
  const end = startOfUtcDay(new Date(to.getTime() + DAY_MS));
  const startsOnFloor = ctx.medication.startsOn
    ? startOfUtcDay(ctx.medication.startsOn).getTime()
    : null;
  for (
    let day = start;
    day.getTime() <= end.getTime();
    day = new Date(day.getTime() + DAY_MS)
  ) {
    // startsOn floor — every other dispatch tier honours it; the
    // legacy walker used to iterate from creation regardless, so a
    // legacy-shape schedule with a future startsOn emitted historical
    // slots. Mirror the endsOn cap below.
    if (startsOnFloor !== null && day.getTime() < startsOnFloor) {
      continue;
    }
    // Day-of-week filter (empty = every day). Use the user's
    // timezone weekday so the legacy "Mon = 1" encoding aligns with
    // the user's local-Mon, not UTC-Mon.
    const localWeekday = wallClockInTz(day, ctx.timeZone).weekday;
    if (
      recurrence.daysOfWeek.length > 0 &&
      !recurrence.daysOfWeek.includes(localWeekday)
    ) {
      continue;
    }

    // Multi-week interval — the fix vs the legacy worker, which
    // silently ignored intervalWeeks.
    if (recurrence.intervalWeeks > 1) {
      const dayWeekStart = startOfUtcWeek(day).getTime();
      const weeksFromAnchor = Math.round(
        (dayWeekStart - anchorWeekStartUtc) / WEEK_MS,
      );
      const phase =
        ((weeksFromAnchor % recurrence.intervalWeeks) +
          recurrence.intervalWeeks) %
        recurrence.intervalWeeks;
      if (phase !== 0) continue;
    }

    // endsOn cap.
    if (
      ctx.medication.endsOn &&
      day.getTime() > endOfUtcDay(ctx.medication.endsOn).getTime()
    ) {
      continue;
    }

    for (const time of times) {
      const at = applyTimeOfDayToDate(day, time, ctx.timeZone);
      if (at.getTime() < from.getTime()) continue;
      if (at.getTime() > to.getTime()) continue;
      slots.push(buildOccurrence(at, time, schedule));
    }
  }
  return slots.sort((a, b) => a.at.getTime() - b.at.getTime());
}

// ────────────────────────────────────────────────────────────────────
// Shared helpers
// ────────────────────────────────────────────────────────────────────

function effectiveTimesOfDay(schedule: CanonicalSchedule): string[] {
  return schedule.timesOfDay.length > 0
    ? schedule.timesOfDay
    : [schedule.windowStart];
}

/**
 * Apply an "HH:mm" time-of-day to `day` in the user's IANA timezone,
 * returning the corresponding UTC instant. DST-aware via the two-pass
 * solver pattern from `medication-schedule.ts`.
 *
 * `day` is interpreted as "the day in the user's timezone at which
 * the time-of-day should land" — we read its wall-clock Y/M/D in the
 * target zone, then materialise the instant for that Y/M/D + H/M in
 * that zone. So passing midnight-UTC on the spring-forward day with
 * Europe/Berlin gives the local-Berlin day, not the previous-Berlin
 * day even if the UTC midnight technically falls before the local
 * day boundary.
 */
function applyTimeOfDayToDate(day: Date, hhmm: string, tz: string): Date {
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return day;

  const parts = wallClockInTz(day, tz);
  let guess = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, h, m, 0, 0),
  );
  for (let i = 0; i < 2; i++) {
    const offsetMin = tzOffsetMinutes(guess, tz);
    guess = new Date(
      Date.UTC(parts.year, parts.month - 1, parts.day, h, m, 0, 0) -
        offsetMin * 60_000,
    );
  }
  return guess;
}

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
  return Math.round((asIfUtc - date.getTime()) / 60_000);
}

function buildOccurrence(
  at: Date,
  timeOfDay: string,
  schedule: CanonicalSchedule,
): Occurrence {
  return {
    at,
    timeOfDay,
    graceUntil: new Date(at.getTime() + graceWindowMs(schedule)),
  };
}

/**
 * Resolve the grace window for an occurrence:
 *
 *   - `reminderGraceMinutes` when set on the schedule
 *   - else `windowEnd - windowStart` span (in minutes)
 *   - else `DEFAULT_GRACE_MINUTES` (60) when the legacy fields agree
 *     (single-time window like "08:00..08:00")
 *
 * Handles overnight legacy windows (`windowEnd < windowStart`) by
 * pushing windowEnd to the next day.
 */
function graceWindowMs(schedule: CanonicalSchedule): number {
  if (schedule.reminderGraceMinutes !== null) {
    return schedule.reminderGraceMinutes * ONE_MINUTE_MS;
  }
  const startMin = hhmmToMinutes(schedule.windowStart);
  const endMin = hhmmToMinutes(schedule.windowEnd);
  if (startMin === null || endMin === null) {
    return DEFAULT_GRACE_MINUTES * ONE_MINUTE_MS;
  }
  let span = endMin - startMin;
  if (span < 0) span += 24 * 60; // overnight window
  if (span === 0) span = DEFAULT_GRACE_MINUTES;
  return span * ONE_MINUTE_MS;
}

function hhmmToMinutes(hhmm: string): number | null {
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

// ────────────────────────────────────────────────────────────────────
// UTC date helpers (RRULE day-anchor + endsOn cap arithmetic)
// ────────────────────────────────────────────────────────────────────

function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
}

function endOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );
}

function startOfUtcWeek(d: Date): Date {
  const midnight = startOfUtcDay(d);
  const weekday = midnight.getUTCDay(); // 0 = Sun
  return new Date(midnight.getTime() - weekday * DAY_MS);
}

/** RFC 5545 basic-format UTC instant: `YYYYMMDDTHHMMSSZ`. */
function formatUtcBasic(d: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}
