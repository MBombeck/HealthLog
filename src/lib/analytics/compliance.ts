/**
 * Medication compliance calculations.
 *
 * v1.5.0 — `calculateCompliance` is now a cadence-aware adapter on top
 * of `complianceChips` / `buildCadenceTimeline`. Prior to this release
 * the helper computed `totalExpected = schedules.length * days`, which
 * silently ignored `MedicationSchedule.daysOfWeek` and `intervalWeeks`.
 * A weekly Ozempic schedule (Mondays only) reported ~13% adherence
 * instead of 100%; a weekday-only 3×/day metformin reported 73%
 * instead of 100%. The wire shape (`{ totalExpected, taken, skipped,
 * missed, rate, streak }`) is unchanged so every consumer (Health
 * Score, AI Coach prompt context, /api/medications/[id]/compliance,
 * BP-status compliance gate, insight targets, the per-medication
 * tile) keeps reading the same fields. Only the math underneath the
 * fields was wrong — that's what got fixed. Closes #214.
 *
 * `classifyIntakeTiming` is unchanged and still owns the early /
 * on_time / late / very_late punctuality bucket logic used by the
 * daily compliance heatmap on `/api/medications/[id]/compliance`.
 */

import {
  buildCadenceTimeline,
  type CadenceEngineContext,
  type IntakeEventLike,
  type ScheduleLike,
} from "@/lib/medications/scheduling/cadence";
import {
  occurrencesBetween,
  type ScheduleType,
} from "@/lib/medications/scheduling/recurrence";

interface IntakeEvent {
  takenAt: Date | null;
  skipped: boolean;
  scheduledFor: Date;
}

export type IntakeTimingClass =
  | "early"
  | "on_time"
  | "late"
  | "very_late"
  | "missed";

export interface ComplianceResult {
  totalExpected: number;
  taken: number;
  skipped: number;
  missed: number;
  rate: number; // 0-100
  streak: number; // consecutive days with all taken
}

/**
 * Daily compliance data including timing breakdown.
 *
 * `early` is the v1.4.34 bucket for doses taken before the window's
 * 3-hour grace start. Consumers that group by compliance status
 * should treat `early` as compliant (alongside `onTime`).
 */
export interface DailyComplianceEntry {
  expected: number;
  /**
   * v1.7.0 item 5 — the true engine-computed due-slot count for the day.
   * Equals `expected`; carried as an explicit additive field iOS keys
   * off so it doesn't have to infer "due-ness" from `expected`.
   */
  expectedCount: number;
  /**
   * v1.7.0 item 5 — `expectedCount > 0`. iOS renders a "missed" mark
   * only when `due === true`, so off-weeks / non-matching weekdays / PRN
   * days no longer paint a false miss.
   */
  due: boolean;
  taken: number;
  skipped: number;
  onTime: number;
  late: number;
  veryLate: number;
  early?: number;
}

/**
 * Parse "HH:mm" into hours and minutes.
 */
function parseHHmm(time: string): { hours: number; minutes: number } {
  const [h, m] = time.split(":").map(Number);
  return { hours: h, minutes: m };
}

/**
 * Build a Date for a given "HH:mm" on a specific date.
 */
function toDateOnDay(time: string, day: Date): Date {
  const { hours, minutes } = parseHHmm(time);
  const d = new Date(day);
  d.setUTCHours(hours, minutes, 0, 0);
  return d;
}

/**
 * Classify how punctual an intake was relative to a schedule window.
 *
 * v1.4.34 IW-C — widened pre-window grace from 1h to 3h and introduced
 * a dedicated `early` bucket so a proactive logger (e.g. 10 min before
 * the window) no longer gets flushed into `very_late`. The post-window
 * grace likewise grew to 3h so a "20 minutes late" dose stays `on_time`.
 * Only doses beyond a 3-hour late tolerance fall into `late`, and only
 * doses beyond a further `lateMinutes` tail fall into `very_late`.
 *
 * Buckets:
 * - "early":     within (windowStart - 3h) .. windowStart           (compliant)
 * - "on_time":   windowStart .. (windowEnd + 3h)                    (compliant)
 * - "late":      (windowEnd + 3h) .. (windowEnd + 3h + lateMinutes) (default 2h tail)
 * - "very_late": before windowStart - 3h, or after the late tail
 * - "missed":    takenAt is null
 *
 * Handles overnight windows (windowEnd < windowStart means next day).
 *
 * @param options.lateMinutes Width of the `late` band beyond the 3-hour
 *   on-time tolerance, in minutes. Defaults to 120. Doses past this
 *   tail land in `very_late`.
 */
export function classifyIntakeTiming(
  takenAt: Date | null,
  windowStart: string, // "HH:mm"
  windowEnd: string, // "HH:mm"
  scheduledDate: Date, // the date this was scheduled
  options?: { lateMinutes?: number },
): IntakeTimingClass {
  if (takenAt === null) return "missed";

  const start = toDateOnDay(windowStart, scheduledDate);
  let end = toDateOnDay(windowEnd, scheduledDate);

  // Handle overnight windows (e.g. windowStart="23:00", windowEnd="01:00")
  if (end <= start) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }

  const HOUR_MS = 60 * 60 * 1000;
  // 3h pre-window grace: doses inside this window are `early` (still
  // compliant). Doses before it are `very_late`.
  const earlyStart = new Date(start.getTime() - 3 * HOUR_MS);
  // 3h post-window grace: doses up to here are still `on_time`.
  const onTimeEnd = new Date(end.getTime() + 3 * HOUR_MS);
  // Configurable `late` tail past the on-time grace (default 120 min).
  const lateTolerance = (options?.lateMinutes ?? 120) * 60 * 1000;
  const lateEnd = new Date(onTimeEnd.getTime() + lateTolerance);

  const t = takenAt.getTime();

  if (t < earlyStart.getTime()) return "very_late";
  if (t < start.getTime()) return "early";
  if (t <= onTimeEnd.getTime()) return "on_time";
  if (t <= lateEnd.getTime()) return "late";
  return "very_late";
}

/**
 * v1.5.0 — schedule view consumed by the cadence-aware adapter.
 *
 * Accepts the historical `ScheduleWindow` shape (`windowStart` +
 * `windowEnd` only) as well as the richer `ScheduleLike` shape that
 * carries `daysOfWeek`. When `daysOfWeek` is missing the schedule is
 * treated as `null` (daily, every day) so legacy fixtures keep
 * passing without modification.
 */
export interface ComplianceSchedule {
  windowStart: string; // HH:mm
  windowEnd: string; // HH:mm
  daysOfWeek?: string | null;
  /**
   * v1.7.0 SB-SCHED-2 — canonical-engine fields. When present (and a
   * `medicationContext` is threaded into `calculateCompliance`), the
   * expected-slot grid is computed through the canonical recurrence
   * engine, so an `rrule = "FREQ=WEEKLY;BYDAY=MO"` schedule counts only
   * Mondays in the denominator instead of every day. Absent fields keep
   * the legacy `daysOfWeek` path — existing fixtures / callers that pass
   * only `{ windowStart, windowEnd }` behave exactly as before.
   */
  rrule?: string | null;
  rollingIntervalDays?: number | null;
  timesOfDay?: string[];
  reminderGraceMinutes?: number | null;
  scheduleType?: ScheduleType | null;
  cyclicOnWeeks?: number | null;
  cyclicOffWeeks?: number | null;
}

/**
 * v1.7.0 SB-SCHED-2 — medication-level context the canonical engine
 * needs to expand expected slots. When supplied, `calculateCompliance`
 * routes the denominator through the engine; when omitted, every
 * schedule falls back to the legacy weekday walker (the byte-stable
 * pre-v1.7 behaviour that the parity fixtures pin).
 */
export interface ComplianceMedicationContext {
  startsOn: Date | null;
  endsOn: Date | null;
  oneShot: boolean;
  createdAt: Date;
  lastIntakeAt: Date | null;
  timeZone: string;
}

/**
 * v1.7.0 SB-SCHED-2 — convenience builder so the eight compliance call
 * sites don't each re-spell the context shape. Pass the medication row
 * (any object carrying the course-window fields), the latest non-skipped
 * intake instant, and the user's timezone.
 */
export function buildComplianceMedicationContext(
  med: {
    startsOn: Date | null;
    endsOn: Date | null;
    oneShot: boolean;
    createdAt: Date;
  },
  lastIntakeAt: Date | null,
  timeZone: string,
): ComplianceMedicationContext {
  return {
    startsOn: med.startsOn,
    endsOn: med.endsOn,
    oneShot: med.oneShot,
    createdAt: med.createdAt,
    lastIntakeAt,
    timeZone,
  };
}

/**
 * v1.7.0 SB-SCHED-2 — the latest non-skipped `takenAt` across an event
 * list (rolling cadences re-anchor on it). Returns null when the user
 * has never logged a non-skipped intake. Order-independent, so the
 * caller can pass an events array in any sort order.
 */
export function lastNonSkippedTakenAt(
  events: { takenAt: Date | null; skipped: boolean }[],
): Date | null {
  return events.reduce<Date | null>((latest, e) => {
    if (e.skipped || e.takenAt === null) return latest;
    if (latest === null || e.takenAt.getTime() > latest.getTime()) {
      return e.takenAt;
    }
    return latest;
  }, null);
}

/**
 * v1.7.0 item 5 — count the expected dose slots a medication's schedules
 * emit inside `[dayStart, dayEnd)`, routed through the canonical engine.
 * Powers the per-day `due` / `expectedCount` fields on the per-med
 * compliance payload so iOS history renders a "missed" mark only on days
 * the schedule actually expected a dose (not off-weeks / non-matching
 * weekdays / PRN days).
 */
export function expectedSlotCountForDay(
  schedules: ComplianceSchedule[],
  dayStart: Date,
  dayEnd: Date,
  ctx: ComplianceMedicationContext,
): number {
  let count = 0;
  const recurrenceCtx = {
    medication: {
      id: "compliance-daily",
      startsOn: ctx.startsOn,
      endsOn: ctx.endsOn,
      oneShot: ctx.oneShot,
      createdAt: ctx.createdAt,
    },
    timeZone: ctx.timeZone,
    lastIntakeAt: ctx.lastIntakeAt,
  };
  for (let i = 0; i < schedules.length; i++) {
    const s = schedules[i];
    const canonical = {
      id: `compliance-daily-${i}`,
      rrule: s.rrule ?? null,
      rollingIntervalDays: s.rollingIntervalDays ?? null,
      timesOfDay: s.timesOfDay ?? [],
      daysOfWeek: s.daysOfWeek ?? null,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      reminderGraceMinutes: s.reminderGraceMinutes ?? null,
      scheduleType: s.scheduleType ?? ("SCHEDULED" as const),
      cyclicOnWeeks: s.cyclicOnWeeks ?? null,
      cyclicOffWeeks: s.cyclicOffWeeks ?? null,
    };
    count += occurrencesBetween(
      canonical,
      dayStart,
      // occurrencesBetween is inclusive of both ends; subtract 1 ms so a
      // slot exactly at the next day's midnight doesn't double-count.
      new Date(dayEnd.getTime() - 1),
      recurrenceCtx,
    ).length;
  }
  return count;
}

/**
 * Calculate compliance for a medication over a given period.
 *
 * Honours `daysOfWeek` (e.g. `"1"` for Mondays only) and
 * `intervalWeeks` (bi-weekly, tri-weekly, …) by delegating to
 * `buildCadenceTimeline`. The denominator is the number of dose slots
 * the schedule actually emits inside the window — not
 * `schedules.length * days`. A user on a weekly Monday-only schedule
 * who takes every Monday for 30 days reports 100% adherence (4 of 4
 * Mondays) instead of the pre-v1.5.0 ~13% (4 of 30).
 *
 * Skipped doses are excluded from the denominator (deliberate user
 * decision, not a compliance failure). When the window contains no
 * expected doses (paused med, brand-new prescription, schedule that
 * never fires in the window) the helper returns `rate: 100` so the
 * empty state doesn't trip a "0% compliance" alarm downstream.
 *
 * Streak counts consecutive days, ending at `now`, where every
 * expected dose for the day was taken (or skipped). Days with no
 * expected dose (out-of-cadence weekdays, off-weeks on a bi-weekly
 * schedule) advance the streak — the user gets credit for not
 * breaking on non-scheduled days.
 *
 * @param events         Recorded intake events from
 *                       `MedicationIntakeEvent`. Only `scheduledFor`,
 *                       `takenAt`, `skipped` are read.
 * @param schedules      Schedule rows for the medication. `daysOfWeek`
 *                       is read when present; missing field is treated
 *                       as daily.
 * @param days           Rolling-window size in days (typically 7 / 30
 *                       / 90).
 * @param medicationCreatedAt
 *                       When provided, days before the medication
 *                       existed are excluded so they don't count as
 *                       "missed".
 * @param options.now    Override for the rolling-window anchor. The
 *                       fast-path Health-Score helper passes a fixed
 *                       `now` so cached medication-compliance rates
 *                       agree with the score's other pillars; default
 *                       is `new Date()` (current wall-clock instant).
 *                       v1.5.0 — added so the cadence-aware adapter
 *                       can be driven deterministically from a caller
 *                       that already pinned its own `now`.
 */
export function calculateCompliance(
  events: IntakeEvent[],
  schedules: ComplianceSchedule[],
  days: number,
  medicationCreatedAt?: Date,
  options?: { now?: Date; medicationContext?: ComplianceMedicationContext },
): ComplianceResult {
  if (schedules.length === 0) {
    return {
      totalExpected: 0,
      taken: 0,
      skipped: 0,
      missed: 0,
      rate: 100,
      streak: 0,
    };
  }

  const now = options?.now ?? new Date();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const periodStart = new Date(now.getTime() - days * DAY_MS);
  const effectiveStart =
    medicationCreatedAt && medicationCreatedAt > periodStart
      ? medicationCreatedAt
      : periodStart;
  const effectiveDays = Math.max(
    1,
    Math.ceil((now.getTime() - effectiveStart.getTime()) / DAY_MS),
  );

  // Normalise the schedule shape so legacy callers that pass only
  // `{ windowStart, windowEnd }` still produce a usable `daysOfWeek`
  // field (treated as daily by the cadence parser).
  const normalisedSchedules: ScheduleLike[] = schedules.map((s, i) => ({
    id: `compliance-${i}`,
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    daysOfWeek: s.daysOfWeek ?? null,
    // v1.7.0 SB-SCHED-2 — thread the canonical-engine fields so the
    // cadence expander can delegate to `occurrencesBetween` when a
    // medication context is supplied. Undefined fields collapse to the
    // legacy weekday path inside `expandScheduleSlots`.
    rrule: s.rrule ?? null,
    rollingIntervalDays: s.rollingIntervalDays ?? null,
    timesOfDay: s.timesOfDay,
    reminderGraceMinutes: s.reminderGraceMinutes ?? null,
    scheduleType: s.scheduleType ?? null,
    cyclicOnWeeks: s.cyclicOnWeeks ?? null,
    cyclicOffWeeks: s.cyclicOffWeeks ?? null,
  }));

  // v1.7.0 SB-SCHED-2 — build the engine context once per medication.
  // When the caller supplies it, the timeline routes through the
  // canonical engine (RRULE / rolling / one-shot / PRN / cyclic);
  // otherwise the legacy weekday walker stays in force.
  const ctx = options?.medicationContext;
  const engineCtx: CadenceEngineContext | undefined = ctx
    ? {
        startsOn: ctx.startsOn,
        endsOn: ctx.endsOn,
        oneShot: ctx.oneShot,
        createdAt: ctx.createdAt,
        lastIntakeAt: ctx.lastIntakeAt,
        timeZone: ctx.timeZone,
      }
    : undefined;

  // Match events against the same slot grid the cadence chart uses.
  // The chart's pairing radius is ±12 h so a late-by-six-hours dose
  // still attaches to the right slot instead of double-counting as
  // "missed + extra".
  const normalisedEvents: IntakeEventLike[] = events
    .filter((e) => e.scheduledFor >= effectiveStart && e.scheduledFor <= now)
    .map((e) => ({
      scheduledFor: e.scheduledFor,
      takenAt: e.takenAt,
      skipped: e.skipped,
    }));

  const timeline = buildCadenceTimeline(
    normalisedSchedules,
    normalisedEvents,
    now,
    effectiveDays,
    medicationCreatedAt ?? effectiveStart,
    engineCtx?.timeZone,
    engineCtx,
  );

  let taken = 0;
  let skipped = 0;
  let missed = 0;
  for (const slot of timeline) {
    if (slot.status === "taken") taken++;
    else if (slot.status === "skipped") skipped++;
    else if (slot.status === "missed") missed++;
    // `upcoming` slots (future window) are excluded from every counter
    // so a partial day at the head of the window doesn't pollute the rate.
  }

  const totalExpected = taken + skipped + missed;
  // Skipped doses are excluded from the denominator — they represent a
  // deliberate user decision rather than a missed dose.
  const denom = taken + missed;
  const rate =
    denom > 0 ? Math.min(100, Math.round((taken / denom) * 100)) : 100;

  // Streak: consecutive days, ending today, where every expected dose
  // was taken or skipped. Days with no expected dose advance the
  // streak — out-of-cadence days are not failures. Walks from today
  // backwards through the timeline grouped by local day.
  const dayKey = (d: Date): string => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  const byDay = new Map<string, "all-good" | "bad">();
  for (const slot of timeline) {
    const key = dayKey(slot.day);
    const existing = byDay.get(key);
    if (slot.status === "missed") {
      byDay.set(key, "bad");
    } else if (existing !== "bad") {
      byDay.set(key, "all-good");
    }
  }
  let streak = 0;
  for (let d = 0; d < effectiveDays; d++) {
    const cursor = new Date(now.getTime() - d * DAY_MS);
    if (medicationCreatedAt && cursor <= medicationCreatedAt) break;
    const state = byDay.get(dayKey(cursor));
    if (state === "bad") break;
    if (state === "all-good") streak++;
    // No state = no expected dose that day → streak advances silently.
  }

  return { totalExpected, taken, skipped, missed, rate, streak };
}
