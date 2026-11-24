/**
 * The doctor report's two medication reads and the list rows made from them,
 * apart from the collector that assembles the report around them.
 */
import { prisma } from "@/lib/db";
import { courseStatusOn, dayKeyOfDate } from "@/lib/medications/course-window";
import {
  COURSES_COMPLIANCE_SELECT,
  SCHEDULE_COMPLIANCE_SELECT,
} from "@/lib/analytics/compliance";

/**
 * The medications the report window holds: active, and with a course, a
 * logged dose or (without courses) their own dates overlapping the window.
 */
export function findReportMedications(
  userId: string,
  window: { start: Date; end: Date; firstDay: Date; lastDay: Date },
) {
  const { start, end, firstDay, lastDay } = window;
  return prisma.medication.findMany({
    // The report describes its window, and a link can pin that window
    // in the past: a medication whose course had not begun by the
    // window's end, or had ended before it began, is not part of it.
    // One with a dose scheduled inside the window was taken then,
    // whenever it was entered. Dose history and the last intake stop
    // at the window's end too, so a report for March does not show a
    // dose set in June.
    //
    // #1024 — a medication taken in courses is part of the
    // window when one of its courses overlaps it; the row's own
    // window is only the latest course. One without courses keeps
    // the rule above.
    where: {
      userId,
      active: true,
      OR: [
        {
          courses: {
            some: {
              startsOn: { lte: lastDay },
              OR: [{ endsOn: null }, { endsOn: { gte: firstDay } }],
            },
          },
        },
        {
          // A dose logged inside the window outside every course (the
          // person knows better than the window) still places it.
          courses: { some: {} },
          intakeEvents: {
            some: {
              deletedAt: null,
              scheduledFor: { gte: start, lte: end },
            },
          },
        },
        {
          courses: { none: {} },
          AND: [
            {
              OR: [
                { startsOn: { lte: lastDay } },
                { startsOn: null, createdAt: { lte: end } },
                {
                  intakeEvents: {
                    some: {
                      deletedAt: null,
                      scheduledFor: { gte: start, lte: end },
                    },
                  },
                },
              ],
            },
            { OR: [{ endsOn: null }, { endsOn: { gte: firstDay } }] },
          ],
        },
      ],
    },
    include: {
      schedules: {
        select: { ...SCHEDULE_COMPLIANCE_SELECT, label: true },
      },
      scheduleRevisions: {
        orderBy: [{ validFrom: "asc" }, { id: "asc" }],
        select: {
          id: true,
          validFrom: true,
          validUntil: true,
          payload: true,
          supersededByRevisionId: true,
        },
      },
      pauseEras: { select: { pausedAt: true, resumedAt: true } },
      // #1024 — the courses, so a gap between two expects nothing.
      courses: COURSES_COMPLIANCE_SELECT,
      doseChanges: {
        where: { effectiveFrom: { lte: end } },
        orderBy: [{ effectiveFrom: "asc" }, { id: "asc" }],
      },
      // The last take that stands: a deleted dose (undone, or merged as a
      // second row of its slot) is not the last one.
      intakeEvents: {
        where: { deletedAt: null, takenAt: { not: null, lte: end } },
        orderBy: [{ takenAt: "desc" }, { id: "desc" }],
        take: 1,
        select: { takenAt: true, injectionSite: true },
      },
    },
  });
}

/** The window's scheduled doses with the medication fields the report prints. */
export function findReportIntakeEvents(userId: string, start: Date, end: Date) {
  return prisma.medicationIntakeEvent.findMany({
    where: {
      userId,
      deletedAt: null,
      scheduledFor: { gte: start, lte: end },
    },
    include: {
      medication: {
        select: {
          id: true,
          name: true,
          dose: true,
          atcCode: true,
          rxNormCode: true,
          deliveryForm: true,
          asNeeded: true,
        },
      },
    },
    orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
  });
}

/** The medication list rows: each medication with the courses inside the window. */
export function toReportMedicationRows(
  medications: Awaited<ReturnType<typeof findReportMedications>>,
  firstDay: Date,
  lastDay: Date,
) {
  return medications.map((m) => ({
    id: m.id,
    name: m.name,
    dose: m.dose,
    atcCode: m.atcCode,
    rxNormCode: m.rxNormCode,
    schedules: m.schedules.map((s) => ({
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      label: s.label,
    })),
    // v1.40 (#1024) — the courses inside the window, one line each.
    courses: m.courses
      .filter(
        (c) =>
          c.startsOn.getTime() <= lastDay.getTime() &&
          (c.endsOn === null || c.endsOn.getTime() >= firstDay.getTime()),
      )
      .map((c) => ({
        startsOn: dayKeyOfDate(c.startsOn),
        endsOn: c.endsOn ? dayKeyOfDate(c.endsOn) : null,
        status: courseStatusOn(c, dayKeyOfDate(lastDay)),
      })),
  }));
}
