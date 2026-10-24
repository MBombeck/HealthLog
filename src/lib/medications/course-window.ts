/**
 * v1.40 (#1024) — several courses per medication: the pure rules.
 *
 * A course is a calendar span `[startsOn, endsOn]` (both inclusive, calendar
 * days on the person's clock, `endsOn` null = open). A medication with no
 * course rows is "chronic since creation", as before this release; one with
 * course rows keeps `Medication.startsOn/endsOn` as a projection of ONE of
 * them, which every engine that predates courses (reminders, the next-due
 * line, `intakeActionable`) keeps reading unchanged.
 *
 * The invariant that keeps the projection time-independent: courses never
 * overlap, and every course except the latest-starting one has ended before
 * today. Under it the course containing today, else the next upcoming one,
 * else the most recently ended one is always simply the latest course, so a
 * projection written at the last course write stays correct as days pass. A
 * write that would break the invariant is refused (`validateCourses`).
 *
 * #1280 — "End course" ends a course at an instant, `endedAt`, which lies on
 * its `endsOn` day. A slot at or after it is not part of the course, and the
 * course reads as ENDED from then on. An end date set in the editor carries
 * no `endedAt` and keeps the full-day reading. The instant is what keeps
 * compliance honest both ways: a dose taken earlier that day stays inside
 * the course and counts, and a later slot of the same day is neither due nor
 * missed.
 *
 * Pure: no database, no clock (callers pass `today`).
 */
import { dateOnlyKey, dayKeyAsUtcMidnight } from "@/lib/tz/date-only";
import { userDayKey } from "@/lib/tz/format";

export interface CourseSpan {
  startsOn: Date;
  endsOn: Date | null;
  /**
   * #1280 — the instant "End course" ended this course, on its `endsOn` day.
   * Absent or null: the course runs to the end of `endsOn`.
   */
  endedAt?: Date | null;
}

export type CourseStatus = "UPCOMING" | "CURRENT" | "ENDED";

/** `YYYY-MM-DD` of a `@db.Date` value. */
export const dayKeyOfDate = dateOnlyKey;

/** A `YYYY-MM-DD` key as the `@db.Date` value Prisma writes. */
export const dateOfDayKey = dayKeyAsUtcMidnight;

/**
 * The medication's window as the engines read it: the latest course's
 * `startsOn` / `endsOn` and, since #1280, the instant "End course" ended it.
 * One select and one picker, so a reader cannot take the dates and drop the
 * instant.
 */
export const MEDICATION_WINDOW_SELECT = {
  startsOn: true,
  endsOn: true,
  endedAt: true,
} as const;

export function medicationWindow(m: {
  startsOn: Date | null;
  endsOn: Date | null;
  endedAt: Date | null;
}): { startsOn: Date | null; endsOn: Date | null; endedAt: Date | null } {
  return { startsOn: m.startsOn, endsOn: m.endsOn, endedAt: m.endedAt };
}

/** Courses ascending by start. */
export function sortCourses<T extends CourseSpan>(courses: readonly T[]): T[] {
  return [...courses].sort(
    (a, b) => a.startsOn.getTime() - b.startsOn.getTime(),
  );
}

/**
 * The window `Medication.startsOn/endsOn/endedAt` carries: the latest course,
 * or nothing at all when the medication has no course (chronic since
 * creation).
 */
export function projectCourseWindow(courses: readonly CourseSpan[]): {
  startsOn: Date | null;
  endsOn: Date | null;
  endedAt: Date | null;
} {
  if (courses.length === 0) {
    return { startsOn: null, endsOn: null, endedAt: null };
  }
  const latest = sortCourses(courses)[courses.length - 1];
  return {
    startsOn: latest.startsOn,
    endsOn: latest.endsOn,
    endedAt: latest.endedAt ?? null,
  };
}

/**
 * Where `todayKey` sits in one course. Both ends inclusive, except that a
 * course ended with "End course" is ENDED on its `endsOn` day already: the
 * instant it ended lies on that day, and every read that asks about that day
 * comes after the instant (it is written as the moment of the request).
 */
export function courseStatusOn(
  course: CourseSpan,
  todayKey: string,
): CourseStatus {
  if (todayKey < dayKeyOfDate(course.startsOn)) return "UPCOMING";
  if (course.endsOn) {
    const endKey = dayKeyOfDate(course.endsOn);
    if (todayKey > endKey) return "ENDED";
    if (course.endedAt && todayKey === endKey) return "ENDED";
  }
  return "CURRENT";
}

/**
 * Where `now` sits in a medication's window (`Medication.startsOn/endsOn/
 * endedAt`, the projection of its latest course), in calendar days on the
 * person's clock. `startsOn` / `endsOn` are calendar dates and are read as
 * such; only `now` is converted to its local day. Both ends are inclusive:
 * a course that ends today is CURRENT for the whole of today, one that
 * starts today is CURRENT from local midnight. A medication without dates is
 * CURRENT. #1280 — a course ended with "End course" is ENDED from the
 * instant it was ended (`endedAt`), not from the next local midnight.
 */
export function courseStatusAt(
  course: {
    startsOn: Date | null;
    endsOn: Date | null;
    endedAt?: Date | null;
  },
  now: Date,
  timeZone: string,
): CourseStatus {
  if (course.endedAt && now.getTime() >= course.endedAt.getTime()) {
    return "ENDED";
  }
  const todayKey = userDayKey(now, timeZone);
  if (course.startsOn && todayKey < dayKeyOfDate(course.startsOn)) {
    return "UPCOMING";
  }
  if (course.endsOn && todayKey > dayKeyOfDate(course.endsOn)) return "ENDED";
  return "CURRENT";
}

/**
 * #1280 — the end "End course" writes: the person's own calendar day as the
 * course's last day (never the UTC one, a day off around midnight), and the
 * moment itself as `endedAt`.
 */
export function courseEndNow(
  now: Date,
  timeZone: string,
): { endsOn: Date; endedAt: Date } {
  return { endsOn: dateOfDayKey(userDayKey(now, timeZone)), endedAt: now };
}

/**
 * #1280 — whether "End course" may be pressed: a course is running now. On
 * a course that has ended, ending it again would reopen it up to today; on
 * one that has not started, it would turn into a one-day course today. The
 * medication read wire publishes the answer as `canEndCourse`, and the End
 * action refuses when it is false.
 */
export function canEndCourse(courseStatus: CourseStatus): boolean {
  return courseStatus === "CURRENT";
}

export type CourseRefusal =
  /** `endsOn` before `startsOn`. */
  | "invalidRange"
  /** Two courses share at least one day. */
  | "overlap"
  /** A course other than the latest has not ended yet. */
  | "currentOpen"
  /** A one-time medication has more than one course. */
  | "oneShot";

/**
 * Whether a course set may be stored. Adjacent courses (one ends the day
 * before the next starts) are fine; sharing a day is an overlap.
 */
export function validateCourses(
  courses: readonly CourseSpan[],
  todayKey: string,
  oneShot: boolean,
): CourseRefusal | null {
  for (const c of courses) {
    if (c.endsOn && c.endsOn.getTime() < c.startsOn.getTime()) {
      return "invalidRange";
    }
  }
  if (oneShot && courses.length > 1) return "oneShot";
  const sorted = sortCourses(courses);
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    if (
      previous.endsOn === null ||
      previous.endsOn.getTime() >= sorted[i].startsOn.getTime()
    ) {
      return "overlap";
    }
  }
  for (let i = 0; i < sorted.length - 1; i += 1) {
    if (courseStatusOn(sorted[i], todayKey) !== "ENDED") return "currentOpen";
  }
  return null;
}

/**
 * Whether a slot at `at`, whose local day is `dayKey`, falls inside any
 * course. No courses means no restriction (chronic since creation). A course
 * ended with "End course" stops at its `endedAt`: a slot at or after it is
 * outside, even on the `endsOn` day.
 */
export function isInsideCourses(
  dayKey: string,
  courses: readonly CourseSpan[],
  at: Date,
): boolean {
  if (courses.length === 0) return true;
  return courses.some(
    (c) =>
      dayKey >= dayKeyOfDate(c.startsOn) &&
      (c.endsOn === null || dayKey <= dayKeyOfDate(c.endsOn)) &&
      (!c.endedAt || at.getTime() < c.endedAt.getTime()),
  );
}

/**
 * The end of the latest course that has ended before today, or null. "When
 * did I last take this" for a medication that is not running now.
 */
export function previousCourseEndedOn(
  courses: readonly CourseSpan[],
  todayKey: string,
): Date | null {
  const ended = sortCourses(courses).filter(
    (c) => courseStatusOn(c, todayKey) === "ENDED",
  );
  return ended.length === 0 ? null : ended[ended.length - 1].endsOn;
}

/**
 * Whether a new course may start: the medication is active and not a
 * one-time one, it has at least one course, and every course has ended. A
 * medication with no course is chronic and running, so it ends its course
 * first ("End course" writes one).
 */
export function canStartCourse(args: {
  active: boolean;
  oneShot: boolean;
  courses: readonly CourseSpan[];
  todayKey: string;
}): boolean {
  if (!args.active || args.oneShot || args.courses.length === 0) return false;
  return args.courses.every(
    (c) => courseStatusOn(c, args.todayKey) === "ENDED",
  );
}

/**
 * The one course a medication's own window describes, for a medication that
 * has no course rows (the migration's backfill, a restore of a file written
 * before courses, the first course write on such a row). The same rules as
 * the 0368 backfill:
 *
 *   - start and end in order: that window;
 *   - only a start: open from that day;
 *   - only an end: from the creation day on the person's clock (`createdKey`),
 *     or from the end day when that lies earlier;
 *   - start after end (refused by the API, but older rows exist): every
 *     reader treated it as empty and ended, so a one-day course on the end
 *     day, which stays ended and invents no stretch of expected doses;
 *   - neither: no course (chronic since creation).
 */
export function courseFromWindow(
  startsOn: Date | null,
  endsOn: Date | null,
  createdKey: string,
): CourseSpan | null {
  if (startsOn && endsOn) {
    return startsOn.getTime() > endsOn.getTime()
      ? { startsOn: endsOn, endsOn }
      : { startsOn, endsOn };
  }
  if (startsOn) return { startsOn, endsOn: null };
  if (endsOn) {
    const endKey = dayKeyOfDate(endsOn);
    return {
      startsOn: dateOfDayKey(endKey < createdKey ? endKey : createdKey),
      endsOn,
    };
  }
  return null;
}
