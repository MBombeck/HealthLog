/**
 * v1.5.0 — canonical recurrence engine for medication scheduling.
 *
 * Single source of truth for "what dose slots does this schedule emit
 * between A and B?" The canonical engine is introduced in this release;
 * the v1.5.0 cut wires only the reminder worker (via
 * `worker-helpers.ts`) through it. The today-projector, the cadence
 * chart (`expandScheduleSlots`), and the form-level helpers continue on
 * the legacy walker through v1.5.x and migrate per the read-flip plan. The medication card's
 * "next intake" line reads the server-computed `nextDueAt` (this engine
 * via `computeNextDueAt`) directly as of v1.8.4.
 *
 * Dispatch tiers (first matching tier wins):
 *
 *   1. **One-shot** (`medication.oneShot === true`) — single slot at
 *      the anchor date, one per `timesOfDay` entry.
 *   2. **Rolling** (`schedule.rollingIntervalDays !== null`) — next
 *      slot is `lastIntakeAt + N days`. With no intake yet the FIRST
 *      dose is due AT `startsOn ?? createdAt` (not `+ N`); the `+ N`
 *      cadence only begins once the first intake is logged. Only the
 *      immediately next slot is emitted; further slots depend on the
 *      user actually logging the intake.
 *   3. **RRULE** (`schedule.rrule !== null`) — RFC 5545 expansion
 *      via the `rrule` npm lib. Day-anchored dates are returned in
 *      UTC by the library; each `timesOfDay` entry is then applied
 *      to that day in the user's IANA timezone (DST-aware via
 *      `wallClockInTz`).
 *   4. **Legacy fallback** — both `rrule` and `rollingIntervalDays`
 *      are NULL and `oneShot` is false. Decodes the legacy
 *      `daysOfWeek` string via `parseScheduleRecurrence` and emits
 *      weekly slots. **Honours `intervalWeeks > 1` correctly** —
 *      the retired today-projector walker skipped it (the legacy
 *      bi-weekly worker bug R-3 finding 5 calls out); this engine
 *      anchors the week phase to `startsOn ?? createdAt` and emits
 *      on the matching weeks only.
 *
 * Pure functions, no DB access. Caller fetches `lastIntakeAt`
 * (latest `MedicationIntakeEvent.takenAt`) and threads it through
 * `RecurrenceContext`.
 *
 * **As-needed medications (v1.16.11, #316).** A medication with
 * `Medication.asNeeded = true` carries ZERO schedule rows (enforced at
 * the create/update routes), so this engine is never consulted for it:
 * `computeNextDueAt` / `computeDisplayDue` return null on an empty
 * schedule list by construction, the reminder worker iterates no
 * schedules, the projector mints no slots, and compliance expands no
 * expected doses. The MEDICATION_LOW_STOCK runway is likewise null (no
 * consuming schedule) — that is correct and intended: an as-needed
 * supply is not falling on a predictable cadence, so no runway-based
 * alert can be honest. Intakes for such medications are ad-hoc rows
 * (`scheduledFor = takenAt`, the documented standalone-insert
 * contract); the schedule-level `scheduleType = "PRN"` early-returns
 * below are the per-schedule prior art for the same semantics.
 */

import { RRule } from "rrule";

import { annotate } from "@/lib/logging/context";
import { parseScheduleRecurrence } from "@/lib/medication-schedule";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { startOfLocalDayInTz } from "@/lib/tz/local-day";
import { tzOffsetMinutes } from "@/lib/tz/format";
import { startOfUtcDay } from "@/lib/tz/start-of-utc-day";
import { hhmmToMinutesOrNull } from "@/lib/medications/scheduling/hhmm";

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
  /**
   * v1.15.18 — per-dose configurable on-time intake windows. The recurrence
   * engine itself never reads these (slot timing is unchanged); they ride on
   * the canonical schedule purely so the band minter can build a slot's
   * on-time band from an explicit `[start, end]` range for the matching
   * `timeOfDay`. NULL / empty = every slot uses the default ±1h derivation.
   */
  doseWindows?: DoseWindowEntry[] | null;
}

/**
 * v1.15.18 — one explicit per-dose on-time window. `timeOfDay` keys the dose
 * the window applies to (matching a `timesOfDay` entry); `start`/`end` are the
 * HH:mm on-time bounds in the user's wall clock (`start <= end`, same local day).
 */
export interface DoseWindowEntry {
  timeOfDay: string;
  start: string;
  end: string;
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
   *
   * Skip semantics (documented decision, v1.16.9): a deliberate SKIP
   * does NOT advance the rolling anchor. A skipped row carries
   * `takenAt: null`, so every `lastIntakeAt` feeder query
   * (`takenAt: { not: null }`) excludes it by construction, and the
   * next due stays `previous take + N` — the skipped dose keeps
   * surfacing as due until a real take re-anchors the grid. Advancing
   * the anchor from the skipped instant instead would silently shift
   * the whole future grid off the user's established rhythm; if that
   * trade-off is ever revisited, every `lastIntakeAt` feeder (the
   * projector, the reminder worker, the list route, the write-path
   * resolvers, the dedup pass) must change together.
   */
  lastIntakeAt: Date | null;
}

export interface Occurrence {
  /** Canonical schedule owner; part of the occurrence identity. */
  scheduleId: string;
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
 * Where `now` sits relative to a medication's course, in calendar days on
 * the user's clock. `startsOn` / `endsOn` are calendar dates and are read as
 * such (never shifted through `timeZone`); only `now` is converted to the
 * local day it falls on. Both ends are inclusive: a course that ends today
 * is CURRENT for the whole of today, one that starts today is CURRENT from
 * local midnight.
 */
export type CourseStatus = "UPCOMING" | "CURRENT" | "ENDED";

export function courseStatusAt(
  course: { startsOn: Date | null; endsOn: Date | null },
  now: Date,
  timeZone: string,
): CourseStatus {
  const today = civilDayOfInstant(now, timeZone).getTime();
  if (course.startsOn && today < civilDayOfDate(course.startsOn).getTime()) {
    return "UPCOMING";
  }
  if (course.endsOn && today > civilDayOfDate(course.endsOn).getTime()) {
    return "ENDED";
  }
  return "CURRENT";
}

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
 * on/off phase. The anchor is the local calendar day of the medication's
 * `startsOn ?? createdAt`; a week is seven calendar days from it. `phase = weeksFromAnchor mod
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

  // Whole weeks counted in the user's calendar from the start day itself:
  // "three weeks on" starting on a Wednesday is 21 consecutive days, and the
  // slot's day is its local day, not the UTC day its instant falls on.
  const anchorDay = anchorCivilDay(ctx).getTime();
  const slotDay = civilDayOfInstant(instant, ctx.timeZone).getTime();
  const weeksFromAnchor = Math.floor(
    Math.round((slotDay - anchorDay) / DAY_MS) / 7,
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

  const endsOnDay = endsOnCivilDay(ctx);
  const hardCap = new Date(after.getTime() + 365 * 10 * DAY_MS);
  const limit = endsOnDay
    ? new Date(
        Math.min(
          endOfCivilDayInstant(endsOnDay, ctx.timeZone).getTime(),
          hardCap.getTime(),
        ),
      )
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
  //
  // v1.8.5 — floor the search window to the start of the user's current
  // day rather than the strict `after` instant. A rolling dose whose slot
  // lands earlier today (a past `startsOn` with no intake, or an overdue
  // `lastIntakeAt + N`) is DUE/OVERDUE and must surface as "take now",
  // not be skipped by a strict `> now` filter. Flooring to start-of-day
  // keeps a slot the user has not yet acted on visible through the rest
  // of its due day instead of silently rolling it forward by N.
  if (schedule.rollingIntervalDays !== null) {
    const dayFloor = startOfLocalDayInTz(after, ctx.timeZone);
    // The immediately-next rolling occurrence is an identity, not "whatever
    // falls on the worker's current day". Keep its local day in the search
    // even after midnight; display/band callers decide whether its actionable
    // tail is still open. Flooring only to today created a gap where an
    // unresolved weekly dose vanished on the morning after it was due.
    const floor = new Date(
      Math.min(dayFloor.getTime(), rollingDoseDayFloor(schedule, ctx)),
    );
    // The rolling slot is a single deterministic instant — `lastIntakeAt + N`
    // (or the anchor) at the notify-hour — not an open-ended walk, so the
    // 10-year anti-spin `hardCap` must never gate it. It collides at the
    // fencepost: a reminder at the maximum ten-year rolling interval, satisfied
    // so that `after === lastIntakeAt`, produces a next slot exactly `after +
    // 3650 days` — equal to `hardCap` to the millisecond, so the notify-hour
    // slot spills past the raw boundary and `expandRolling` clips it to nothing
    // (a ten-year booster silently lost its next due on the very dose that
    // should re-anchor it). Bound the search by the deterministic slot's OWN
    // end-of-day. The bound must key off the applied notify-hour instant, not
    // the raw anchor: when the anchor sits in the late-UTC evening its local
    // notify-hour slot falls on the NEXT UTC day, so an anchor-day ceiling is a
    // day short and re-clips the very slot it meant to admit. `endsOn` stays
    // enforced inside `expandRolling`, so a course-window reminder still
    // self-expires.
    const rollingSlotInstant = applyTimeOfDayToCivilDay(
      rollingDoseAnchor(schedule, ctx),
      schedule.timesOfDay[0] ?? schedule.windowStart,
      ctx.timeZone,
    );
    const rollingCeil = new Date(
      Math.max(limit.getTime(), endOfUtcDay(rollingSlotInstant).getTime()),
    );
    const slots = expandRolling(schedule, ctx, floor, rollingCeil);
    for (const s of slots) {
      if (s.at.getTime() < floor.getTime()) continue;
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
  const anchor = anchorCivilDay(ctx);
  const times = effectiveTimesOfDay(schedule);
  const slots: Occurrence[] = [];
  for (const time of times) {
    const at = applyTimeOfDayToCivilDay(anchor, time, ctx.timeZone);
    if (at.getTime() < from.getTime() || at.getTime() > to.getTime()) continue;
    slots.push(buildOccurrence(at, time, schedule));
  }
  return slots.sort((a, b) => a.at.getTime() - b.at.getTime());
}

// ────────────────────────────────────────────────────────────────────
// Dispatch — rolling
// ────────────────────────────────────────────────────────────────────

/**
 * Rolling cadence — "every N days from last intake".
 *
 * Anchoring (v1.8.5 — medically-correct first dose):
 *   - After an intake → next slot is `lastIntakeAt + N days` (the
 *     v1.8.4 re-anchor). Logging a dose pushes the next one out by N.
 *   - No intake yet → the FIRST dose is due AT `startsOn ?? createdAt`,
 *     NOT `start + N`. A rolling course's first dose lands on the start
 *     date; the `+ N` cadence only kicks in once the first intake is
 *     logged. The pre-v1.8.5 engine emitted `start + N` here, which
 *     silently skipped the start-date dose (and suppressed its reminder,
 *     since the worker shares this engine).
 *
 * A past `startsOn` with no intake therefore surfaces the start dose as
 * DUE/OVERDUE ("take now") via `nextOccurrenceAfter`'s rolling branch,
 * rather than rolling it forward.
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
/**
 * Start-of-day (in the user's timezone) of the no-intake first rolling dose
 * anchor — `startsOn ?? createdAt`. Used by `nextOccurrenceAfter` to clamp the
 * search floor so a multi-day-overdue first dose still surfaces. Mirrors the
 * anchor `expandRolling` emits in the `lastIntakeAt === null` branch; flooring
 * to the anchor's start-of-day keeps the time-of-day slot (e.g. 08:00) within
 * the window rather than ahead of a raw-instant floor.
 */
function rollingDoseAnchor(
  schedule: CanonicalSchedule,
  ctx: RecurrenceContext,
): Date {
  const intervalDays = schedule.rollingIntervalDays ?? 0;
  // N calendar days after the local day of the last intake, not N × 24 h:
  // a late-evening dose across a DST change would otherwise slide onto the
  // wrong day.
  const fromIntake =
    ctx.lastIntakeAt !== null
      ? addCivilDays(
          civilDayOfInstant(ctx.lastIntakeAt, ctx.timeZone),
          intervalDays,
        )
      : null;
  // v1.40 (#1024) — an intake whose next dose would fall before the course
  // starts belongs to an earlier course (a new course after a gap): it does
  // not anchor this one, whose first dose is due on its start day. An intake
  // whose next dose falls on or after the start (a start moved forward by a
  // few days) anchors exactly as before.
  const startDay =
    ctx.medication.startsOn !== null
      ? civilDayOfDate(ctx.medication.startsOn)
      : null;
  return fromIntake !== null &&
    (startDay === null || fromIntake.getTime() >= startDay.getTime())
    ? fromIntake
    : anchorCivilDay(ctx);
}

function rollingDoseDayFloor(
  schedule: CanonicalSchedule,
  ctx: RecurrenceContext,
): number {
  return startOfCivilDayInstant(
    rollingDoseAnchor(schedule, ctx),
    ctx.timeZone,
  ).getTime();
}

function expandRolling(
  schedule: CanonicalSchedule,
  ctx: RecurrenceContext,
  from: Date,
  to: Date,
): Occurrence[] {
  const n = schedule.rollingIntervalDays;
  if (n === null || n <= 0) return [];

  // After an intake the next dose is N days out. With no intake yet the
  // FIRST dose is the start date itself (no `+ N`) — see the doc comment.
  const nextDue = rollingDoseAnchor(schedule, ctx);

  // endsOn cap — both sides are calendar days.
  const endsOnDay = endsOnCivilDay(ctx);
  if (endsOnDay && nextDue.getTime() > endsOnDay.getTime()) {
    return [];
  }

  const time = schedule.timesOfDay[0] ?? schedule.windowStart;
  const at = applyTimeOfDayToCivilDay(nextDue, time, ctx.timeZone);
  if (at.getTime() < from.getTime() || at.getTime() > to.getTime()) return [];

  return [buildOccurrence(at, time, schedule)];
}

/**
 * Advance from one canonical rolling occurrence to the next grid occurrence
 * without pretending a skip/auto-miss was a new intake anchor. Used only after
 * the current exact occurrence is resolved; unresolved recurrence remains the
 * single `lastIntakeAt + N` slot.
 */
export function advanceRollingOccurrence(
  schedule: CanonicalSchedule,
  occurrence: Occurrence,
  ctx: RecurrenceContext,
): Occurrence | null {
  const n = schedule.rollingIntervalDays;
  if (n === null || n <= 0) return null;
  const time = schedule.timesOfDay[0] ?? schedule.windowStart;
  const nextDay = addCivilDays(
    civilDayOfInstant(occurrence.at, ctx.timeZone),
    n,
  );
  const endsOnDay = endsOnCivilDay(ctx);
  if (endsOnDay && nextDay.getTime() > endsOnDay.getTime()) {
    return null;
  }
  const at = applyTimeOfDayToCivilDay(nextDay, time, ctx.timeZone);
  return buildOccurrence(at, time, schedule);
}

/**
 * v1.13.x compliance — RETROSPECTIVE rolling expansion.
 *
 * `expandRolling` is forward-only by contract (the projector + reminder
 * worker depend on it emitting ONLY the immediately-next slot). That is
 * correct for "what's next" surfaces but wrong for the compliance grid,
 * which must reconstruct the *historical* expected-dose slots a rolling
 * cadence implies over a trailing window so a faithfully-adherent weekly
 * injection reads its true rate instead of the vacuous 100%-or-0% flip
 * the forward-only path produced.
 *
 * Medically-correct reading: a rolling "every N days from last dose"
 * cadence re-anchors on each intake, so the retrospective expected grid
 * *is* the observed intake history (each logged dose is exactly one
 * satisfied expected slot) PLUS:
 *
 *   - back-filled `missed` slots for genuinely skipped whole cycles: when
 *     two consecutive intakes are more than `1.5 · N` apart the user
 *     skipped one or more cycles → emit a slot at `prevIntake + k·N` for
 *     each whole cycle the gap spans (the `1.5·N` tolerance gate means a
 *     dose logged a day late never synthesizes a phantom miss); and
 *   - the single forward next-due slot, emitted ONLY when it is past-due
 *     (`nextDue ≤ now`). A not-yet-due forward slot is `upcoming` and is
 *     excluded so the open current cycle never counts against the
 *     denominator.
 *
 * Because the back-filled / forward slots carry no nearby intake, they
 * pair to nothing in `pairDoses` and read `missed`; the per-intake slots
 * are anchored AT the intake instant so they pair (distance 0) and read
 * `taken`. The same grid feeds the count-only callers
 * (`expectedSlotsBetween` / `expectedSlotCountForDay`) so numerator,
 * denominator, and the heatmap `due` flags route through ONE expansion
 * (the v1.7.3 B15 numerator/denominator-convergence rule).
 *
 * Kept here (not folded into `expandRolling`) so the engine's forward
 * contract is untouched; compliance opts in explicitly via
 * `expandRollingRetrospective`.
 *
 * @param intakeInstants Non-skipped intake instants for THIS medication
 *   (ascending or unsorted — sorted internally). The compliance layer
 *   supplies these; the engine has no DB access.
 * @param now The wall-clock anchor (the compliance window's `to`-side
 *   "now"), used to decide whether the forward next-due slot is past-due.
 */
export function expandRollingRetrospective(
  schedule: CanonicalSchedule,
  ctx: RecurrenceContext,
  from: Date,
  to: Date,
  intakeInstants: Date[],
  now: Date,
): Occurrence[] {
  const n = schedule.rollingIntervalDays;
  if (n === null || n <= 0) return [];

  const time = schedule.timesOfDay[0] ?? schedule.windowStart;
  const cycleMs = n * DAY_MS;
  // Tolerance: a gap up to 1.5·N is "on time" (a dose logged a little
  // late). Only a gap strictly beyond this synthesizes skipped cycles.
  const gapToleranceMs = 1.5 * cycleMs;
  const endsOnDay = endsOnCivilDay(ctx);
  const endsCap = endsOnDay
    ? endOfCivilDayInstant(endsOnDay, ctx.timeZone).getTime()
    : Infinity;

  const inWindow = (at: Date): boolean =>
    at.getTime() >= from.getTime() &&
    at.getTime() <= to.getTime() &&
    at.getTime() <= endsCap;

  const slots: Occurrence[] = [];

  // Each logged intake is a satisfied expected slot at its own instant.
  // Sort ascending so the gap walk between consecutive intakes is correct.
  const sorted = [...intakeInstants].sort((a, b) => a.getTime() - b.getTime());
  for (const instant of sorted) {
    if (inWindow(instant)) {
      slots.push(buildOccurrence(instant, time, schedule));
    }
  }

  // Back-fill missed slots for genuinely skipped whole cycles between
  // consecutive intakes (gap > 1.5·N). The synthesized slots land at the
  // schedule's time-of-day on each skipped cycle's day so they read as a
  // real expected dose in the user's timezone.
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    const gap = next.getTime() - prev.getTime();
    if (gap <= gapToleranceMs) continue;
    // Number of whole cycles the user skipped: floor(gap/N) − 1 missed
    // cycles sit strictly between the two intakes. Counted in calendar
    // days, so a gap spanning a DST change (one hour short) still counts
    // its last cycle.
    const prevDay = civilDayOfInstant(prev, ctx.timeZone);
    const gapDays = Math.round(
      (civilDayOfInstant(next, ctx.timeZone).getTime() - prevDay.getTime()) /
        DAY_MS,
    );
    const cyclesInGap = Math.floor(gapDays / n);
    for (let k = 1; k < cyclesInGap; k++) {
      const at = applyTimeOfDayToCivilDay(
        addCivilDays(prevDay, k * n),
        time,
        ctx.timeZone,
      );
      if (inWindow(at)) {
        slots.push(buildOccurrence(at, time, schedule));
      }
    }
  }

  // The single forward next-due slot — emitted as a missed slot ONLY when
  // the open cycle is GENUINELY overdue, i.e. `now` is more than half a
  // cycle past `nextDue`. A dose merely a little late (within `0.5·N`) is
  // the current open cycle still in its window — it must NOT synthesize a
  // phantom miss (the N-tolerance gate). A not-yet-due forward slot
  // (`nextDue > now`) is excluded entirely (upcoming → out of the
  // denominator). This keeps the open current cycle off the percentage rows
  // until it is unambiguously missed; the `currentCycle` descriptor carries
  // the softer on_track / due / missed state for the card.
  const forwardToleranceMs = cycleMs / 2;
  const lastInstant =
    sorted.length > 0 ? sorted[sorted.length - 1] : ctx.lastIntakeAt;
  const nextDueDay =
    lastInstant !== null
      ? addCivilDays(civilDayOfInstant(lastInstant, ctx.timeZone), n)
      : anchorCivilDay(ctx);
  const nextDue =
    lastInstant !== null
      ? new Date(lastInstant.getTime() + cycleMs)
      : startOfCivilDayInstant(nextDueDay, ctx.timeZone);
  if (now.getTime() - nextDue.getTime() > forwardToleranceMs) {
    const at = applyTimeOfDayToCivilDay(nextDueDay, time, ctx.timeZone);
    // Dedupe: a forward slot already represented by a logged intake (the
    // intake re-anchored exactly N days out) must not double-count.
    const alreadyPresent = slots.some(
      (s) => Math.abs(s.at.getTime() - at.getTime()) < cycleMs / 2,
    );
    if (inWindow(at) && !alreadyPresent) {
      slots.push(buildOccurrence(at, time, schedule));
    }
  }

  return slots.sort((a, b) => a.at.getTime() - b.at.getTime());
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

  // The rrule library works in "floating" UTC: DTSTART and every emitted
  // anchor are calendar days carried as UTC midnight. Keep them that way end
  // to end — the anchor's day is read from its UTC fields and only then is
  // the HH:mm materialised in the user's zone. Reading the anchor in the
  // user's zone instead turned Monday 00:00Z into Sunday evening west of UTC.
  const dtstartLine = `DTSTART:${formatUtcBasic(anchorCivilDay(ctx))}`;
  // Skip the engine-side UNTIL suffix when the user's RRULE already
  // bounds the recurrence with COUNT or UNTIL — RFC 5545 forbids both
  // (and any two-UNTIL collision), and RRule.fromString throws on the
  // duplicate, silently collapsing the schedule to zero slots.
  const userBoundsRecurrence = /(?:^|;)(?:COUNT|UNTIL)=/.test(rruleStr);
  const endsOnDay = endsOnCivilDay(ctx);
  const untilSuffix =
    endsOnDay && !userBoundsRecurrence
      ? `;UNTIL=${formatUtcBasic(endOfUtcDay(endsOnDay))}`
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
  // is applied: a calendar day spans instants up to 14 h either side of
  // its UTC midnight, so widen the window by 2 days on each side.
  const padded = 2 * DAY_MS;
  const after = new Date(from.getTime() - padded);
  const before = new Date(to.getTime() + padded);
  // An RRULE with BYHOUR (the measurement-reminder protocols) emits several
  // anchors per day; the times of day are expanded per calendar day, so
  // collapse the anchors to their days first.
  const dayKeys = new Set<number>();
  for (const anchor of rule.between(after, before, true)) {
    dayKeys.add(startOfUtcDay(anchor).getTime());
  }

  const times = effectiveTimesOfDay(schedule);
  const slots: Occurrence[] = [];
  for (const dayKey of dayKeys) {
    const day = new Date(dayKey);
    for (const time of times) {
      const at = applyTimeOfDayToCivilDay(day, time, ctx.timeZone);
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
  const anchorWeekStart = startOfCivilWeek(anchorCivilDay(ctx)).getTime();
  const times = effectiveTimesOfDay(schedule);
  const endsOnDay = endsOnCivilDay(ctx);

  const slots: Occurrence[] = [];
  // Iterate every calendar day (carried as UTC midnight) in [from-1, to+1]
  // to cover any time-of-day that might land in [from, to] once the HH:mm
  // is materialised in the user's zone. Every comparison below is between
  // calendar days; only `applyTimeOfDayToCivilDay` touches the zone.
  const start = startOfUtcDay(new Date(from.getTime() - DAY_MS));
  const end = startOfUtcDay(new Date(to.getTime() + DAY_MS));
  const startsOnFloor = ctx.medication.startsOn
    ? civilDayOfDate(ctx.medication.startsOn).getTime()
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
    // Day-of-week filter (empty = every day). `day` IS the user's
    // calendar day, so its UTC weekday is the local weekday.
    const weekday = day.getUTCDay();
    if (
      recurrence.daysOfWeek.length > 0 &&
      !recurrence.daysOfWeek.includes(weekday)
    ) {
      continue;
    }

    // Multi-week interval — the fix vs the legacy worker, which
    // silently ignored intervalWeeks.
    if (recurrence.intervalWeeks > 1) {
      const dayWeekStart = startOfCivilWeek(day).getTime();
      const weeksFromAnchor = Math.round(
        (dayWeekStart - anchorWeekStart) / WEEK_MS,
      );
      const phase =
        ((weeksFromAnchor % recurrence.intervalWeeks) +
          recurrence.intervalWeeks) %
        recurrence.intervalWeeks;
      if (phase !== 0) continue;
    }

    // endsOn cap.
    if (endsOnDay && day.getTime() > endsOnDay.getTime()) {
      continue;
    }

    for (const time of times) {
      const at = applyTimeOfDayToCivilDay(day, time, ctx.timeZone);
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

// ────────────────────────────────────────────────────────────────────
// Calendar days
//
// A "civil day" is a calendar date carried as UTC midnight of its
// Y/M/D, the same shape Prisma returns for a `@db.Date` column and the
// rrule library works in. Its UTC fields ARE the calendar date; it is
// never read in the user's zone. Instants (createdAt, intake times,
// slot instants) become civil days through `civilDayOfInstant`, which
// reads them on the user's wall clock. Only `applyTimeOfDayToCivilDay`
// turns a civil day back into an instant.
// ────────────────────────────────────────────────────────────────────

/** A `@db.Date` value (UTC midnight of the calendar date) as a civil day. */
function civilDayOfDate(d: Date): Date {
  return startOfUtcDay(d);
}

/** The calendar day an instant falls on in `tz`, as a civil day. */
function civilDayOfInstant(instant: Date, tz: string): Date {
  const p = wallClockInTz(instant, tz);
  return new Date(Date.UTC(p.year, p.month - 1, p.day));
}

function addCivilDays(day: Date, n: number): Date {
  return new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + n),
  );
}

/**
 * The schedule's first calendar day: `startsOn` is a calendar date; the
 * `createdAt` fallback is an instant and so is read on the user's clock.
 */
function anchorCivilDay(ctx: RecurrenceContext): Date {
  return ctx.medication.startsOn
    ? civilDayOfDate(ctx.medication.startsOn)
    : civilDayOfInstant(ctx.medication.createdAt, ctx.timeZone);
}

function endsOnCivilDay(ctx: RecurrenceContext): Date | null {
  return ctx.medication.endsOn ? civilDayOfDate(ctx.medication.endsOn) : null;
}

/** Local midnight of a civil day (DST-safe, via its local noon). */
function startOfCivilDayInstant(day: Date, tz: string): Date {
  return startOfLocalDayInTz(applyTimeOfDayToCivilDay(day, "12:00", tz), tz);
}

/** The last millisecond of a civil day on the user's clock. */
function endOfCivilDayInstant(day: Date, tz: string): Date {
  return new Date(
    startOfCivilDayInstant(addCivilDays(day, 1), tz).getTime() - 1,
  );
}

/** The Sunday that starts the calendar week of a civil day. */
function startOfCivilWeek(day: Date): Date {
  return addCivilDays(day, -day.getUTCDay());
}

/**
 * Materialise an "HH:mm" on a civil day in the user's IANA timezone,
 * returning the corresponding UTC instant. DST-aware: a wall-clock time that
 * does not exist on a spring-forward day resolves forward (02:30 in
 * Europe/Berlin on 2026-03-29 becomes 03:30).
 *
 * The calendar date comes from the civil day's UTC fields and is never
 * re-read in `tz` — see the section comment above.
 */
function applyTimeOfDayToCivilDay(day: Date, hhmm: string, tz: string): Date {
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return day;

  const wall = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    h,
    m,
    0,
    0,
  );
  // Try the zone offset in force a day before and a day after. A candidate
  // is valid when it reads back as the requested wall clock. On a
  // fall-back day both are valid and the earlier one wins; on a
  // spring-forward day neither is, and the pre-transition offset moves the
  // time forward past the gap. That also covers zones whose clocks skip
  // midnight itself (America/Santiago), where an iterative solver settled
  // on the previous evening.
  const before = new Date(
    wall - tzOffsetMinutes(new Date(wall - DAY_MS), tz) * 60_000,
  );
  const after = new Date(
    wall - tzOffsetMinutes(new Date(wall + DAY_MS), tz) * 60_000,
  );
  const readsBack = (c: Date): boolean => {
    const p = wallClockInTz(c, tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) === wall;
  };
  const validBefore = readsBack(before);
  const validAfter = readsBack(after);
  if (validBefore && validAfter) {
    return before.getTime() <= after.getTime() ? before : after;
  }
  if (validAfter) return after;
  return before;
}

function buildOccurrence(
  at: Date,
  timeOfDay: string,
  schedule: CanonicalSchedule,
): Occurrence {
  return {
    scheduleId: schedule.id,
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
  const startMin = hhmmToMinutesOrNull(schedule.windowStart);
  const endMin = hhmmToMinutesOrNull(schedule.windowEnd);
  if (startMin === null || endMin === null) {
    return DEFAULT_GRACE_MINUTES * ONE_MINUTE_MS;
  }
  let span = endMin - startMin;
  if (span < 0) span += 24 * 60; // overnight window
  if (span === 0) span = DEFAULT_GRACE_MINUTES;
  return span * ONE_MINUTE_MS;
}

// ────────────────────────────────────────────────────────────────────
// UTC date helpers (RRULE day-anchor + endsOn cap arithmetic)
// ────────────────────────────────────────────────────────────────────

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

/** RFC 5545 basic-format UTC instant: `YYYYMMDDTHHMMSSZ`. */
function formatUtcBasic(d: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}
