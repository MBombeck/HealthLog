// Extracted from the former single-file `compliance.ts`. See `../compliance.ts`
// (the barrel) for the module map. Pure move — no logic changes.

import type { ScheduleRevisionLike } from "@/lib/medications/scheduling/schedule-eras";
import type { ScheduleType } from "@/lib/medications/scheduling/recurrence";
import {
  isInsideCourses,
  type CourseSpan,
} from "@/lib/medications/course-window";
import { userDayKey } from "@/lib/tz/format";

export interface IntakeEvent {
  takenAt: Date | null;
  skipped: boolean;
  scheduledFor: Date;
  /**
   * v1.15.9 — true when the auto-miss cron marked this never-acted dose as
   * a forgotten miss. Threaded into the cadence timeline so it counts as a
   * `missed` slot (against the rate) instead of being neutralised. Optional
   * so pre-v1.15.9 callers / fixtures default it to a normal pending/taken
   * row.
   */
  autoMissed?: boolean;
  /**
   * v1.15.20 — slot-binding provenance. `USER_PIN` = the user deliberately
   * pinned this off-window take onto its `scheduledFor` slot; the unified
   * ledger then binds it by anchor (taken-late, never on-time-washed)
   * instead of degrading it to ad-hoc when the takenAt sits outside the
   * band tail. Optional so legacy callers / fixtures default to AUTO.
   */
  attributionSource?: "AUTO" | "USER_PIN";
}

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
  /**
   * v1.15.18 — per-dose configurable on-time windows. Threaded onto the
   * canonical schedule so `tallyComplianceFromLedger` builds the on-time band
   * from the explicit `[start, end]` range — keeping the % exactly aligned with
   * the dose-history view and the write/edit attribution (all consume the same
   * minter). Accepts the raw persisted JSON (a full Prisma row drops straight
   * in); `toCanonicalSchedule` normalises it via `normaliseDoseWindows`.
   */
  doseWindows?: unknown;
}

/**
 * v1.15.20 — the ONE Prisma `select` for schedule rows feeding a compliance
 * computation. Every call site that loads schedules for
 * `calculateCompliance` / the cadence helpers must use this constant instead
 * of hand-rolling a field list (or an unbounded `include: { schedules:
 * true }`), so a future schedule column that the engine consumes — the way
 * `doseWindows` joined in v1.15.18 — reaches every surface the moment it is
 * added here. Covers the full {@link ComplianceSchedule} shape plus `id`
 * (engine-internal labelling / diagnostics).
 */
export const SCHEDULE_COMPLIANCE_SELECT = {
  id: true,
  windowStart: true,
  windowEnd: true,
  daysOfWeek: true,
  timesOfDay: true,
  reminderGraceMinutes: true,
  rrule: true,
  rollingIntervalDays: true,
  scheduleType: true,
  cyclicOnWeeks: true,
  cyclicOffWeeks: true,
  // The configurable per-dose on-time windows. Selecting them everywhere is
  // the point: a user-configured "07:00–09:00" band must shape the rate on
  // the dashboard pillar, the insights features, the BP-status gate and the
  // report exactly as it shapes the medication detail page.
  doseWindows: true,
} as const;

/**
 * v1.40 (#1024) — the ONE relation select for the courses a compliance
 * computation threads into {@link buildComplianceMedicationContext}, the
 * sibling of {@link SCHEDULE_COMPLIANCE_SELECT}.
 */
export const COURSES_COMPLIANCE_SELECT = {
  select: { startsOn: true, endsOn: true },
  orderBy: { startsOn: "asc" },
} as const;

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
  /**
   * v1.16.3 — archived schedule eras (`validFrom` ascending). When present,
   * every expected-slot expansion + band mint segments its range so a past
   * day counts/mints against the schedule that was live THEN. Optional:
   * callers without revisions keep the live-only expansion.
   */
  scheduleRevisions?: ScheduleRevisionLike[];
  /**
   * v1.25 H-MED1 — durable pause intervals (`MedicationPauseEra`). When
   * present, expected dose slots whose anchor falls inside any
   * `[pausedAt, resumedAt ?? now)` interval are dropped from the ledger so a
   * resumed medication never counts the paused days as missed. Optional:
   * callers without eras keep counting every expected slot.
   */
  pauseEras?: MedicationPauseEraLike[];
  /**
   * v1.40 (#1024) — the medication's courses. `startsOn`/`endsOn` above are
   * the row's projection (the latest course). With two or more courses the
   * retrospective minters expand over the span from the first course's start
   * to the last one's end and drop every expected slot whose local day falls
   * in no course, so a gap between courses expects nothing. Absent or a
   * single course: today's behaviour, the projection window alone.
   */
  courses?: CourseSpan[];
}

/**
 * v1.40 (#1024) — the window the retrospective minters expand over: the span
 * of every course when there are several, else the medication's own window.
 */
export function complianceMintWindow(
  ctx: Pick<ComplianceMedicationContext, "startsOn" | "endsOn" | "courses">,
): {
  startsOn: Date | null;
  endsOn: Date | null;
} {
  const courses = ctx.courses;
  if (!courses || courses.length < 2) {
    return { startsOn: ctx.startsOn, endsOn: ctx.endsOn };
  }
  const sorted = [...courses].sort(
    (a, b) => a.startsOn.getTime() - b.startsOn.getTime(),
  );
  return {
    startsOn: sorted[0].startsOn,
    endsOn: sorted[sorted.length - 1].endsOn,
  };
}

/**
 * v1.40 (#1024) — whether an expected slot at `at` belongs to a course. True
 * for every slot when the medication has fewer than two courses (the
 * projection window already bounds the expansion).
 */
export function slotInsideCourses(
  ctx: Pick<ComplianceMedicationContext, "timeZone" | "courses">,
  at: Date,
): boolean {
  const courses = ctx.courses;
  if (!courses || courses.length < 2) return true;
  return isInsideCourses(userDayKey(at, ctx.timeZone), courses);
}

/**
 * v1.25 H-MED1 — the pause-interval projection the compliance engine reads.
 * A Prisma `MedicationPauseEra` row (or a `{ pausedAt, resumedAt }` literal)
 * drops in. An open era (`resumedAt === null`) runs to `now`.
 */
export interface MedicationPauseEraLike {
  pausedAt: Date;
  resumedAt: Date | null;
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
    /** v1.16.3 — thread the archived eras when the bundle carries them. */
    scheduleRevisions?: ScheduleRevisionLike[];
    /** v1.25 H-MED1 — thread the pause eras when the caller carries them. */
    pauseEras?: MedicationPauseEraLike[];
    /** v1.40 (#1024) — thread the courses when the caller carries them. */
    courses?: CourseSpan[];
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
    ...(med.scheduleRevisions && { scheduleRevisions: med.scheduleRevisions }),
    ...(med.pauseEras && { pauseEras: med.pauseEras }),
    ...(med.courses && { courses: med.courses }),
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
 * v1.13.x — non-skipped intake instants for the retrospective rolling grid,
 * mirroring {@link rollingIntakeInstants} but reading the public
 * `{ takenAt, skipped }[]` shape the `expectedSlots*` callers pass. The
 * `expectedSlots*` helpers accept this so their rolling denominator uses the
 * SAME expansion as the displayed-rate numerator in {@link calculateCompliance}.
 */
export interface ComplianceIntakeInstant {
  takenAt: Date | null;
  skipped: boolean;
  /**
   * v1.15.10 — the dose slot this intake resolves (the canonical snapped
   * instant, byte-identical to the engine occurrence's `.at`). Optional so
   * every legacy caller / fixture that omits it keeps working; when present
   * the open-dose selection in {@link buildCurrentCycle} uses it to skip a
   * slot the user has already acted on (taken / skipped / auto-missed) so the
   * card advances to the next genuinely-open slot rather than re-surfacing a
   * resolved past dose.
   */
  scheduledFor?: Date;
  /**
   * v1.15.10 — the cron-flagged forgotten miss. A resolved (auto-missed) slot
   * is excluded from the open-dose search the same way a take / skip is.
   */
  autoMissed?: boolean;
}
