/**
 * The phone chronicle, as data (v1.42, #613).
 *
 * Below 768 px the timeline is not squeezed: it becomes a list, newest first,
 * grouped by month (or by year), which is also the list form of the chart for
 * a screen reader. What runs for years without a start that matters (a
 * chronic condition, a standing medication, an allergy) sits once in the
 * "Ongoing" block above the list instead of repeating in every month. What
 * runs for a while and ends (an episode, a winter course) is drawn as a thin
 * rail beside the rows it spans.
 *
 * Empty stretches are said out loud: "No entries from April to August
 * 2025" rather than months silently skipped, so a gap reads as a gap and not
 * as a list that forgot something. The chronicle lists events, not
 * readings or intakes, so "empty" means empty: a month without an event
 * but with values keeps its header (the month's means ride on it), and a
 * month in which a medication was taken is passed over without a line,
 * because "no entries" would read as nothing having happened while the
 * intakes say otherwise. Only a month with none of the three is a gap.
 *
 * A medication is listed once per thing that happened to it
 * (`medicationListItems`): its start with the dose taken then, each later
 * dose change, each pause and its end, and its end. A course and the
 * medication it belongs to never both start on the same row.
 */
import type {
  DayNotableKind,
  TimelineItem,
  TimelineLane,
  TimelineLaneKey,
  TimelineResponse,
} from "@/lib/day/contract";

import {
  addMonths,
  bucketAfter,
  dayNumber,
  endOfMonth,
  monthsBetween,
  startOfMonth,
} from "./timeline-dates";
import {
  groupKey,
  medicationGroups,
  medicationListItems,
} from "./medication-rows";
import { LANE_ORDER, isSpan } from "./timeline-geometry";

export type ChronicleGrouping = "month" | "year";

/** One line in the chronicle. */
export type ChronicleEntry =
  | {
      kind: "item";
      date: string;
      lane: TimelineLaneKey;
      item: TimelineItem;
      /** A point, the start of a period, or its end. */
      role: "point" | "start" | "end";
      /** Length of a closed period in days, on its end line. */
      days: number | null;
    }
  | { kind: "notable"; date: string; notable: DayNotableKind };

/** Lanes whose closed periods are drawn as rails. */
export const RAIL_LANES = ["illness", "medications"] as const;
export type RailLane = (typeof RAIL_LANES)[number];

/**
 * How a rail passes a row. The list runs newest first, so a period's end is
 * the upper of its two rows: on the end row the rail runs from the middle
 * down (`end`), on the start row from the top to the middle (`start`).
 */
export type RailMode = "full" | "start" | "end" | "point";

export type ChronicleRails = Partial<Record<RailLane, RailMode>>;

export type ChronicleRow =
  | { type: "header"; group: string; rails: ChronicleRails }
  | { type: "entry"; entry: ChronicleEntry; rails: ChronicleRails }
  | { type: "gap"; from: string; to: string; rails: ChronicleRails };

export interface StandingChip {
  lane: TimelineLaneKey;
  id: string;
  label: string;
  /** More than one of the lane, folded into one chip ("2 allergies"). */
  count: number;
}

/** A lane's items as a list shows them: a medication's once per event. */
function listItems(lane: TimelineLane): readonly TimelineItem[] {
  return lane.key === "medications"
    ? medicationListItems(lane.items)
    : lane.items;
}

/** The group a date belongs to: `YYYY-MM-01` or `YYYY-01-01`. */
export function groupOf(date: string, grouping: ChronicleGrouping): string {
  return grouping === "month"
    ? startOfMonth(date)
    : `${date.slice(0, 4)}-01-01`;
}

function groupEnd(group: string, grouping: ChronicleGrouping): string {
  return grouping === "month"
    ? endOfMonth(group)
    : `${group.slice(0, 4)}-12-31`;
}

function groupsBetween(
  from: string,
  to: string,
  grouping: ChronicleGrouping,
): string[] {
  if (grouping === "month") return monthsBetween(from, to).reverse();
  const out: string[] = [];
  for (let y = Number(to.slice(0, 4)); y >= Number(from.slice(0, 4)); y--) {
    out.push(`${y}-01-01`);
  }
  return out;
}

/**
 * The Ongoing block: what has no start (`standing`) and every period still
 * open, each period named by `label` (`item-words.ts`, so a running pause
 * reads as paused). A medication is one chip, its running pause before its
 * running course. Allergies fold into one chip when there is more than one.
 */
export function standingChips(
  timeline: Pick<TimelineResponse, "lanes" | "standing">,
  label: (item: TimelineItem) => string,
): StandingChip[] {
  const chips: StandingChip[] = [];
  const allergies: StandingChip[] = [];
  const push = (chip: StandingChip) =>
    chip.lane === "allergies" ? allergies.push(chip) : chips.push(chip);
  for (const s of timeline.standing) {
    push({ lane: s.lane, id: s.id, label: s.label, count: 1 });
  }
  for (const key of LANE_ORDER) {
    if (key === "life" || key === "cycle") continue;
    const lane = timeline.lanes.find((l) => l.key === key);
    const open = (lane?.items ?? []).filter((item) => item.open);
    const shown = new Set<string>();
    // A pause first: a medication on pause reads as paused, not as taken.
    const ordered =
      key === "medications"
        ? [...open].sort(
            (a, b) => Number(b.kind === "pause") - Number(a.kind === "pause"),
          )
        : open;
    for (const item of ordered) {
      const id = key === "medications" ? groupKey(item) : item.id;
      if (shown.has(id)) continue;
      shown.add(id);
      push({ lane: key, id, label: label(item), count: 1 });
    }
  }
  const ordered = chips.sort(
    (a, b) => LANE_ORDER.indexOf(a.lane) - LANE_ORDER.indexOf(b.lane),
  );
  if (allergies.length === 1) ordered.push(allergies[0]);
  if (allergies.length > 1) {
    ordered.push({
      lane: "allergies",
      id: "allergies",
      label: "",
      count: allergies.length,
    });
  }
  return ordered;
}

/** Every dated line, newest first. */
export function chronicleEntries(
  timeline: Pick<TimelineResponse, "lanes" | "notable">,
  today: string,
): ChronicleEntry[] {
  const out: ChronicleEntry[] = [];
  for (const lane of timeline.lanes) {
    for (const item of listItems(lane)) {
      if (!isSpan(item)) {
        out.push({
          kind: "item",
          date: item.start,
          lane: lane.key,
          item,
          role: "point",
          days: null,
        });
        continue;
      }
      out.push({
        kind: "item",
        date: item.start,
        lane: lane.key,
        item,
        role: "start",
        days: null,
      });
      if (!item.open && item.end && item.end <= today) {
        out.push({
          kind: "item",
          date: item.end,
          lane: lane.key,
          item,
          role: "end",
          days: dayNumber(item.end) - dayNumber(item.start) + 1,
        });
      }
    }
  }
  // One line per kind of notable on a day: two metrics seen for the first
  // time on one day are one "First value" line, not two identical ones.
  const notables = new Set<string>();
  for (const n of timeline.notable) {
    const key = `${n.date}:${n.kind}`;
    if (notables.has(key)) continue;
    notables.add(key);
    out.push({ kind: "notable", date: n.date, notable: n.kind });
  }
  const laneRank = (e: ChronicleEntry) =>
    e.kind === "item" ? LANE_ORDER.indexOf(e.lane) : LANE_ORDER.length;
  return out
    .filter((e) => e.date <= today)
    .sort((a, b) =>
      a.date !== b.date
        ? a.date < b.date
          ? 1
          : -1
        : laneRank(a) - laneRank(b),
    );
}

/** Closed periods of the rail lanes. */
function railSpans(lanes: readonly TimelineLane[]) {
  const out: Array<{ lane: RailLane; start: string; end: string }> = [];
  for (const lane of lanes) {
    if (!(RAIL_LANES as readonly string[]).includes(lane.key)) continue;
    for (const item of listItems(lane)) {
      if (item.open || !item.end || item.end === item.start) continue;
      out.push({
        lane: lane.key as RailLane,
        start: item.start,
        end: item.end,
      });
    }
  }
  return out;
}

/** How every rail passes a row dated `date`. */
export function railsAt(
  spans: ReturnType<typeof railSpans>,
  date: string,
): ChronicleRails {
  const rails: ChronicleRails = {};
  for (const lane of RAIL_LANES) {
    let upper = false;
    let lower = false;
    for (const s of spans) {
      if (s.lane !== lane || date < s.start || date > s.end) continue;
      // The period continues to newer rows (above) unless it ends here, and
      // to older rows (below) unless it starts here.
      if (date < s.end) upper = true;
      if (date > s.start) lower = true;
    }
    const touches = spans.some(
      (s) => s.lane === lane && date >= s.start && date <= s.end,
    );
    if (!touches) continue;
    rails[lane] =
      upper && lower ? "full" : upper ? "start" : lower ? "end" : "point";
  }
  return rails;
}

/**
 * An entry of a rail lane always shows its own lane's colour beside it: a
 * dot on its lane's rail when no period of that lane passes the row. Without
 * it a medication listed inside an illness carried only the illness's rail,
 * and read as the illness's colour.
 */
function ownRail(rails: ChronicleRails, entry: ChronicleEntry): ChronicleRails {
  if (entry.kind !== "item") return rails;
  const lane = entry.lane as RailLane;
  if (!(RAIL_LANES as readonly string[]).includes(lane) || rails[lane]) {
    return rails;
  }
  return { ...rails, [lane]: "point" };
}

/**
 * The rows: a header per group, its entries, and one gap row for every run
 * of groups without an entry. Groups run from `today`'s back to the oldest
 * entry, or to `dataFrom` when the record reaches further.
 */
export function buildChronicle(
  timeline: Pick<
    TimelineResponse,
    "lanes" | "notable" | "range" | "series" | "bucket"
  >,
  today: string,
  grouping: ChronicleGrouping,
): ChronicleRow[] {
  const entries = chronicleEntries(timeline, today);
  const groupAfter = (group: string) =>
    grouping === "month" ? addMonths(group, 1) : addMonths(group, 12);
  /** A value line has a reading in the group (its bucket overlaps it). */
  const valued = (group: string) =>
    timeline.series.some((s) =>
      s.points.some(
        (p) =>
          p.count > 0 &&
          p.t < groupAfter(group) &&
          bucketAfter(p.t, timeline.bucket) > group,
      ),
    );
  /**
   * A medication was taken through the group (its intakes are not on the
   * timeline, its stretch is). A paused stretch does not count.
   */
  const medications = timeline.lanes.find((l) => l.key === "medications");
  const taken = medications
    ? medicationGroups(medications.items).flatMap((g) => g.periods)
    : [];
  const running = (group: string) => {
    const end = groupEnd(group, grouping);
    return taken.some(
      (item) =>
        item.start <= end &&
        (item.open ? today : (item.end ?? item.start)) >= group,
    );
  };
  const spans = railSpans(timeline.lanes);
  const oldest = [
    entries.at(-1)?.date,
    timeline.range.dataFrom ?? undefined,
  ].filter((d): d is string => !!d && d <= today);
  if (oldest.length === 0) return [];
  const first = oldest.sort()[0];

  const byGroup = new Map<string, ChronicleEntry[]>();
  for (const e of entries) {
    const g = groupOf(e.date, grouping);
    const list = byGroup.get(g);
    if (list) list.push(e);
    else byGroup.set(g, [e]);
  }

  const rows: ChronicleRow[] = [];
  let gapFrom: string | null = null;
  let gapTo: string | null = null;
  const flushGap = () => {
    if (gapFrom && gapTo) {
      // A period that spans the whole empty stretch keeps its rail through it.
      const from = gapFrom;
      const to = groupEnd(gapTo, grouping);
      const rails: ChronicleRails = {};
      for (const lane of RAIL_LANES) {
        if (
          spans.some((s) => s.lane === lane && s.start < from && s.end > to)
        ) {
          rails[lane] = "full";
        }
      }
      rows.push({ type: "gap", from: gapFrom, to: gapTo, rails });
    }
    gapFrom = gapTo = null;
  };
  for (const group of groupsBetween(first, today, grouping)) {
    const list = byGroup.get(group);
    if (!list) {
      if (valued(group)) {
        // No event, but readings: the header carries the month's means.
        flushGap();
        const end = groupEnd(group, grouping);
        rows.push({
          type: "header",
          group,
          rails: railsAt(spans, end < today ? end : today),
        });
        continue;
      }
      if (running(group)) {
        // Something was under way: not empty, and nothing to list either.
        flushGap();
        continue;
      }
      // Groups run newest first: the first empty one is the gap's newest end.
      gapTo = gapTo ?? group;
      gapFrom = group;
      continue;
    }
    flushGap();
    const end = groupEnd(group, grouping);
    rows.push({
      type: "header",
      group,
      rails: railsAt(spans, end < today ? end : today),
    });
    for (const entry of list) {
      rows.push({
        type: "entry",
        entry,
        rails: ownRail(railsAt(spans, entry.date), entry),
      });
    }
  }
  flushGap();
  return rows;
}
