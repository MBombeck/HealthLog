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

function regular(
  weeks: number,
  total: number,
  since: string | null,
  gap: { key: string; href: string } | null,
): LaneResult {
  const status =
    weeks * 2 >= READINESS_WEEKS ? "carries" : total > 0 ? "thin" : "empty";
  return lane(status, total, status === "carries" ? since : null, {
    detail: { key: "weeks", params: { weeks, of: READINESS_WEEKS } },
    gaps: status === "carries" || gap === null ? [] : [{ ...gap, count: 0 }],
  });
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
  if (types.length === 0) return lane("empty", 0, null);
  const [days, first] = await Promise.all([
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
  ]);
  return regular(
    coveredWeeks(days, frame.today),
    days.size,
    first ? userDayKey(first.measuredAt, frame.tz) : null,
    { key: "connectSources", href: "/settings/sources" },
  );
}

async function moodLane(frame: Frame) {
  const first = shiftDateKey(frame.today, -7 * READINESS_WEEKS + 1);
  const [rows, earliest] = await Promise.all([
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
  ]);
  return regular(
    coveredWeeks(
      rows.map((r) => r.date),
      frame.today,
    ),
    rows.length,
    earliest?.date ?? null,
    { key: "logMood", href: "/mood" },
  );
}

async function cycleLane(frame: Frame) {
  const first = shiftDateKey(frame.today, -7 * READINESS_WEEKS + 1);
  const [rows, earliest] = await Promise.all([
    prisma.cycleDayLog.findMany({
      where: { userId: frame.userId, deletedAt: null, date: { gte: first } },
      select: { date: true },
    }),
    prisma.menstrualCycle.findFirst({
      where: { userId: frame.userId, deletedAt: null, isPredicted: false },
      orderBy: { startDate: "asc" },
      select: { startDate: true },
    }),
  ]);
  return regular(
    coveredWeeks(
      rows.map((r) => r.date),
      frame.today,
    ),
    rows.length,
    earliest?.startDate ?? null,
    { key: "logCycle", href: "/cycle" },
  );
}

async function environmentLane(frame: Frame) {
  const first = shiftDateKey(frame.today, -7 * READINESS_WEEKS + 1);
  const [rows, earliest] = await Promise.all([
    prisma.environmentContext.findMany({
      where: { userId: frame.userId, date: { gte: first } },
      select: { date: true },
    }),
    prisma.environmentContext.findFirst({
      where: { userId: frame.userId },
      orderBy: { date: "asc" },
      select: { date: true },
    }),
  ]);
  return regular(
    coveredWeeks(
      rows.map((r) => r.date),
      frame.today,
    ),
    rows.length,
    earliest?.date ?? null,
    { key: "setHome", href: "/settings/environment" },
  );
}

async function illnessLane(frame: Frame) {
  const [count, first] = await Promise.all([
    prisma.illnessEpisode.count({
      where: { userId: frame.userId, deletedAt: null },
    }),
    prisma.illnessEpisode.findFirst({
      where: { userId: frame.userId, deletedAt: null },
      orderBy: { onsetAt: "asc" },
      select: { onsetAt: true },
    }),
  ]);
  return count > 0
    ? lane("carries", count, first ? userDayKey(first.onsetAt, frame.tz) : null)
    : lane("empty", 0, null, {
        gaps: [{ key: "addEpisode", count: 0, href: "/illness" }],
      });
}

async function allergiesLane(frame: Frame) {
  const rows = await prisma.allergy.findMany({
    where: { userId: frame.userId, deletedAt: null },
    select: { onsetAt: true },
  });
  const dated = rows.filter((r) => r.onsetAt !== null);
  if (dated.length > 0) {
    const since = dated
      .map((r) => userDayKey(r.onsetAt as Date, frame.tz))
      .sort()[0];
    return lane("carries", rows.length, since);
  }
  // Undated allergies are standing items, not a shortcoming: no gap.
  return lane(rows.length > 0 ? "thin" : "empty", rows.length, null);
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
    return lane("empty", 0, null, {
      gaps: [{ key: "addMedication", count: 0, href: "/medications/new" }],
    });
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
  if (missing.length === 0) return lane("carries", meds.length, since);
  return lane("thin", meds.length, null, {
    detail: {
      key: "startMissing",
      params: { missing: missing.length, total: meds.length },
    },
    gaps: [
      {
        key: "medicationStartMissing",
        count: missing.length,
        href: `/medications/${missing[0]}?edit=1`,
      },
    ],
  });
}

async function vaccinationsLane(frame: Frame) {
  const first = await prisma.vaccinationRecord.findFirst({
    where: { userId: frame.userId, deletedAt: null },
    orderBy: { occurredAt: "asc" },
    select: { occurredAt: true },
  });
  if (!first) {
    return lane("empty", 0, null, {
      gaps: [{ key: "addVaccination", count: 0, href: "/vaccinations" }],
    });
  }
  const count = await prisma.vaccinationRecord.count({
    where: { userId: frame.userId, deletedAt: null },
  });
  return lane("carries", count, userDayKey(first.occurredAt, frame.tz));
}

async function visitsLane(frame: Frame) {
  const [done, planned, first] = await Promise.all([
    prisma.encounter.count({
      where: { userId: frame.userId, deletedAt: null, status: "DONE" },
    }),
    prisma.encounter.count({
      where: { userId: frame.userId, deletedAt: null, status: "PLANNED" },
    }),
    prisma.encounter.findFirst({
      where: { userId: frame.userId, deletedAt: null, status: "DONE" },
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true },
    }),
  ]);
  if (done > 0) {
    return lane(
      "carries",
      done,
      first ? userDayKey(first.occurredAt, frame.tz) : null,
    );
  }
  return lane(planned > 0 ? "thin" : "empty", planned, null, {
    ...(planned > 0
      ? { detail: { key: "plannedOnly", params: { planned } } }
      : {}),
    gaps: [{ key: "addVisit", count: 0, href: "/checkups" }],
  });
}

async function labsLane(frame: Frame) {
  const first = await prisma.labResult.findFirst({
    where: { userId: frame.userId, deletedAt: null },
    orderBy: { takenAt: "asc" },
    select: { takenAt: true },
  });
  if (!first) {
    return lane("empty", 0, null, {
      gaps: [{ key: "addLabs", count: 0, href: "/labs" }],
    });
  }
  const count = await prisma.labResult.count({
    where: { userId: frame.userId, deletedAt: null },
  });
  return lane("carries", count, userDayKey(first.takenAt, frame.tz));
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
    undated > 0
      ? [{ key: "undatedDocuments", count: undated, href: "/documents" }]
      : [];
  if (dated.length > 0) {
    const since = dated
      .map((d) => dateOnlyKey((d.reportDate ?? d.documentDate) as Date))
      .sort()[0];
    return lane("carries", dated.length, since, { gaps });
  }
  return lane(undated > 0 ? "thin" : "empty", undated, null, {
    gaps:
      undated > 0
        ? gaps
        : [{ key: "addDocument", count: 0, href: "/documents" }],
  });
}

async function lifeLane(frame: Frame) {
  const [count, first] = await Promise.all([
    prisma.lifeEvent.count({
      where: { userId: frame.userId, deletedAt: null },
    }),
    prisma.lifeEvent.findFirst({
      where: { userId: frame.userId, deletedAt: null },
      orderBy: { startDate: "asc" },
      select: { startDate: true },
    }),
  ]);
  return count > 0
    ? lane("carries", count, first?.startDate ?? null)
    : lane("empty", 0, null, {
        gaps: [
          { key: "addLifeEvent", count: 0, href: "/timeline?add=lifeEvent" },
        ],
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
