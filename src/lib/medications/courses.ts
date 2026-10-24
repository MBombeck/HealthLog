/**
 * v1.40 (#1024) — the one writer of a medication's courses and of the window
 * the medication row projects from them.
 *
 * Every write runs in one transaction under a per-medication advisory lock:
 * load the courses, apply the change, refuse a set that breaks the course
 * rules (`validateCourses`), write, then rewrite `Medication.startsOn/endsOn`
 * from the result (`projectCourseWindow`). Nothing else writes those two
 * columns for a medication that has courses, so reminders, the next-due line
 * and `intakeActionable` — which read the columns — can never disagree with
 * the course list.
 *
 * #1280 — "End course" (`endCurrentCourse`) ends the running course at the
 * moment it is pressed: `endsOn` becomes today and `endedAt` records the
 * instant, so no slot after it is due, reminded or expected. Every other
 * write that moves a course's `endsOn` clears `endedAt`: an end date chosen
 * in the editor means the whole day.
 */
import type { Prisma } from "@/generated/prisma/client";
import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { prisma } from "@/lib/db";
import {
  canEndCourse,
  canStartCourse,
  courseEndNow,
  courseFromWindow,
  courseStatusAt,
  courseStatusOn,
  dateOfDayKey,
  dayKeyOfDate,
  previousCourseEndedOn,
  projectCourseWindow,
  sortCourses,
  validateCourses,
  type CourseRefusal,
  type CourseStatus,
} from "@/lib/medications/course-window";
import { userDayKey } from "@/lib/tz/format";
import {
  moveAutoTakeFloorToNow,
  windowWidens,
} from "@/lib/medications/auto-take";

type Tx = Prisma.TransactionClient;

export type CourseWriteRefusal =
  | CourseRefusal
  /** Clearing the window of a medication that has several courses. */
  | "windowRequired"
  /** The course or the medication is not the caller's. */
  | "notFound"
  /** #1280 — "End course" on a medication with no course running now. */
  | "notRunning";

export class CourseWriteError extends Error {
  constructor(readonly refusal: CourseWriteRefusal) {
    super(`Course write refused: ${refusal}`);
    this.name = "CourseWriteError";
  }
}

/** The wire `meta.errorCode` and status for each refusal. */
export function courseRefusalResponse(refusal: CourseWriteRefusal): {
  status: number;
  errorCode: string;
  message: string;
} {
  switch (refusal) {
    case "notFound":
      return {
        status: 404,
        errorCode: "medications.course.notFound",
        message: "Course not found",
      };
    case "overlap":
      return {
        status: 422,
        errorCode: "medications.course.overlap",
        message: "Courses may not share a day",
      };
    case "currentOpen":
      return {
        status: 422,
        errorCode: "medications.course.currentOpen",
        message: "End the running course before adding one after it",
      };
    case "oneShot":
      return {
        status: 422,
        errorCode: "medications.course.oneShot",
        message: "A one-time medication has a single course",
      };
    case "invalidRange":
      return {
        status: 422,
        errorCode: "medications.course.invalidRange",
        message: "A course cannot end before it starts",
      };
    case "notRunning":
      return {
        status: 409,
        errorCode: "medications.course.notRunning",
        message: "No course is running to end",
      };
    case "windowRequired":
      return {
        status: 422,
        errorCode: "medications.course.windowRequired",
        message:
          "A medication with several courses keeps a start date; delete a course instead",
      };
  }
}

export interface CourseRow {
  id: string;
  startsOn: Date;
  endsOn: Date | null;
  endedAt: Date | null;
  noteEncrypted: Uint8Array | null;
}

/** The course columns every course read and write selects. */
const COURSE_ROW_SELECT = {
  id: true,
  startsOn: true,
  endsOn: true,
  endedAt: true,
  noteEncrypted: true,
} as const;

async function lockMedication(tx: Tx, medicationId: string) {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtext('medication-course'),
      hashtext(${medicationId})
    )::text AS locked
  `;
}

async function loadOwned(tx: Tx, userId: string, medicationId: string) {
  const medication = await tx.medication.findFirst({
    where: { id: medicationId, userId },
    select: {
      id: true,
      oneShot: true,
      startsOn: true,
      endsOn: true,
      endedAt: true,
      createdAt: true,
    },
  });
  if (!medication) throw new CourseWriteError("notFound");
  const courses = await tx.medicationCourse.findMany({
    where: { medicationId },
    orderBy: [{ startsOn: "asc" }, { id: "asc" }],
    select: COURSE_ROW_SELECT,
  });
  return { medication, courses };
}

type ProjectedWindow = {
  startsOn: Date | null;
  endsOn: Date | null;
  endedAt: Date | null;
};

/**
 * Write the medication's window from its courses. The only writer.
 *
 * v1.42.2 — a window that now reaches further into the past than before
 * (an earlier start, a later or removed end) would let the auto-take pass
 * fill the days it reopens as taken; its floor moves to now instead.
 */
async function project(tx: Tx, medicationId: string): Promise<ProjectedWindow> {
  const [before, courses] = await Promise.all([
    tx.medication.findUnique({
      where: { id: medicationId },
      select: { startsOn: true, endsOn: true },
    }),
    tx.medicationCourse.findMany({
      where: { medicationId },
      select: { startsOn: true, endsOn: true, endedAt: true },
    }),
  ]);
  const window = projectCourseWindow(courses);
  await tx.medication.update({
    where: { id: medicationId },
    data: {
      startsOn: window.startsOn,
      endsOn: window.endsOn,
      endedAt: window.endedAt,
    },
  });
  if (before && windowWidens(before, window)) {
    await moveAutoTakeFloorToNow(tx, medicationId);
  }
  return window;
}

function refuseIfInvalid(
  courses: { startsOn: Date; endsOn: Date | null }[],
  todayKey: string,
  oneShot: boolean,
) {
  const refusal = validateCourses(courses, todayKey, oneShot);
  if (refusal) throw new CourseWriteError(refusal);
}

function encryptNote(note: string | null | undefined) {
  if (note === undefined) return undefined;
  return note === null || note.trim() === "" ? null : encryptToBytes(note);
}

interface WriteContext {
  userId: string;
  medicationId: string;
  timeZone: string;
  now?: Date;
}

export async function createCourse(
  args: WriteContext & {
    startsOn: Date;
    endsOn: Date | null;
    note?: string | null;
  },
): Promise<CourseRow> {
  const todayKey = userDayKey(args.now ?? new Date(), args.timeZone);
  return prisma.$transaction(async (tx) => {
    await lockMedication(tx, args.medicationId);
    const { medication, courses } = await loadOwned(
      tx,
      args.userId,
      args.medicationId,
    );
    // A medication without course rows is not empty history. With no window
    // at all it has been taken continuously since creation and is running
    // now, so a course cannot be added beside it (it ends its course first,
    // "End course" writes one). With a window the rows never recorded (a
    // file restored past the backfill), that window is its first course and
    // is materialised before the new one is checked against it. Either way
    // nothing the person already recorded can be cut off by the projection.
    let existing: { startsOn: Date; endsOn: Date | null }[] = courses;
    if (courses.length === 0) {
      if (medication.startsOn === null && medication.endsOn === null) {
        throw new CourseWriteError("currentOpen");
      }
      const implicit = windowAsCourse(
        medication.startsOn,
        medication.endsOn,
        undefined,
        medication.createdAt,
        args.timeZone,
      );
      refuseIfInvalid(
        [implicit, { startsOn: args.startsOn, endsOn: args.endsOn }],
        todayKey,
        medication.oneShot,
      );
      await tx.medicationCourse.create({
        data: {
          medicationId: args.medicationId,
          userId: args.userId,
          ...implicit,
        },
      });
      existing = [implicit];
    }
    refuseIfInvalid(
      [...existing, { startsOn: args.startsOn, endsOn: args.endsOn }],
      todayKey,
      medication.oneShot,
    );
    const created = await tx.medicationCourse.create({
      data: {
        medicationId: args.medicationId,
        userId: args.userId,
        startsOn: args.startsOn,
        endsOn: args.endsOn,
        noteEncrypted: encryptNote(args.note) ?? null,
      },
      select: COURSE_ROW_SELECT,
    });
    await project(tx, args.medicationId);
    return created;
  });
}

export async function updateCourse(
  args: WriteContext & {
    courseId: string;
    startsOn?: Date;
    endsOn?: Date | null;
    note?: string | null;
  },
): Promise<CourseRow> {
  const todayKey = userDayKey(args.now ?? new Date(), args.timeZone);
  return prisma.$transaction(async (tx) => {
    await lockMedication(tx, args.medicationId);
    const { medication, courses } = await loadOwned(
      tx,
      args.userId,
      args.medicationId,
    );
    const current = courses.find((c) => c.id === args.courseId);
    if (!current) throw new CourseWriteError("notFound");
    const endsOn = args.endsOn === undefined ? current.endsOn : args.endsOn;
    const next = {
      startsOn: args.startsOn ?? current.startsOn,
      endsOn,
      endedAt: keptEndedAt(current, endsOn),
    };
    refuseIfInvalid(
      courses.map((c) => (c.id === current.id ? next : c)),
      todayKey,
      medication.oneShot,
    );
    const noteEncrypted = encryptNote(args.note);
    const updated = await tx.medicationCourse.update({
      where: { id: current.id },
      data: {
        startsOn: next.startsOn,
        endsOn: next.endsOn,
        endedAt: next.endedAt,
        ...(noteEncrypted !== undefined && { noteEncrypted }),
      },
      select: COURSE_ROW_SELECT,
    });
    await project(tx, args.medicationId);
    return updated;
  });
}

/**
 * Delete one course. Deleting the only course makes the medication chronic
 * again (the projection clears both columns); the UI asks first.
 */
export async function deleteCourse(
  args: WriteContext & { courseId: string },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockMedication(tx, args.medicationId);
    const { courses } = await loadOwned(tx, args.userId, args.medicationId);
    if (!courses.some((c) => c.id === args.courseId)) {
      throw new CourseWriteError("notFound");
    }
    await tx.medicationCourse.delete({ where: { id: args.courseId } });
    await project(tx, args.medicationId);
  });
}

/**
 * The course a window describes. A window with only an end has always meant
 * "running since creation" (or since the end day, when that lies earlier).
 */
function windowAsCourse(
  startsOn: Date | null,
  endsOn: Date | null,
  latest: { startsOn: Date } | undefined,
  createdAt: Date,
  timeZone: string,
): { startsOn: Date; endsOn: Date | null } {
  if (!startsOn && latest) return { startsOn: latest.startsOn, endsOn };
  return (
    courseFromWindow(startsOn, endsOn, userDayKey(createdAt, timeZone)) ?? {
      startsOn: dateOfDayKey(userDayKey(createdAt, timeZone)),
      endsOn,
    }
  );
}

/**
 * What `PUT /api/medications/{id}` does with `startsOn` / `endsOn` since
 * v1.40: the window the body sets becomes the latest course (created when
 * the medication had none), so a client that edits the window as before (the
 * iPhone app's course row, the web wizard, "End course") keeps working. The
 * two values are the medication's window after the update, with an absent
 * field already resolved to its stored value.
 *
 * Clearing both on a medication with one course deletes it (chronic again,
 * the pre-course meaning of no dates); on one with several it is refused,
 * because it would silently drop the history.
 *
 * `tx` runs the write inside the caller's transaction, so the PUT's row
 * update and this course write commit or roll back together: a refusal here
 * then leaves nothing of the PUT behind.
 */
export async function setCurrentWindow(
  args: WriteContext & { startsOn: Date | null; endsOn: Date | null },
  tx?: Tx,
): Promise<ProjectedWindow> {
  return tx
    ? writeCurrentWindow(tx, args)
    : prisma.$transaction((own) => writeCurrentWindow(own, args));
}

async function writeCurrentWindow(
  tx: Tx,
  args: WriteContext & { startsOn: Date | null; endsOn: Date | null },
): Promise<ProjectedWindow> {
  const todayKey = userDayKey(args.now ?? new Date(), args.timeZone);
  await lockMedication(tx, args.medicationId);
  const { medication, courses } = await loadOwned(
    tx,
    args.userId,
    args.medicationId,
  );
  const latest = sortCourses(courses).at(-1);

  if (args.startsOn === null && args.endsOn === null) {
    if (!latest) return project(tx, args.medicationId);
    if (courses.length > 1) throw new CourseWriteError("windowRequired");
    await tx.medicationCourse.delete({ where: { id: latest.id } });
    return project(tx, args.medicationId);
  }

  const next = windowAsCourse(
    args.startsOn,
    args.endsOn,
    latest,
    medication.createdAt,
    args.timeZone,
  );

  if (latest) {
    const edited = { ...next, endedAt: keptEndedAt(latest, next.endsOn) };
    refuseIfInvalid(
      courses.map((c) => (c.id === latest.id ? edited : c)),
      todayKey,
      medication.oneShot,
    );
    await tx.medicationCourse.update({
      where: { id: latest.id },
      data: edited,
    });
  } else {
    refuseIfInvalid([next], todayKey, medication.oneShot);
    await tx.medicationCourse.create({
      data: {
        medicationId: args.medicationId,
        userId: args.userId,
        ...next,
      },
    });
  }
  return project(tx, args.medicationId);
}

/**
 * #1280 — the `endedAt` a course keeps through an edit: its own while its
 * `endsOn` stays the day it was ended on, none once the end moves. An end
 * date written in the editor is a whole day; only "End course" ends a course
 * at an instant.
 */
function keptEndedAt(
  course: { endsOn: Date | null; endedAt: Date | null },
  nextEndsOn: Date | null,
): Date | null {
  if (!course.endedAt || !course.endsOn || !nextEndsOn) return null;
  return course.endsOn.getTime() === nextEndsOn.getTime()
    ? course.endedAt
    : null;
}

/**
 * #1280 — "End course": end the running course now.
 *
 * The course's last day becomes today on the person's clock and `endedAt`
 * records the moment. Doses earlier today stay inside the course and count;
 * a slot later today is not due, not reminded and not expected, and the
 * course reads as ENDED at once (`courseStatusAt`). A medication without a
 * course row (chronic since creation, or a window never materialised) gets
 * the course its window describes, ended now.
 *
 * The pending placeholders already minted for slots at or after that moment
 * (the today projector mints the whole day) are tombstoned, as a schedule
 * replace does, so no list shows them and the auto-miss pass never stamps
 * them a miss. An actioned row is history and stays.
 *
 * Refused with `notRunning` unless a course is running now
 * (`canEndCourse`): ending an ended course would reopen it up to today, and
 * ending one that has not started would invent a one-day course.
 */
export async function endCurrentCourse(
  args: WriteContext,
): Promise<ProjectedWindow> {
  const now = args.now ?? new Date();
  const todayKey = userDayKey(now, args.timeZone);
  const { endsOn: today, endedAt } = courseEndNow(now, args.timeZone);
  return prisma.$transaction(async (tx) => {
    await lockMedication(tx, args.medicationId);
    const { medication, courses } = await loadOwned(
      tx,
      args.userId,
      args.medicationId,
    );
    if (!canEndCourse(courseStatusAt(medication, now, args.timeZone))) {
      throw new CourseWriteError("notRunning");
    }
    const latest = sortCourses(courses).at(-1);
    if (latest) {
      const ended = { startsOn: latest.startsOn, endsOn: today, endedAt };
      refuseIfInvalid(
        courses.map((c) => (c.id === latest.id ? ended : c)),
        todayKey,
        medication.oneShot,
      );
      await tx.medicationCourse.update({
        where: { id: latest.id },
        data: { endsOn: today, endedAt },
      });
    } else {
      const implicit = windowAsCourse(
        medication.startsOn,
        today,
        undefined,
        medication.createdAt,
        args.timeZone,
      );
      refuseIfInvalid([implicit], todayKey, medication.oneShot);
      await tx.medicationCourse.create({
        data: {
          medicationId: args.medicationId,
          userId: args.userId,
          ...implicit,
          endedAt,
        },
      });
    }
    await tx.medicationIntakeEvent.updateMany({
      where: {
        userId: args.userId,
        medicationId: args.medicationId,
        deletedAt: null,
        takenAt: null,
        skipped: false,
        autoMissed: false,
        scheduledFor: { gte: now },
      },
      data: { deletedAt: now, syncVersion: { increment: 1 } },
    });
    return project(tx, args.medicationId);
  });
}

/**
 * Whether the window a PUT is about to write would be refused. Checked
 * BEFORE the medication row is updated, so a refused window leaves the row
 * as it was. Same rules as `setCurrentWindow`.
 */
export async function checkCurrentWindow(
  args: WriteContext & {
    startsOn: Date | null;
    endsOn: Date | null;
    oneShot: boolean;
    createdAt: Date;
  },
): Promise<CourseWriteRefusal | null> {
  const todayKey = userDayKey(args.now ?? new Date(), args.timeZone);
  const courses = await prisma.medicationCourse.findMany({
    where: { medicationId: args.medicationId, userId: args.userId },
    orderBy: [{ startsOn: "asc" }, { id: "asc" }],
    select: { id: true, startsOn: true, endsOn: true, endedAt: true },
  });
  const latest = courses.at(-1);
  if (args.startsOn === null && args.endsOn === null) {
    return courses.length > 1 ? "windowRequired" : null;
  }
  const next = windowAsCourse(
    args.startsOn,
    args.endsOn,
    latest,
    args.createdAt,
    args.timeZone,
  );
  return validateCourses(
    latest
      ? courses.map((c) =>
          c.id === latest.id
            ? { ...next, endedAt: keptEndedAt(latest, next.endsOn) }
            : c,
        )
      : [next],
    todayKey,
    args.oneShot,
  );
}

// ── The read side ──────────────────────────────────────────────────────────

export interface MedicationCourseDto {
  id: string;
  startsOn: string;
  endsOn: string | null;
  /**
   * #1280 — the instant "End course" ended this course (ISO), or null when
   * the whole `endsOn` day counts.
   */
  endedAt: string | null;
  status: CourseStatus;
  /** Doses logged as taken whose slot falls on a day of this course. */
  takenDoses: number;
  /** The person's note on this course, decrypted. */
  note: string | null;
}

export interface MedicationCourseFields {
  courses: MedicationCourseDto[];
  courseCount: number;
  previousCourseEndedOn: string | null;
  canStartCourse: boolean;
}

/** Every course of the given medications, ascending by start. */
export async function loadCoursesFor(
  medicationIds: string[],
): Promise<Map<string, CourseRow[]>> {
  const byMedication = new Map<string, CourseRow[]>();
  if (medicationIds.length === 0) return byMedication;
  const rows = await prisma.medicationCourse.findMany({
    where: { medicationId: { in: medicationIds } },
    orderBy: [{ startsOn: "asc" }, { id: "asc" }],
    select: { ...COURSE_ROW_SELECT, medicationId: true },
  });
  for (const { medicationId, ...row } of rows) {
    const list = byMedication.get(medicationId) ?? [];
    list.push(row);
    byMedication.set(medicationId, list);
  }
  return byMedication;
}

/**
 * Taken doses per course: intake rows with a `takenAt`, not tombstoned,
 * whose scheduled slot falls on a day of the course on the person's clock.
 */
export async function countTakenDosesPerCourse(
  medicationIds: string[],
  timeZone: string,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (medicationIds.length === 0) return counts;
  const rows = await prisma.$queryRaw<Array<{ id: string; taken: number }>>`
    SELECT c."id", COUNT(e."id")::int AS taken
    FROM "medication_courses" c
    JOIN "medication_intake_events" e
      ON e."medication_id" = c."medication_id"
     AND e."taken_at" IS NOT NULL
     AND e."deleted_at" IS NULL
     AND (e."scheduled_for" AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone})::date
         BETWEEN c."starts_on" AND COALESCE(c."ends_on", 'infinity'::date)
    WHERE c."medication_id" = ANY(${medicationIds}::text[])
    GROUP BY c."id"
  `;
  for (const row of rows) counts.set(row.id, row.taken);
  return counts;
}

/** The resolved course fields the medication list and detail publish. */
export function buildCourseFields(
  medication: { active: boolean; oneShot: boolean },
  courses: readonly CourseRow[],
  takenByCourse: ReadonlyMap<string, number>,
  now: Date,
  timeZone: string,
): MedicationCourseFields {
  const todayKey = userDayKey(now, timeZone);
  const ended = previousCourseEndedOn(courses, todayKey);
  return {
    courses: courses.map((c) => ({
      id: c.id,
      startsOn: dayKeyOfDate(c.startsOn),
      endsOn: c.endsOn ? dayKeyOfDate(c.endsOn) : null,
      endedAt: c.endedAt ? c.endedAt.toISOString() : null,
      status: courseStatusOn(c, todayKey),
      takenDoses: takenByCourse.get(c.id) ?? 0,
      note: c.noteEncrypted ? decryptFromBytes(c.noteEncrypted) : null,
    })),
    courseCount: courses.length,
    previousCourseEndedOn: ended ? dayKeyOfDate(ended) : null,
    canStartCourse: canStartCourse({
      active: medication.active,
      oneShot: medication.oneShot,
      courses,
      todayKey,
    }),
  };
}

/** The read side for a set of medications, in two queries. */
export async function resolveCourseFields(
  medications: readonly { id: string; active: boolean; oneShot: boolean }[],
  now: Date,
  timeZone: string,
): Promise<Map<string, MedicationCourseFields>> {
  const ids = medications.map((m) => m.id);
  const [coursesBy, taken] = await Promise.all([
    loadCoursesFor(ids),
    countTakenDosesPerCourse(ids, timeZone),
  ]);
  return new Map(
    medications.map((m) => [
      m.id,
      buildCourseFields(m, coursesBy.get(m.id) ?? [], taken, now, timeZone),
    ]),
  );
}
