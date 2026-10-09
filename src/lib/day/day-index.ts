/**
 * Which days of a window hold anything, by section (v1.42, #613).
 *
 * Feeds the row of day dots under a chart and tells a list which of its dates
 * open a day with content. Dates and section keys only: no value, no title,
 * no free text. Bounded to at most `DAY_INDEX_MAX_SPAN_DAYS` days, and each
 * section reads one column of its own table over the window.
 *
 * Only what happens on a day marks it. Something that runs through days (a
 * medication, an illness, a trip) would mark every one of them and say
 * nothing; its start and end mark theirs. The weather row exists for every
 * day and marks none.
 *
 * The sleep dot is a close reading: a night is filed under the day it woke
 * on, and the index takes a stage row ending after 18:00 as part of the next
 * night. The day itself reconstructs the night exactly.
 */
import {
  MeasurementType,
  type MeasurementType as MeasurementTypeValue,
} from "@/generated/prisma/enums";

import {
  DAY_SECTION_KEYS,
  type DayIndexResponse,
  type DaySectionKey,
} from "@/lib/day/contract";
import { readLocalDaysWithReadings } from "@/lib/day/daily-stats";
import { loadNotableRange } from "@/lib/day/notable";
import { measurementTypeVisible, type DayAccess } from "@/lib/day/sections";
import { prisma } from "@/lib/db";
import { TRACKED_INTAKE_EVENT_WHERE } from "@/lib/medications/intake-tracking";
import { effectiveMoodTz } from "@/lib/mood/date-key";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { dateOnlyKey, dayKeyAsUtcMidnight } from "@/lib/tz/date-only";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { startOfLocalDayKey } from "@/lib/tz/local-day";

type DayMarks = Map<string, Set<DaySectionKey>>;

function mark(
  marks: DayMarks,
  day: string,
  section: DaySectionKey,
  from: string,
  to: string,
): void {
  if (day < from || day > to) return;
  let set = marks.get(day);
  if (!set) marks.set(day, (set = new Set()));
  set.add(section);
}

interface IndexFrame {
  userId: string;
  from: string;
  to: string;
  tz: string;
  start: Date;
  end: Date;
  marks: DayMarks;
}

/** Mark every instant's local day. */
function markInstants(
  frame: IndexFrame,
  section: DaySectionKey,
  instants: ReadonlyArray<Date | null>,
): void {
  for (const at of instants) {
    if (at)
      mark(
        frame.marks,
        userDayKey(at, frame.tz),
        section,
        frame.from,
        frame.to,
      );
  }
}

async function measurementDays(
  frame: IndexFrame,
  types: readonly MeasurementTypeValue[],
  section: DaySectionKey,
  shiftHours: number,
): Promise<void> {
  const days = await readLocalDaysWithReadings({
    userId: frame.userId,
    types,
    from: frame.start,
    to: frame.end,
    tz: frame.tz,
    shiftHours,
  });
  for (const day of days) mark(frame.marks, day, section, frame.from, frame.to);
}

const instantWindow = (frame: IndexFrame) => ({
  gte: frame.start,
  lt: frame.end,
});

/** The per-section readers of the index. */
const INDEX_READERS: Partial<
  Record<DaySectionKey, (frame: IndexFrame) => Promise<void>>
> = {
  async medications(frame) {
    const startKey = dayKeyAsUtcMidnight(frame.from);
    const endKey = dayKeyAsUtcMidnight(frame.to);
    const [intakes, changes, meds, courses, pauses] = await Promise.all([
      prisma.medicationIntakeEvent.findMany({
        where: {
          userId: frame.userId,
          deletedAt: null,
          skipped: false,
          takenAt: instantWindow(frame),
          ...TRACKED_INTAKE_EVENT_WHERE,
        },
        select: { takenAt: true },
      }),
      prisma.medicationDoseChange.findMany({
        where: {
          medication: { userId: frame.userId },
          effectiveFrom: instantWindow(frame),
        },
        select: { effectiveFrom: true },
      }),
      prisma.medication.findMany({
        where: {
          userId: frame.userId,
          OR: [
            { startsOn: { gte: startKey, lte: endKey } },
            { endsOn: { gte: startKey, lte: endKey } },
          ],
        },
        select: { startsOn: true, endsOn: true },
      }),
      prisma.medicationCourse.findMany({
        where: {
          userId: frame.userId,
          OR: [
            { startsOn: { gte: startKey, lte: endKey } },
            { endsOn: { gte: startKey, lte: endKey } },
          ],
        },
        select: { startsOn: true, endsOn: true },
      }),
      prisma.medicationPauseEra.findMany({
        where: {
          userId: frame.userId,
          OR: [
            { pausedAt: instantWindow(frame) },
            { resumedAt: instantWindow(frame) },
          ],
        },
        select: { pausedAt: true, resumedAt: true },
      }),
    ]);
    markInstants(
      frame,
      "medications",
      intakes.map((r) => r.takenAt),
    );
    markInstants(
      frame,
      "medications",
      changes.map((r) => r.effectiveFrom),
    );
    markInstants(
      frame,
      "medications",
      pauses.flatMap((r) => [r.pausedAt, r.resumedAt]),
    );
    for (const row of [...meds, ...courses]) {
      for (const date of [row.startsOn, row.endsOn]) {
        if (date)
          mark(
            frame.marks,
            dateOnlyKey(date),
            "medications",
            frame.from,
            frame.to,
          );
      }
    }
  },
  async illness(frame) {
    const [episodes, logs] = await Promise.all([
      prisma.illnessEpisode.findMany({
        where: {
          userId: frame.userId,
          deletedAt: null,
          OR: [
            { onsetAt: instantWindow(frame) },
            { resolvedAt: instantWindow(frame) },
          ],
        },
        select: { onsetAt: true, resolvedAt: true },
      }),
      prisma.illnessDayLog.findMany({
        where: {
          userId: frame.userId,
          deletedAt: null,
          date: { gte: frame.from, lte: frame.to },
        },
        select: { date: true },
      }),
    ]);
    markInstants(
      frame,
      "illness",
      episodes.flatMap((r) => [r.onsetAt, r.resolvedAt]),
    );
    for (const log of logs)
      mark(frame.marks, log.date, "illness", frame.from, frame.to);
  },
  async symptoms(frame) {
    const rows = await prisma.symptomEvent.findMany({
      where: { userId: frame.userId, occurredAt: instantWindow(frame) },
      select: { occurredAt: true },
    });
    markInstants(
      frame,
      "symptoms",
      rows.map((r) => r.occurredAt),
    );
  },
  async allergies(frame) {
    const rows = await prisma.allergy.findMany({
      where: {
        userId: frame.userId,
        deletedAt: null,
        onsetAt: instantWindow(frame),
      },
      select: { onsetAt: true },
    });
    markInstants(
      frame,
      "allergies",
      rows.map((r) => r.onsetAt),
    );
  },
  async labs(frame) {
    const rows = await prisma.labResult.findMany({
      where: {
        userId: frame.userId,
        deletedAt: null,
        takenAt: instantWindow(frame),
      },
      select: { takenAt: true },
    });
    markInstants(
      frame,
      "labs",
      rows.map((r) => r.takenAt),
    );
  },
  async visits(frame) {
    const rows = await prisma.encounter.findMany({
      where: {
        userId: frame.userId,
        deletedAt: null,
        status: { in: ["DONE", "PLANNED"] },
        occurredAt: instantWindow(frame),
      },
      select: { occurredAt: true },
    });
    markInstants(
      frame,
      "visits",
      rows.map((r) => r.occurredAt),
    );
  },
  async vaccinations(frame) {
    const rows = await prisma.vaccinationRecord.findMany({
      where: {
        userId: frame.userId,
        deletedAt: null,
        occurredAt: instantWindow(frame),
      },
      select: { occurredAt: true },
    });
    markInstants(
      frame,
      "vaccinations",
      rows.map((r) => r.occurredAt),
    );
  },
  async checkups(frame) {
    const rows = await prisma.measurementReminderEvent.findMany({
      where: {
        userId: frame.userId,
        kind: "SATISFIED",
        occurredAt: instantWindow(frame),
        reminder: { deletedAt: null, origin: "VORSORGE" },
      },
      select: { occurredAt: true },
    });
    markInstants(
      frame,
      "checkups",
      rows.map((r) => r.occurredAt),
    );
  },
  async documents(frame) {
    const start = dayKeyAsUtcMidnight(frame.from);
    const end = dayKeyAsUtcMidnight(shiftDateKey(frame.to, 1));
    const rows = await prisma.inboundDocument.findMany({
      where: {
        userId: frame.userId,
        deletedAt: null,
        OR: [
          { reportDate: { gte: start, lt: end } },
          { reportDate: null, documentDate: { gte: start, lt: end } },
        ],
      },
      select: { reportDate: true, documentDate: true },
    });
    for (const row of rows) {
      const date = row.reportDate ?? row.documentDate;
      if (date)
        mark(frame.marks, dateOnlyKey(date), "documents", frame.from, frame.to);
    }
  },
  async mood(frame) {
    const rows = await prisma.moodEntry.findMany({
      where: {
        userId: frame.userId,
        deletedAt: null,
        date: { gte: frame.from, lte: frame.to },
      },
      select: { date: true },
      distinct: ["date"],
    });
    for (const row of rows)
      mark(frame.marks, row.date, "mood", frame.from, frame.to);
  },
  async assessments(frame) {
    const rows = await prisma.mentalHealthAssessment.findMany({
      where: {
        userId: frame.userId,
        deletedAt: null,
        takenAt: {
          gte: new Date(frame.start.getTime() - 14 * 3_600_000),
          lt: new Date(frame.end.getTime() + 14 * 3_600_000),
        },
      },
      select: { takenAt: true, tz: true },
    });
    for (const row of rows) {
      const tz = row.tz ? effectiveMoodTz(row) : frame.tz;
      mark(
        frame.marks,
        userDayKey(row.takenAt, tz),
        "assessments",
        frame.from,
        frame.to,
      );
    }
  },
  async workouts(frame) {
    const rows = await prisma.workout.findMany({
      where: { userId: frame.userId, startedAt: instantWindow(frame) },
      select: { startedAt: true },
    });
    markInstants(
      frame,
      "workouts",
      rows.map((r) => r.startedAt),
    );
  },
  async cycle(frame) {
    const rows = await prisma.cycleDayLog.findMany({
      where: {
        userId: frame.userId,
        deletedAt: null,
        date: { gte: frame.from, lte: frame.to },
      },
      select: { date: true },
    });
    for (const row of rows)
      mark(frame.marks, row.date, "cycle", frame.from, frame.to);
  },
  async lifeEvents(frame) {
    const rows = await prisma.lifeEvent.findMany({
      where: {
        userId: frame.userId,
        deletedAt: null,
        precision: "DAY",
        startDate: { gte: frame.from, lte: frame.to },
      },
      select: { startDate: true },
    });
    for (const row of rows)
      mark(frame.marks, row.startDate, "lifeEvents", frame.from, frame.to);
  },
};

export async function loadDayIndex(args: {
  recordId: string;
  from: string;
  to: string;
  access: DayAccess;
  tz: string;
}): Promise<DayIndexResponse> {
  const { recordId, from, to, access, tz } = args;
  const frame: IndexFrame = {
    userId: recordId,
    from,
    to,
    tz,
    start: startOfLocalDayKey(from, tz),
    end: startOfLocalDayKey(shiftDateKey(to, 1), tz),
    marks: new Map(),
  };
  const visible = (type: MeasurementTypeValue) =>
    measurementTypeVisible(type, access.modules);
  const valueTypes = access.readable.has("values")
    ? Object.values(MeasurementType).filter(
        (t) => t !== "SLEEP_DURATION" && visible(t),
      )
    : [];
  const sleepTypes =
    access.readable.has("sleep") && visible("SLEEP_DURATION")
      ? (["SLEEP_DURATION"] as MeasurementTypeValue[])
      : [];

  const readers = [...access.readable].flatMap((section) => {
    const reader = INDEX_READERS[section];
    return reader ? [reader(frame)] : [];
  });
  const [, , , notable] = await Promise.all([
    measurementDays(frame, valueTypes, "values", 0),
    measurementDays(frame, sleepTypes, "sleep", 6),
    Promise.all(readers),
    valueTypes.length === 0
      ? Promise.resolve([])
      : loadUserSourcePriority(recordId).then((priorityJson) =>
          loadNotableRange({
            userId: recordId,
            from,
            to,
            tz,
            priorityJson,
            typeVisible: (t) => valueTypes.includes(t),
            gaps: false,
          }),
        ),
  ]);

  const days: DayIndexResponse["days"] = {};
  for (const day of [...frame.marks.keys()].sort()) {
    const held = frame.marks.get(day) ?? new Set<DaySectionKey>();
    days[day] = DAY_SECTION_KEYS.filter((section) => held.has(section));
  }
  return {
    from,
    to,
    days,
    notable: [...new Set(notable.map((n) => n.date))].sort(),
  };
}
