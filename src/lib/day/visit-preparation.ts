/**
 * "Since the last visit": the window a person brings to the next appointment
 * (v1.42, #613).
 *
 * The observations of `notable.ts` over the window (extremes, first readings
 * and, here only, gaps) plus the context changes that happened in it: dose
 * changes, medications and courses starting or ending, pauses, illnesses
 * starting or ending, vaccinations, procedures and the days with new lab
 * results. A list, oldest first, no ranking and no reading of causes. The
 * view shows the first few and puts the rest behind "All".
 *
 * Each change belongs to a day section and appears only when the caller may
 * read that section; observations need the readings.
 */
import type {
  DayChange,
  DayNotableWindowResponse,
  DaySectionKey,
} from "@/lib/day/contract";
import { DAY_NOTABLE_MAX_SPAN_DAYS } from "@/lib/day/contract";
import { loadNotableRange } from "@/lib/day/notable";
import { openText } from "@/lib/day/records";
import { measurementTypeVisible, type DayAccess } from "@/lib/day/sections";
import { prisma } from "@/lib/db";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { dateOnlyKey, dayKeyAsUtcMidnight } from "@/lib/tz/date-only";
import { daysBetweenDateKeys, shiftDateKey, userDayKey } from "@/lib/tz/format";
import { startOfLocalDayKey } from "@/lib/tz/local-day";

/** The window when the record holds no visit the caller may see. */
export const FALLBACK_WINDOW_DAYS = 90;

/** At most this many lab analytes are named on one lab day. */
const LAB_NAMES_PER_DAY = 5;

interface Window {
  userId: string;
  from: string;
  to: string;
  tz: string;
  start: Date;
  end: Date;
}

function change(
  date: string,
  section: DaySectionKey,
  rest: Omit<DayChange, "date" | "section" | "count"> & { count?: number },
): DayChange {
  return { date, section, count: 1, ...rest };
}

async function medicationChanges(w: Window): Promise<DayChange[]> {
  const startKey = dayKeyAsUtcMidnight(w.from);
  const endKey = dayKeyAsUtcMidnight(w.to);
  const inWindow = { gte: w.start, lt: w.end };
  const [doseChanges, meds, courses, pauses] = await Promise.all([
    prisma.medicationDoseChange.findMany({
      where: { medication: { userId: w.userId }, effectiveFrom: inWindow },
      select: {
        id: true,
        medicationId: true,
        effectiveFrom: true,
        medication: { select: { name: true } },
      },
    }),
    prisma.medication.findMany({
      where: {
        userId: w.userId,
        OR: [
          { startsOn: { gte: startKey, lte: endKey } },
          { endsOn: { gte: startKey, lte: endKey } },
        ],
      },
      select: { id: true, name: true, startsOn: true, endsOn: true },
    }),
    prisma.medicationCourse.findMany({
      where: {
        userId: w.userId,
        OR: [
          { startsOn: { gte: startKey, lte: endKey } },
          { endsOn: { gte: startKey, lte: endKey } },
        ],
      },
      select: {
        id: true,
        medicationId: true,
        startsOn: true,
        endsOn: true,
        medication: { select: { name: true } },
      },
    }),
    prisma.medicationPauseEra.findMany({
      where: {
        userId: w.userId,
        OR: [{ pausedAt: inWindow }, { resumedAt: inWindow }],
      },
      select: {
        id: true,
        medicationId: true,
        pausedAt: true,
        resumedAt: true,
        medication: { select: { name: true } },
      },
    }),
  ]);
  const out: DayChange[] = [];
  const within = (day: string) => day >= w.from && day <= w.to;
  for (const row of doseChanges) {
    out.push(
      change(userDayKey(row.effectiveFrom, w.tz), "medications", {
        kind: "doseChange",
        id: row.id,
        title: row.medication.name,
        href: `/medications/${row.medicationId}/history`,
      }),
    );
  }
  for (const med of meds) {
    const href = `/medications/${med.id}`;
    const start = med.startsOn ? dateOnlyKey(med.startsOn) : null;
    const end = med.endsOn ? dateOnlyKey(med.endsOn) : null;
    if (start && within(start)) {
      out.push(
        change(start, "medications", {
          kind: "medicationStart",
          id: med.id,
          title: med.name,
          href,
        }),
      );
    }
    if (end && within(end)) {
      out.push(
        change(end, "medications", {
          kind: "medicationEnd",
          id: med.id,
          title: med.name,
          href,
        }),
      );
    }
  }
  for (const course of courses) {
    const href = `/medications/${course.medicationId}`;
    const start = dateOnlyKey(course.startsOn);
    const end = course.endsOn ? dateOnlyKey(course.endsOn) : null;
    if (within(start)) {
      out.push(
        change(start, "medications", {
          kind: "courseStart",
          id: course.id,
          title: course.medication.name,
          href,
        }),
      );
    }
    if (end && within(end)) {
      out.push(
        change(end, "medications", {
          kind: "courseEnd",
          id: course.id,
          title: course.medication.name,
          href,
        }),
      );
    }
  }
  for (const pause of pauses) {
    const href = `/medications/${pause.medicationId}`;
    const start = userDayKey(pause.pausedAt, w.tz);
    if (within(start)) {
      out.push(
        change(start, "medications", {
          kind: "pauseStart",
          id: pause.id,
          title: pause.medication.name,
          href,
        }),
      );
    }
    if (pause.resumedAt) {
      const end = userDayKey(pause.resumedAt, w.tz);
      if (within(end)) {
        out.push(
          change(end, "medications", {
            kind: "pauseEnd",
            id: pause.id,
            title: pause.medication.name,
            href,
          }),
        );
      }
    }
  }
  return out;
}

async function illnessChanges(w: Window): Promise<DayChange[]> {
  const inWindow = { gte: w.start, lt: w.end };
  const rows = await prisma.illnessEpisode.findMany({
    where: {
      userId: w.userId,
      deletedAt: null,
      OR: [{ onsetAt: inWindow }, { resolvedAt: inWindow }],
    },
    select: { id: true, label: true, onsetAt: true, resolvedAt: true },
  });
  const out: DayChange[] = [];
  for (const row of rows) {
    const href = `/illness/${row.id}`;
    if (row.onsetAt >= w.start && row.onsetAt < w.end) {
      out.push(
        change(userDayKey(row.onsetAt, w.tz), "illness", {
          kind: "illnessOnset",
          id: row.id,
          title: row.label,
          href,
        }),
      );
    }
    if (row.resolvedAt && row.resolvedAt >= w.start && row.resolvedAt < w.end) {
      out.push(
        change(userDayKey(row.resolvedAt, w.tz), "illness", {
          kind: "illnessResolved",
          id: row.id,
          title: row.label,
          href,
        }),
      );
    }
  }
  return out;
}

async function vaccinationChanges(w: Window): Promise<DayChange[]> {
  const rows = await prisma.vaccinationRecord.findMany({
    where: {
      userId: w.userId,
      deletedAt: null,
      occurredAt: { gte: w.start, lt: w.end },
    },
    select: {
      id: true,
      occurredAt: true,
      vaccineName: true,
      antigenSlug: true,
      customVaccine: { select: { name: true } },
    },
  });
  return rows.map((row) =>
    change(userDayKey(row.occurredAt, w.tz), "vaccinations", {
      kind: "vaccination",
      id: row.id,
      title:
        row.vaccineName ?? row.customVaccine?.name ?? row.antigenSlug ?? "",
      href: `/vaccinations?dose=${row.id}`,
    }),
  );
}

async function procedureChanges(w: Window): Promise<DayChange[]> {
  const rows = await prisma.encounter.findMany({
    where: {
      userId: w.userId,
      deletedAt: null,
      status: "DONE",
      kind: "PROCEDURE",
      occurredAt: { gte: w.start, lt: w.end },
    },
    select: { id: true, occurredAt: true, reasonEncrypted: true },
  });
  return rows.map((row) =>
    change(userDayKey(row.occurredAt, w.tz), "visits", {
      kind: "procedure",
      id: row.id,
      title: openText(row.reasonEncrypted, "procedure reason") ?? "",
      href: `/checkups?visit=${row.id}`,
    }),
  );
}

async function labChanges(w: Window): Promise<DayChange[]> {
  const rows = await prisma.labResult.findMany({
    where: {
      userId: w.userId,
      deletedAt: null,
      takenAt: { gte: w.start, lt: w.end },
    },
    select: { id: true, analyte: true, takenAt: true },
    orderBy: [{ takenAt: "asc" }, { analyte: "asc" }],
  });
  const byDay = new Map<string, { ids: string[]; names: string[] }>();
  for (const row of rows) {
    const day = userDayKey(row.takenAt, w.tz);
    const slot = byDay.get(day) ?? { ids: [], names: [] };
    slot.ids.push(row.id);
    if (!slot.names.includes(row.analyte)) slot.names.push(row.analyte);
    byDay.set(day, slot);
  }
  return [...byDay].map(([day, slot]) =>
    change(day, "labs", {
      kind: "labResult",
      id: slot.ids[0],
      title: slot.names.slice(0, LAB_NAMES_PER_DAY).join(", "),
      count: slot.ids.length,
      href: "/labs",
    }),
  );
}

const CHANGE_READERS: ReadonlyArray<
  [DaySectionKey, (w: Window) => Promise<DayChange[]>]
> = [
  ["medications", medicationChanges],
  ["illness", illnessChanges],
  ["vaccinations", vaccinationChanges],
  ["visits", procedureChanges],
  ["labs", labChanges],
];

/** The local date of the last completed visit before `today`, if any. */
async function lastVisitDay(
  userId: string,
  tz: string,
  before: Date,
): Promise<string | null> {
  const row = await prisma.encounter.findFirst({
    where: {
      userId,
      deletedAt: null,
      status: "DONE",
      occurredAt: { lt: before },
    },
    select: { occurredAt: true },
    orderBy: { occurredAt: "desc" },
  });
  return row ? userDayKey(row.occurredAt, tz) : null;
}

export async function loadSinceLastVisit(args: {
  recordId: string;
  access: DayAccess;
  tz: string;
  today: string;
  from?: string;
  to?: string;
}): Promise<DayNotableWindowResponse> {
  const { recordId, access, tz } = args;
  const to = args.to ?? args.today;
  let from: string;
  let anchor: DayNotableWindowResponse["anchor"];
  if (args.from) {
    from = args.from;
    anchor = "requested";
  } else {
    const last = access.readable.has("visits")
      ? await lastVisitDay(recordId, tz, startOfLocalDayKey(to, tz))
      : null;
    from = last ?? shiftDateKey(to, -FALLBACK_WINDOW_DAYS);
    anchor = last ? "lastVisit" : "fallback";
  }
  if (daysBetweenDateKeys(from, to) >= DAY_NOTABLE_MAX_SPAN_DAYS) {
    from = shiftDateKey(to, -(DAY_NOTABLE_MAX_SPAN_DAYS - 1));
  }

  const w: Window = {
    userId: recordId,
    from,
    to,
    tz,
    start: startOfLocalDayKey(from, tz),
    end: startOfLocalDayKey(shiftDateKey(to, 1), tz),
  };
  const valuesReadable = access.readable.has("values");
  const [observations, ...changeLists] = await Promise.all([
    valuesReadable
      ? loadUserSourcePriority(recordId).then((priorityJson) =>
          loadNotableRange({
            userId: recordId,
            from,
            to,
            tz,
            priorityJson,
            typeVisible: (type) => measurementTypeVisible(type, access.modules),
            gaps: true,
          }),
        )
      : Promise.resolve([]),
    ...CHANGE_READERS.filter(([section]) => access.readable.has(section)).map(
      ([, read]) => read(w),
    ),
  ]);

  return {
    from,
    to,
    anchor,
    observations: observations.map(({ date, kind, type, params }) => ({
      date,
      kind,
      type,
      params,
    })),
    changes: changeLists
      .flat()
      .sort(
        (a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind),
      ),
  };
}
