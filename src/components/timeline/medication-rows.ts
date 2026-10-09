/**
 * One medication, one row (v1.42, #613).
 *
 * The server reads a medication from four tables and sends what each holds:
 * the medication's own start and end, its courses, its dose changes and its
 * pauses, every one of them tagged with the medication's id as `group`.
 * Drawn item by item, a medication with a course read as two medications
 * ("Mounjaro 7.5 mg" above "Mounjaro"), and a dose change as a third thing
 * beside them. Here the items of one medication become one thing again:
 *
 *   - the stretches it was taken are its courses, or its own span when it
 *     has none (the span of a medication with courses covers the gaps
 *     between them, when it was not taken);
 *   - each dose change cuts the stretch it falls into, and every piece
 *     carries the dose in effect, so the bar reads "2.5 mg", then "5 mg";
 *   - a pause is a gap in the same bar.
 *
 * The chart, the selection bar, the phone chronicle and the screen-reader
 * table all read a medication through here, so they agree on what it is.
 */
import type { TimelineItem } from "@/lib/day/contract";

import { dayKey, dayNumber } from "./timeline-dates";

/** What every item of one medication says together. */
export interface MedicationGroup {
  key: string;
  /** The medication's name. */
  label: string;
  href: string | null;
  /** The stretches it was taken, oldest first: its courses, or its span. */
  periods: TimelineItem[];
  /** Taken once (a one-time medication): a point, not a stretch. */
  points: TimelineItem[];
  pauses: TimelineItem[];
  /** Dose changes, oldest first. */
  doses: TimelineItem[];
  /** The medication's own item, when it was sent. */
  medication: TimelineItem | null;
}

/** The group an item belongs to; an item without one stands alone. */
export function groupKey(item: TimelineItem): string {
  return item.group ?? item.id;
}

const byStart = (a: TimelineItem, b: TimelineItem) =>
  a.start < b.start ? -1 : a.start > b.start ? 1 : 0;

/** A span is anything with an end or still open; the rest are points. */
function spans(item: TimelineItem): boolean {
  return item.open || (item.end !== null && item.end !== item.start);
}

/**
 * The medication's own span as a stretch, where its courses do not say when
 * it was taken: all of it when it has no course, and the time since its last
 * course ended when it is still taken but no course is open. Without that
 * second arm an active medication whose courses all lay in the past had no
 * stretch in the current window and dropped out of the chart, while the day
 * view, which reads the medication itself, listed it as running.
 */
function ownStretch(
  medication: TimelineItem | null,
  courses: readonly TimelineItem[],
): TimelineItem[] {
  if (!medication) return [];
  if (courses.length === 0) return [medication];
  if (!medication.open || courses.some((c) => c.open)) return [];
  const lastEnd = courses
    .map((c) => c.end ?? c.start)
    .sort()
    .at(-1)!;
  const start = dayKey(dayNumber(lastEnd) + 1);
  if (start <= medication.start) return [medication];
  return [{ ...medication, id: `${medication.id}:since`, start }];
}

/** The medications lane's items, one group per medication, oldest first. */
export function medicationGroups(
  items: readonly TimelineItem[],
): MedicationGroup[] {
  const byKey = new Map<string, TimelineItem[]>();
  for (const item of items) {
    const key = groupKey(item);
    const list = byKey.get(key);
    if (list) list.push(item);
    else byKey.set(key, [item]);
  }
  const groups: MedicationGroup[] = [];
  for (const [key, list] of byKey) {
    const medication = list.find((i) => i.kind === "medication") ?? null;
    const courses = list.filter((i) => i.kind === "course").sort(byStart);
    const stretches = [...courses, ...ownStretch(medication, courses)];
    groups.push({
      key,
      label: medication?.label ?? list[0].label,
      href: medication?.href ?? list[0].href,
      periods: stretches.filter(spans).sort(byStart),
      points: stretches.filter((i) => !spans(i)).sort(byStart),
      pauses: list.filter((i) => i.kind === "pause").sort(byStart),
      doses: list.filter((i) => i.kind === "doseChange").sort(byStart),
      medication,
    });
  }
  const first = (g: MedicationGroup) =>
    [...g.periods, ...g.points, ...g.pauses, ...g.doses]
      .map((i) => i.start)
      .sort()[0] ?? "";
  return groups.sort((a, b) =>
    first(a) < first(b) ? -1 : first(a) > first(b) ? 1 : 0,
  );
}

/**
 * The dose in effect on `day`: the last dose change on or before it. With
 * no dose change at all, the medication's own dose; before the first one,
 * nothing, because what was taken then is not recorded.
 */
export function doseAt(group: MedicationGroup, day: string): string | null {
  if (group.doses.length === 0) return group.medication?.sub ?? null;
  let dose: string | null = null;
  for (const change of group.doses) {
    if (change.start > day) break;
    dose = change.sub;
  }
  return dose;
}

/** One piece of a stretch: the days one dose was taken. */
export interface DoseSegment {
  start: string;
  /** Last day, inclusive; null while the stretch is open. */
  end: string | null;
  dose: string | null;
  /** The dose change the piece begins with, or null for the first piece. */
  change: TimelineItem | null;
  first: boolean;
  last: boolean;
}

/** A stretch cut at every dose change that falls inside it. */
export function doseSegments(
  group: MedicationGroup,
  period: TimelineItem,
): DoseSegment[] {
  const end = period.open ? null : (period.end ?? period.start);
  const cuts = group.doses.filter(
    (d) => d.start > period.start && (end === null || d.start <= end),
  );
  const out: DoseSegment[] = [];
  let start = period.start;
  let change: TimelineItem | null = null;
  for (const cut of cuts) {
    if (cut.start === start) {
      change = cut;
      continue;
    }
    out.push({
      start,
      end: dayKey(dayNumber(cut.start) - 1),
      dose: change ? change.sub : doseAt(group, start),
      change,
      first: false,
      last: false,
    });
    start = cut.start;
    change = cut;
  }
  out.push({
    start,
    end,
    dose: change ? change.sub : doseAt(group, start),
    change,
    first: false,
    last: false,
  });
  out[0].first = true;
  out[out.length - 1].last = true;
  return out;
}

/** Dose changes that fall into no stretch: drawn as a mark of their own. */
export function strayDoses(group: MedicationGroup): TimelineItem[] {
  return group.doses.filter(
    (d) =>
      !group.periods.some(
        (p) => d.start >= p.start && (p.open || d.start <= (p.end ?? p.start)),
      ),
  );
}

/**
 * The medications lane as the phone chronicle and the screen-reader table
 * list it: one medication's start and end once (from its courses when it has
 * any), each with the dose taken then, and a dose change that falls on a
 * start folded into that start rather than listed beside it.
 */
export function medicationListItems(
  items: readonly TimelineItem[],
): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const group of medicationGroups(items)) {
    const starts = new Set(
      [...group.periods, ...group.points].map((p) => p.start),
    );
    for (const p of [...group.periods, ...group.points]) {
      out.push({ ...p, label: group.label, sub: doseAt(group, p.start) });
    }
    out.push(...group.pauses);
    out.push(...group.doses.filter((d) => !starts.has(d.start)));
  }
  return out.sort(byStart);
}

/**
 * One medication in the selection bar for the period `[from, to]`, or null
 * when nothing of it happens there. The entry is one item, in the shapes
 * the bar already words: a pause in the period names it as paused; else a
 * dose change in the period names the new dose from its day; else the
 * stretch that touches the period, with the dose taken at its end. A
 * stretch open since before the period is its backdrop and left out, as
 * every other lane leaves it.
 */
export function medicationPeriodItem(
  group: MedicationGroup,
  from: string,
  to: string,
  today: string,
): TimelineItem | null {
  const touches = (item: TimelineItem) => {
    const end = item.open ? today : (item.end ?? item.start);
    return item.start <= to && end >= from;
  };
  const pause = group.pauses.filter(touches).at(-1);
  if (pause) return { ...pause, id: group.key, label: group.label };
  const stretches = [...group.periods, ...group.points]
    .filter(touches)
    .sort(byStart);
  const change = group.doses
    .filter((d) => d.start >= from && d.start <= to)
    .at(-1);
  const base = {
    id: group.key,
    kind: "medication" as const,
    label: group.label,
    href: group.href,
    group: group.key,
    precision: "DAY" as const,
  };
  if (change) {
    const host = stretches.find(
      (s) =>
        s.start <= change.start &&
        (s.open || (s.end ?? s.start) >= change.start),
    );
    return {
      ...base,
      start: change.start,
      end: host ? host.end : null,
      open: host ? host.open : false,
      startKnown: true,
      sub: change.sub,
    };
  }
  const last = stretches.at(-1);
  if (!last) return null;
  if (last.open && last.start < from) return null;
  const end = last.open ? today : (last.end ?? last.start);
  return {
    ...base,
    start: last.start,
    end: last.end,
    open: last.open,
    startKnown: last.startKnown,
    precision: last.precision,
    sub: doseAt(group, end < to ? end : to),
  };
}
