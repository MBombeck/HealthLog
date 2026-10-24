/**
 * #1280 — the course actions a medication read offers, narrowed to what the
 * CALLER may do.
 *
 * `canEndCourse` and `canStartCourse` are resolved from the course alone
 * (`intake-actionable.ts`, `courses.ts`), and the course is the record's.
 * The routes behind them are not open to everyone who can read the record:
 * End is a MANAGE write (`POST /courses/end`), and starting, editing or
 * removing a course stays with the owner (`/courses`, `/courses/{courseId}`).
 * A read that served the course's answer to a viewer would paint a button
 * whose press is refused, so every read that publishes the two flags passes
 * them through here with the caller's authority.
 *
 * The record-wide list is cached per record, never per caller, so the
 * narrowing runs after the cache and never lands in it.
 */
import { grantIdAllows } from "@/lib/sharing/grant-access";

export interface CourseActionAuthority {
  /** The caller may end the running course (MANAGE over medications). */
  mayEnd: boolean;
  /** The caller may start a course (the record's owner). */
  mayStart: boolean;
}

/** The authority of the request resolved under `grantId` (null: the owner). */
export async function courseActionAuthority(
  grantId: string | null,
): Promise<CourseActionAuthority> {
  if (grantId === null) return { mayEnd: true, mayStart: true };
  return {
    mayEnd: await grantIdAllows(grantId, "manage", "medications"),
    mayStart: false,
  };
}

/** The read row with its course actions narrowed to the caller's authority. */
export function withCourseActionAuthority<T extends Record<string, unknown>>(
  row: T,
  authority: CourseActionAuthority,
): T {
  if (authority.mayEnd && authority.mayStart) return row;
  return {
    ...row,
    canEndCourse: authority.mayEnd && row.canEndCourse === true,
    canStartCourse: authority.mayStart && row.canStartCourse === true,
  };
}
