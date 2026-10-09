/**
 * What the timeline can already show, lane by lane (v1.42, #613).
 *
 * Counts and keys, never a score. Each lane is `carries`, `thin` or `empty`
 * by a rule a person can check against their own record, and each gap names
 * exactly one in-app place where it can be closed. The verdict is one of two
 * words: `carries` from three carrying lanes including the values, `thin`
 * otherwise. A lane of a switched-off module is not listed at all, not even
 * as a gap, and neither is one the caller's grant does not cover.
 *
 *   values        a core value on at least half of the last 13 weeks
 *   illness       at least one episode (every episode has an onset)
 *   allergies     at least one with an onset; only undated ones is thin and
 *                 is no gap, a lasting allergy needs no date
 *   medications   every medication has a start (or a first intake to stand
 *                 in); some without one is thin, with a link to the first
 *   vaccinations  at least one dose
 *   visits        at least one completed visit; only planned ones is thin
 *   labs          at least one result
 *   documents     at least one dated document; only undated ones is thin
 *   cycle, mood, environment
 *                 entries on at least half of the last 13 weeks
 *   life          at least one life event
 */
import type { MeasurementType } from "@/generated/prisma/enums";

import type {
  TimelineReadinessKey,
  TimelineReadinessLane,
  TimelineReadinessResponse,
} from "@/lib/day/contract";
import { readLocalDaysWithReadings } from "@/lib/day/daily-stats";
import { listLiveMeasurementTypes } from "@/lib/measurements/live-types";
import { prisma } from "@/lib/db";
import { TRACKED_INTAKE_EVENT_WHERE } from "@/lib/medications/intake-tracking";
import { measurementTypeVisible } from "@/lib/day/sections";
import { laneVisible, type TimelineAccess } from "@/lib/timeline/lanes";
import { dateOnlyKey } from "@/lib/tz/date-only";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { startOfLocalDayKey } from "@/lib/tz/local-day";
import { bucketKey } from "@/lib/timeline/series";

/** The values that make the values lane carry. */
const CORE_VALUE_TYPES: readonly MeasurementType[] = [
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "PULSE",
  "RESTING_HEART_RATE",
  "BLOOD_GLUCOSE",
];

/** The weeks a regular lane is judged over. */
export const READINESS_WEEKS = 13;

type LaneResult = Omit<TimelineReadinessLane, "key"> & {
  /** The earliest date the lane reaches back to, when it carries. */
  since: string | null;
};

function lane(
  status: LaneResult["status"],
  count: number,
  since: string | null,
  extra: Partial<Pick<LaneResult, "detail" | "gaps">> = {},
): LaneResult {
  return { status, count, since, detail: null, gaps: [], ...extra };
}

/** How many of the last {@link READINESS_WEEKS} weeks hold a day. */
export function coveredWeeks(days: Iterable<string>, today: string): number {
  const first = shiftDateKey(today, -7 * READINESS_WEEKS + 1);
  const weeks = new Set<string>();
  for (const day of days) {
    if (day >= first && day <= today) weeks.add(bucketKey(day, "week"));
  }
  return weeks.size;
}

/** Nothing yet: the one detail an empty lane carries. */
const EMPTY_DETAIL = { key: "empty", params: {} } as const;

/** A gap with its one in-app link. */
function gap(key: string, count: number, href: string) {
  return { key, count, href };
}

/**
 * A lane judged by how regularly it is filled: `carries` with entries on at
 * least half of the last {@link READINESS_WEEKS} weeks, `thin` with fewer,
 * `empty` with none.
 */
function regular(
  weeks: number,
  total: number,
  since: string | null,
  detail: LaneResult["detail"],
  emptyGap: ReturnType<typeof gap> | null,
): LaneResult {
  const status =
    weeks * 2 >= READINESS_WEEKS ? "carries" : total > 0 ? "thin" : "empty";
  if (status === "empty") {
    return lane("empty", 0, null, {
      detail: EMPTY_DETAIL,
      gaps: emptyGap ? [emptyGap] : [],
    });
  }
  return lane(status, total, status === "carries" ? since : null, { detail });
}

interface Frame {
  userId: string;
  tz: string;
  today: string;
  /** The regular-lane window, `[windowStart, windowEnd)`. */
  windowStart: Date;
  windowEnd: Date;
}

async function valuesLane(frame: Frame, types: MeasurementType[]) {
  const emptyGap = gap("valuesEmpty", 0, "/settings/sources");
  if (types.length === 0) {
    return lane("empty", 0, null, { detail: EMPTY_DETAIL, gaps: [emptyGap] });
  }
  const [days, first, present] = await Promise.all([
    readLocalDaysWithReadings({
      userId: frame.userId,
      types,
      from: frame.windowStart,
      to: frame.windowEnd,
      tz: frame.tz,
    }),
    prisma.measurement.findFirst({
      where: { userId: frame.userId, deletedAt: null, type: { in: types } },
      orderBy: { measuredAt: "asc" },
      select: { measuredAt: true },
    }),
    listLiveMeasurementTypes(frame.userId, { types }),
  ]);
  const since = first ? userDayKey(first.measuredAt, frame.tz) : null;
  return regular(
    coveredWeeks(days, frame.today),
    days.size,
    since,
    {
      key: "values",
      params: { count: present.length, ...(since ? { since } : {}) },
    },
    emptyGap,
  );
}

async function moodLane(frame: Frame) {
  const first = shiftDateKey(frame.today, -7 * READINESS_WEEKS + 1);
  const [rows, earliest, total] = await Promise.all([
    prisma.moodEntry.findMany({
      where: { userId: frame.userId, deletedAt: null, date: { gte: first } },
      select: { date: true },
      distinct: ["date"],
    }),
    prisma.moodEntry.findFirst({
      where: { userId: frame.userId, deletedAt: null },
      orderBy: { date: "asc" },
      select: { date: true },
    }),
    prisma.moodEntry.count({
      where: { userId: frame.userId, deletedAt: null },
    }),
  ]);
  const since = earliest?.date ?? null;
  return regular(
    coveredWeeks(
      rows.map((r) => r.date),
      frame.today,
    ),
    total,
    since,
    { key: "mood", params: { count: total, ...(since ? { since } : {}) } },
    null,
  );
}

async function cycleLane(frame: Frame) {
  const first = shiftDateKey(frame.today, -7 * READINESS_WEEKS + 1);
  const [rows, earliest, cycles] = await Promise.all([
    prisma.cycleDayLog.findMany({
      where: { userId: frame.userId, deletedAt: null, date: { gte: first } },
      select: { date: true },
    }),
    prisma.menstrualCycle.findFirst({
      where: { userId: frame.userId, deletedAt: null, isPredicted: false },
      orderBy: { startDate: "asc" },
      select: { startDate: true },
    }),
    prisma.menstrualCycle.count({
      where: { userId: frame.userId, deletedAt: null, isPredicted: false },
    }),
  ]);
  return regular(
    coveredWeeks(
      rows.map((r) => r.date),
      frame.today,
    ),
    cycles,
    earliest?.startDate ?? null,
    { key: "cycle", params: { count: cycles } },
    null,
  );
}

async function environmentLane(frame: Frame) {
  const first = shiftDateKey(frame.today, -7 * READINESS_WEEKS + 1);
  const [rows, earliest, total] = await Promise.all([
    prisma.environmentContext.findMany({
      where: { userId: frame.userId, date: { gte: first } },
      select: { date: true },
    }),
    prisma.environmentContext.findFirst({
      where: { userId: frame.userId },
      orderBy: { date: "asc" },
      select: { date: true },
    }),
    prisma.environmentContext.count({ where: { userId: frame.userId } }),
  ]);
  return regular(
    coveredWeeks(
      rows.map((r) => r.date),
      frame.today,
    ),
    total,
    earliest?.date ?? null,
    { key: "environment", params: { count: total } },
    null,
  );
}

async function illnessLane(frame: Frame) {
  const where = { userId: frame.userId, deletedAt: null };
  const [count, chronic, first] = await Promise.all([
    prisma.illnessEpisode.count({ where }),
    prisma.illnessEpisode.count({
      where: { ...where, lifecycle: "CHRONIC_ONGOING" },
    }),
    prisma.illnessEpisode.findFirst({
      where,
      orderBy: { onsetAt: "asc" },
      select: { onsetAt: true },
    }),
  ]);
  return count > 0
    ? lane(
        "carries",
        count,
        first ? userDayKey(first.onsetAt, frame.tz) : null,
        { detail: { key: "illness", params: { count, chronic } } },
      )
    : lane("empty", 0, null, {
        detail: EMPTY_DETAIL,
        gaps: [gap("illnessEmpty", 0, "/illness")],
      });
}

async function allergiesLane(frame: Frame) {
  const rows = await prisma.allergy.findMany({
    where: { userId: frame.userId, deletedAt: null },
    select: { onsetAt: true },
  });
  if (rows.length === 0) {
    return lane("empty", 0, null, { detail: EMPTY_DETAIL });
  }
  const detail = { key: "allergies", params: { count: rows.length } };
  const dated = rows.filter((r) => r.onsetAt !== null);
  if (dated.length > 0) {
    const since = dated
      .map((r) => userDayKey(r.onsetAt as Date, frame.tz))
      .sort()[0];
    return lane("carries", rows.length, since, { detail });
  }
  // Undated allergies are standing items, not a shortcoming: no gap.
  return lane("thin", rows.length, null, { detail });
}

async function medicationsLane(frame: Frame) {
  const [meds, intakes] = await Promise.all([
    prisma.medication.findMany({
      where: { userId: frame.userId },
      select: { id: true, startsOn: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.medicationIntakeEvent.groupBy({
      by: ["medicationId"],
      where: {
        userId: frame.userId,
        deletedAt: null,
        skipped: false,
        takenAt: { not: null },
        ...TRACKED_INTAKE_EVENT_WHERE,
      },
      _min: { takenAt: true },
    }),
  ]);
  if (meds.length === 0) {
    return lane("empty", 0, null, { detail: EMPTY_DETAIL });
  }
  const firstIntake = new Map(
    intakes.map((r) => [r.medicationId, r._min.takenAt]),
  );
  const starts: string[] = [];
  const missing: string[] = [];
  for (const med of meds) {
    // A first intake stands in for a missing start, as on the lane itself.
    const intake = firstIntake.get(med.id);
    if (med.startsOn) starts.push(dateOnlyKey(med.startsOn));
    else if (intake) starts.push(userDayKey(intake, frame.tz));
    else missing.push(med.id);
  }
  const since = starts.sort()[0] ?? null;
  if (missing.length === 0) {
    return lane("carries", meds.length, since, {
      detail: { key: "medicationsDated", params: { count: meds.length } },
    });
  }
  return lane("thin", meds.length, null, {
    detail: {
      key: "medications",
      params: { count: meds.length, missingStart: missing.length },
    },
    gaps: [
      gap(
        "medicationsWithoutStart",
        missing.length,
        `/medications/${missing[0]}?edit=1`,
      ),
    ],
  });
}

async function vaccinationsLane(frame: Frame) {
  const where = { userId: frame.userId, deletedAt: null };
  const [count, first] = await Promise.all([
    prisma.vaccinationRecord.count({ where }),
    prisma.vaccinationRecord.findFirst({
      where,
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true },
    }),
  ]);
  if (!first) {
    return lane("empty", 0, null, {
      detail: EMPTY_DETAIL,
      gaps: [gap("vaccinationsEmpty", 0, "/vaccinations")],
    });
  }
  return lane("carries", count, userDayKey(first.occurredAt, frame.tz), {
    detail: { key: "vaccinations", params: { count } },
  });
}

async function visitsLane(frame: Frame) {
  const where = { userId: frame.userId, deletedAt: null };
  const [done, procedures, planned, first] = await Promise.all([
    prisma.encounter.count({ where: { ...where, status: "DONE" } }),
    prisma.encounter.count({
      where: { ...where, status: "DONE", kind: "PROCEDURE" },
    }),
    prisma.encounter.count({ where: { ...where, status: "PLANNED" } }),
    prisma.encounter.findFirst({
      where: { ...where, status: "DONE" },
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true },
    }),
  ]);
  if (done > 0) {
    return lane(
      "carries",
      done,
      first ? userDayKey(first.occurredAt, frame.tz) : null,
      { detail: { key: "visits", params: { count: done, procedures } } },
    );
  }
  const visitGap = gap("visitsEmpty", 0, "/checkups");
  return planned > 0
    ? lane("thin", planned, null, {
        detail: { key: "visitsPlanned", params: { count: planned } },
        gaps: [visitGap],
      })
    : lane("empty", 0, null, { detail: EMPTY_DETAIL, gaps: [visitGap] });
}

async function labsLane(frame: Frame) {
  const rows = await prisma.labResult.findMany({
    where: { userId: frame.userId, deletedAt: null },
    select: { takenAt: true },
    orderBy: { takenAt: "asc" },
  });
  if (rows.length === 0) {
    return lane("empty", 0, null, {
      detail: EMPTY_DETAIL,
      gaps: [gap("labsEmpty", 0, "/labs")],
    });
  }
  const days = new Set(rows.map((r) => userDayKey(r.takenAt, frame.tz)));
  return lane("carries", days.size, userDayKey(rows[0].takenAt, frame.tz), {
    detail: { key: "labs", params: { count: days.size } },
  });
}

async function documentsLane(frame: Frame) {
  const [dated, undated] = await Promise.all([
    prisma.inboundDocument.findMany({
      where: {
        userId: frame.userId,
        deletedAt: null,
        OR: [{ reportDate: { not: null } }, { documentDate: { not: null } }],
      },
      select: { reportDate: true, documentDate: true },
    }),
    prisma.inboundDocument.count({
      where: {
        userId: frame.userId,
        deletedAt: null,
        reportDate: null,
        documentDate: null,
      },
    }),
  ]);
  const gaps =
    undated > 0 ? [gap("documentsUndated", undated, "/documents")] : [];
  if (dated.length > 0) {
    const since = dated
      .map((d) => dateOnlyKey((d.reportDate ?? d.documentDate) as Date))
      .sort()[0];
    return lane("carries", dated.length, since, {
      detail: { key: "documents", params: { count: dated.length } },
      gaps,
    });
  }
  return lane(undated > 0 ? "thin" : "empty", undated, null, {
    detail: EMPTY_DETAIL,
    gaps,
  });
}

async function lifeLane(frame: Frame) {
  // Owner-only: `laneVisible` leaves this lane out for every delegate.
  const where = { userId: frame.userId, deletedAt: null };
  const [count, first] = await Promise.all([
    prisma.lifeEvent.count({ where }),
    prisma.lifeEvent.findFirst({
      where,
      orderBy: { startDate: "asc" },
      select: { startDate: true },
    }),
  ]);
  return count > 0
    ? lane("carries", count, first?.startDate ?? null, {
        detail: { key: "life", params: { count } },
      })
    : lane("empty", 0, null, {
        gaps: [gap("lifeEventsEmpty", 0, "/timeline?add=lifeEvent")],
      });
}

export async function loadTimelineReadiness(args: {
  recordId: string;
  tz: string;
  access: TimelineAccess;
  now?: Date;
}): Promise<TimelineReadinessResponse> {
  const { access, tz } = args;
  const today = userDayKey(args.now ?? new Date(), tz);
  const frame: Frame = {
    userId: args.recordId,
    tz,
    today,
    windowStart: startOfLocalDayKey(
      shiftDateKey(today, -7 * READINESS_WEEKS + 1),
      tz,
    ),
    windowEnd: startOfLocalDayKey(shiftDateKey(today, 1), tz),
  };
  const valueTypes = access.domainVisible("measurements")
    ? CORE_VALUE_TYPES.filter((t) => measurementTypeVisible(t, access.modules))
    : [];

  const readers: Array<[TimelineReadinessKey, () => Promise<LaneResult>]> = [
    ["values", () => valuesLane(frame, valueTypes)],
  ];
  const laneReaders: Record<
    Exclude<TimelineReadinessKey, "values" | "mood" | "environment">,
    () => Promise<LaneResult>
  > = {
    life: () => lifeLane(frame),
    illness: () => illnessLane(frame),
    allergies: () => allergiesLane(frame),
    medications: () => medicationsLane(frame),
    vaccinations: () => vaccinationsLane(frame),
    visits: () => visitsLane(frame),
    labs: () => labsLane(frame),
    documents: () => documentsLane(frame),
    cycle: () => cycleLane(frame),
  };
  for (const [key, read] of Object.entries(laneReaders) as Array<
    [keyof typeof laneReaders, () => Promise<LaneResult>]
  >) {
    if (laneVisible(key, access)) readers.push([key, read]);
  }
  if (access.modules.mood !== false && access.domainVisible("mind")) {
    readers.push(["mood", () => moodLane(frame)]);
  }
  // The environment rows have no delegable route: the owner's lane only.
  if (access.modules.environment !== false && access.owner) {
    readers.push(["environment", () => environmentLane(frame)]);
  }

  const results = await Promise.all(readers.map(([, read]) => read()));
  const lanes = readers.map(([key], i) => {
    const { since: _since, ...rest } = results[i];
    return { key, ...rest };
  });
  const carrying = readers
    .map(([key], i) => ({ key, result: results[i] }))
    .filter(({ result }) => result.status === "carries");
  const verdict =
    carrying.length >= 3 && carrying.some(({ key }) => key === "values")
      ? "carries"
      : "thin";
  const sinces = carrying
    .map(({ result }) => result.since)
    .filter((d): d is string => d !== null)
    .sort();
  return { verdict, since: sinces[0] ?? null, lanes };
}
