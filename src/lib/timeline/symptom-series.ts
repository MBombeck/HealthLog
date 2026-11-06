/**
 * Person-defined symptoms as lines on the timeline (#981).
 *
 * A symptom is logged as occurrences, each with an intensity from 0 to 10.
 * A day's value is the highest intensity logged on it: three entries of a
 * headache on one afternoon are one bad day, not three. The day is the
 * record's local day of `occurredAt`, the same cut the day view and every
 * lane make, so a point opens the days that list it.
 *
 * The line follows the zoom's bucket, as a measurement line does: a point is
 * the mean of the bucket's day values over the days the symptom was logged,
 * and carries how many days that was, so the chart can mark a mean resting
 * on one or two days. A day without an entry is not a zero: absence says
 * nothing was written down, not that nothing was felt. A bucket without an
 * entry is not sent.
 *
 * Symptoms ride the illness module and the `illness` sharing domain, as the
 * symptom routes, the day view's `symptoms` section and the illness lane do,
 * so the lines and the list of symptoms are read under the illness lane's
 * gate (`laneVisible("illness", ...)`). Labels are decrypted here and never
 * logged.
 */
import {
  TIMELINE_SYMPTOM_SCALE,
  timelineSymptomKey,
  type TimelineBucket,
  type TimelineSymptomOption,
  type TimelineSymptomPoint,
  type TimelineSymptomSeries,
} from "@/lib/day/contract";
import type { DayCell } from "@/lib/day/daily-stats";
import { prisma } from "@/lib/db";
import { decryptSymptomText } from "@/lib/symptoms/server";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { startOfLocalDayKey } from "@/lib/tz/local-day";

import { laneVisible, type TimelineAccess } from "./lanes";
import { foldDays } from "./series";

/** One logged occurrence, as the fold reads it. */
export interface SymptomOccurrence {
  occurredAt: Date;
  intensity: number;
}

/**
 * The peak intensity of every local day in `[from, to]` that has an entry.
 * Occurrences outside the window are left out.
 */
export function symptomDayPeaks(
  rows: readonly SymptomOccurrence[],
  window: { from: string; to: string; tz: string },
): Map<string, number> {
  const peaks = new Map<string, number>();
  for (const row of rows) {
    const day = userDayKey(row.occurredAt, window.tz);
    if (day < window.from || day > window.to) continue;
    const prev = peaks.get(day);
    if (prev === undefined || row.intensity > prev)
      peaks.set(day, row.intensity);
  }
  return peaks;
}

/**
 * A symptom's points over `[from, to]` in `bucket`: the mean of each
 * bucket's day peaks over its logged days, and the number of those days.
 */
export function foldSymptomSeries(
  rows: readonly SymptomOccurrence[],
  window: { from: string; to: string; tz: string },
  bucket: TimelineBucket,
): TimelineSymptomPoint[] {
  const days = new Map<string, DayCell>();
  for (const [day, peak] of symptomDayPeaks(rows, window)) {
    // Each logged day weighs one, so `count` sums to the logged days.
    days.set(day, { value: peak, count: 1 });
  }
  return foldDays(days, bucket);
}

const DEFINITION_SELECT = {
  id: true,
  labelEncrypted: true,
  icon: true,
  isActive: true,
} as const;

/**
 * The lines of the symptoms `ids` names, in that order, over `[from, to]`.
 * Every read is narrowed to the record: an id of another record's symptom
 * finds nothing and is left out, as is one deleted since it was chosen. A
 * symptom found but not logged in the window keeps its (empty) line, so the
 * page can still name and untick it.
 */
export async function loadSymptomSeries(args: {
  recordId: string;
  ids: readonly string[];
  from: string;
  to: string;
  tz: string;
  bucket: TimelineBucket;
  access: TimelineAccess;
}): Promise<TimelineSymptomSeries[]> {
  const { recordId, ids, from, to, tz, bucket, access } = args;
  if (ids.length === 0 || !laneVisible("illness", access)) return [];
  const definitions = await prisma.symptomDefinition.findMany({
    where: { userId: recordId, id: { in: [...ids] } },
    select: DEFINITION_SELECT,
  });
  if (definitions.length === 0) return [];
  const rows = await prisma.symptomEvent.findMany({
    where: {
      userId: recordId,
      definitionId: { in: definitions.map((d) => d.id) },
      occurredAt: {
        gte: startOfLocalDayKey(from, tz),
        lt: startOfLocalDayKey(shiftDateKey(to, 1), tz),
      },
    },
    select: { definitionId: true, occurredAt: true, intensity: true },
  });
  const byDefinition = new Map<string, SymptomOccurrence[]>();
  for (const row of rows) {
    const list = byDefinition.get(row.definitionId) ?? [];
    list.push(row);
    byDefinition.set(row.definitionId, list);
  }
  const found = new Map(definitions.map((d) => [d.id, d]));
  return ids.flatMap((id) => {
    const definition = found.get(id);
    if (!definition) return [];
    return [
      {
        key: timelineSymptomKey(definition.id),
        definitionId: definition.id,
        label: decryptSymptomText(definition.labelEncrypted, "label"),
        icon: definition.icon,
        isActive: definition.isActive,
        scale: { ...TIMELINE_SYMPTOM_SCALE },
        points: foldSymptomSeries(
          byDefinition.get(id) ?? [],
          { from, to, tz },
          bucket,
        ),
      },
    ];
  });
}

/**
 * The earliest local day any of the symptoms `ids` names was logged, or
 * null. An `all` window reaches back to it, so a chosen symptom logged
 * before anything else in the record is drawn whole.
 */
export async function firstSymptomDay(args: {
  recordId: string;
  ids: readonly string[];
  tz: string;
  access: TimelineAccess;
}): Promise<string | null> {
  const { recordId, ids, tz, access } = args;
  if (ids.length === 0 || !laneVisible("illness", access)) return null;
  const first = await prisma.symptomEvent.findFirst({
    where: { userId: recordId, definitionId: { in: [...ids] } },
    orderBy: { occurredAt: "asc" },
    select: { occurredAt: true },
  });
  return first ? userDayKey(first.occurredAt, tz) : null;
}

/**
 * Every symptom the record has logged at least once, whatever the window,
 * in the record's own order. A hidden symptom is offered too: hiding takes
 * it out of the quick entry, and its history is kept, so it can still be
 * looked at here.
 */
export async function loadAvailableSymptoms(args: {
  recordId: string;
  access: TimelineAccess;
}): Promise<TimelineSymptomOption[]> {
  const { recordId, access } = args;
  if (!laneVisible("illness", access)) return [];
  const definitions = await prisma.symptomDefinition.findMany({
    where: { userId: recordId, events: { some: {} } },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: DEFINITION_SELECT,
  });
  return definitions.map((d) => ({
    key: timelineSymptomKey(d.id),
    definitionId: d.id,
    label: decryptSymptomText(d.labelEncrypted, "label"),
    icon: d.icon,
    isActive: d.isActive,
  }));
}
