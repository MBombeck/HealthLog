/**
 * Where the context marks (`GET /api/insights/context`) land on a drawn
 * chart. Pure: the chart's points in, positions on its point-index x axis
 * out.
 *
 * Every mark is a local calendar day, and every drawn point stands for one
 * (a daily point sits at noon UTC of its day, a week or month point at UTC
 * midnight of its first day), so both sides reduce to whole UTC day numbers
 * and the placement is arithmetic on calendar days: no zone, no DST hour can
 * move a mark to a neighbouring day.
 *
 * Between two points a day is placed in proportion, so a dose change on a
 * day without a reading still stands between the readings around it. A
 * point mark outside the drawn days is left out; a span that reaches past
 * them is cut at the edge.
 */
import type { ChartBucketType } from "@/lib/charts/bucket-time-series";
import type {
  ChartContextCyclePhase,
  ChartContextIllnessSpan,
  ChartContextMedicationMark,
  ChartContextResponse,
} from "@/lib/charts/context-markers-contract";
import { dateOnlyAtNoonUtc } from "@/lib/tz/date-only";

const DAY_MS = 86_400_000;

/**
 * How many days after its point the last drawn point still covers: half a
 * day for a day, the rest of the week or month for a bucket.
 */
const TAIL_DAYS: Readonly<Record<ChartBucketType, number>> = {
  day: 0.5,
  week: 6.5,
  month: 30.5,
};

/** Every mark at one spot on the x axis: one button, one line each. */
export type ContextMarkEntry =
  | { kind: "medication"; mark: ChartContextMedicationMark }
  | { kind: "illness"; span: ChartContextIllnessSpan };

export interface ResolvedContextMarks {
  /** A dashed line per medication change. */
  lines: number[];
  /** A wash per illness episode. */
  areas: Array<{ x1: number; x2: number }>;
  /** The cycle phases, when asked for and drawn in days. */
  phases: Array<{ x1: number; x2: number; phase: ChartContextCyclePhase }>;
  /**
   * The marks a person can open, grouped where they would sit closer than
   * a fingertip apart, in x order.
   */
  groups: Array<{ x: number; entries: ContextMarkEntry[] }>;
  /** Whether the record has cycle phases in this window at all (the switch). */
  hasCycle: boolean;
}

/** A day key as its whole UTC day number, the way a drawn point is read. */
function dayNumber(key: string): number {
  return Math.floor(dateOnlyAtNoonUtc(key).getTime() / DAY_MS);
}

/**
 * The x of a (fractional) day number on the point axis, or null outside
 * the drawn days. `clamp` holds an outside day at the nearer edge instead.
 */
function makePlacer(points: readonly { timestamp: number }[], tail: number) {
  const days = points.map((p) => Math.floor(p.timestamp / DAY_MS));
  const first = days[0];
  const last = days[days.length - 1];
  const place = (day: number, clamp = false): number | null => {
    if (!clamp && (day < first - 0.5 || day > last + tail)) return null;
    if (day <= first) return 0;
    if (day >= last) return days.length - 1;
    let lo = 0;
    let hi = days.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (days[mid] <= day) lo = mid;
      else hi = mid;
    }
    return lo + (day - days[lo]) / (days[hi] - days[lo]);
  };
  return { place, first, last };
}

/**
 * The marks of `context` on the chart drawn from `points`, or null when
 * none falls inside it: a chart with nothing around it draws exactly as it
 * did before marks existed.
 *
 * `plotWidth` is the width of the drawn x range in pixels, for grouping
 * marks that would sit on top of each other (`minGapPx` apart at least).
 */
export function resolveContextMarks(
  context: ChartContextResponse | null | undefined,
  points: readonly { timestamp: number }[] | undefined,
  options: {
    bucket: ChartBucketType;
    showCycle: boolean;
    plotWidth: number;
    minGapPx?: number;
  },
): ResolvedContextMarks | null {
  if (!context || !points || points.length < 2) return null;
  const tail = TAIL_DAYS[options.bucket];
  const { place, first, last } = makePlacer(points, tail);
  const today = dayNumber(context.today);
  // A span is drawn when any of its days falls on the drawn ones, cut at
  // their edges.
  const spanOf = (start: string, end: string | null) => {
    const s = dayNumber(start);
    const e = end === null ? today : dayNumber(end);
    if (s > last + tail || e < first - 0.5) return null;
    return {
      x1: place(s - 0.5, true) as number,
      x2: place(e + 0.5, true) as number,
    };
  };

  const lines: number[] = [];
  const anchored: Array<{ x: number; entry: ContextMarkEntry }> = [];
  for (const mark of context.medications) {
    const x = place(dayNumber(mark.date));
    if (x === null) continue;
    lines.push(x);
    anchored.push({ x, entry: { kind: "medication", mark } });
  }
  const areas: ResolvedContextMarks["areas"] = [];
  for (const span of context.illnesses) {
    const area = spanOf(span.start, span.end);
    if (!area) continue;
    areas.push(area);
    anchored.push({ x: area.x1, entry: { kind: "illness", span } });
  }
  const phases: ResolvedContextMarks["phases"] = [];
  let hasCycle = false;
  if (options.bucket === "day") {
    for (const p of context.cyclePhases) {
      const area = spanOf(p.start, p.end);
      if (!area) continue;
      hasCycle = true;
      if (options.showCycle) phases.push({ ...area, phase: p.phase });
    }
  }
  if (anchored.length === 0 && !hasCycle) return null;

  const span = points.length - 1;
  const minGap =
    ((options.minGapPx ?? 24) / Math.max(options.plotWidth, 1)) * span;
  anchored.sort((a, b) => a.x - b.x);
  const groups: ResolvedContextMarks["groups"] = [];
  for (const { x, entry } of anchored) {
    const open = groups[groups.length - 1];
    if (open && x - open.x < minGap) {
      open.entries.push(entry);
      continue;
    }
    groups.push({ x, entries: [entry] });
  }
  return { lines, areas, phases, groups, hasCycle };
}
