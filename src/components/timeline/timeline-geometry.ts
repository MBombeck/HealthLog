/**
 * The timeline's geometry, as pure functions (v1.42, #613).
 *
 * Everything the SVG draws is decided here, from the server's answer, the
 * width the card has and the zoom: the time window, the x-scale, the grid,
 * which row each period sits on, where each label goes and which labels are
 * left out, and the value lines below. The renderer only paints the result,
 * so every rule that matters (no label overlaps another label or a bar, no
 * label runs past the card edge, a span with an unknown start says so) is
 * provable without a browser.
 *
 * Text is never measured in the DOM. Label widths are estimated from the
 * character count at the label font size, deliberately on the wide side: an
 * estimate that runs short would let two labels touch, one that runs long
 * only leaves a label out a little early. A label that is left out is never
 * lost — the selection bar under the chart names every entry of the selected
 * month in full.
 */
import type {
  TimelineBucket,
  TimelineItem,
  TimelineItemKind,
  TimelineLane,
  TimelineLaneKey,
  TimelineSeries,
  TimelineZoom,
} from "@/lib/day/contract";

import { itemLine, type ItemWordsFn } from "./item-words";
import {
  addMonths,
  bucketAfter,
  bucketIndex,
  dayKey,
  dayNumber,
  endOfMonth,
  monthsBetween,
  startOfMonth,
} from "./timeline-dates";

/* ─── Constants ───────────────────────────────────────────────────────────── */

/** Height of the axis strip above the first lane. */
export const AXIS_HEIGHT = 26;
/** Centre of the first row below a lane's top edge. */
export const LANE_PAD_TOP = 16;
/** Distance between two row centres in one lane. */
export const ROW_HEIGHT = 22;
/** Last row centre to the lane's bottom edge. */
export const LANE_PAD_BOTTOM = 18;
/** Gap between the last lane and the first value line. */
export const SERIES_GAP = 18;
/** Height of one value line, label included. */
export const SERIES_HEIGHT = 60;
/** Label font size in the lanes, px. */
export const LABEL_FONT_PX = 11;
/** Estimated advance of one label character at 11 px, on the wide side. */
export const LABEL_CHAR_PX = 6.1;
/** Horizontal room a label keeps from anything beside it. */
export const LABEL_MARGIN = 6;
/** Two bars on one row keep at least this much air between them. */
export const BAR_GAP = 6;
/** Width of the dashed lead-in before a span whose start is unknown. */
export const UNKNOWN_START_LEAD = 28;
/** A click within this many px of a mark selects the mark's date. */
export const HIT_SLOP = 8;

/** Margin of a label set beside the mark it names. */
const BESIDE_MARGIN = 4;

/** Half the drawn width of each point glyph, for the occupancy map. */
const GLYPH_HALF_WIDTH: Record<PointShape, number> = {
  dot: 4,
  diamond: 7,
  square: 4.5,
  tick: 1,
  ring: 4,
  doseMark: 1,
};

/** Lane order, top to bottom: the contract's order. */
export const LANE_ORDER: readonly TimelineLaneKey[] = [
  "life",
  "illness",
  "allergies",
  "medications",
  "vaccinations",
  "visits",
  "labs",
  "documents",
  "cycle",
];

/**
 * One colour per lane, as tokens. Never the only signal: every lane has its
 * name and icon at the left, and every kind its own shape.
 */
export const LANE_COLOR: Readonly<Record<TimelineLaneKey, string>> = {
  life: "var(--foreground)",
  illness: "var(--chart-5)",
  allergies: "var(--chart-3)",
  medications: "var(--chart-1)",
  vaccinations: "var(--chart-2)",
  visits: "var(--chart-4)",
  labs: "var(--chart-4)",
  documents: "var(--muted-foreground)",
  cycle: "var(--chart-3)",
};

/* ─── Window and scale ────────────────────────────────────────────────────── */

/** An inclusive range of calendar dates. */
export interface TimeWindow {
  from: string;
  to: string;
}

/**
 * The window a zoom shows.
 *
 * `all` follows the server's range (it knows where the record begins); the
 * fallback before an answer is the current and the previous year. `year` and
 * `quarter` are 12 and 3 whole months that keep `anchor` (the selected day)
 * in view, end no later than the month of `today`, and so never open onto an
 * empty future. `range` is exactly the chosen stretch (`serverRange`).
 */
export function windowFor(
  zoom: TimelineZoom,
  today: string,
  anchor: string | null,
  serverRange?: { from: string; to: string } | null,
): TimeWindow {
  if (zoom === "all" || zoom === "range") {
    if (serverRange) return { from: serverRange.from, to: serverRange.to };
    const year = Number(today.slice(0, 4));
    return { from: `${year - 1}-01-01`, to: `${year}-12-31` };
  }
  const months = zoom === "year" ? 12 : 3;
  const ahead = zoom === "year" ? 5 : 1;
  const base = anchor && anchor <= today ? anchor : today;
  const lastMonth = startOfMonth(addMonths(startOfMonth(base), ahead));
  const capped =
    lastMonth > startOfMonth(today) ? startOfMonth(today) : lastMonth;
  return {
    from: addMonths(capped, -(months - 1)),
    to: endOfMonth(capped),
  };
}

/**
 * How a window draws its grid and steps its selection: a chosen range
 * borrows the fixed zoom nearest its length (years for two years and more,
 * months from four months, days below), so a range never needs a grid of
 * its own.
 */
export function zoomShape(
  zoom: TimelineZoom,
  window: TimeWindow,
): Exclude<TimelineZoom, "range"> {
  if (zoom !== "range") return zoom;
  const days = dayNumber(window.to) - dayNumber(window.from) + 1;
  if (days >= 2 * 365) return "all";
  if (days >= 120) return "year";
  return "quarter";
}

/** A linear map from calendar days to x, over `[from, to + 1 day)`. */
export interface Scale {
  readonly x0: number;
  readonly x1: number;
  readonly fromDay: number;
  readonly toDay: number;
  /** x of the start of a day (a key or a day number). */
  x: (day: string | number) => number;
  /** x of the middle of a day. */
  xMid: (day: string | number) => number;
  /** The day under an x position, clamped into the window. */
  dayAt: (x: number) => string;
}

export function createScale(window: TimeWindow, x0: number, x1: number) {
  const fromDay = dayNumber(window.from);
  const toDay = dayNumber(window.to) + 1;
  const span = Math.max(1, toDay - fromDay);
  const width = Math.max(1, x1 - x0);
  const toNumber = (d: string | number) =>
    typeof d === "number" ? d : dayNumber(d);
  const x = (d: string | number) =>
    x0 + ((toNumber(d) - fromDay) / span) * width;
  return {
    x0,
    x1,
    fromDay,
    toDay,
    x,
    xMid: (d: string | number) => x(toNumber(d) + 0.5),
    dayAt: (px: number) => {
      const raw = Math.floor(fromDay + ((px - x0) / width) * span);
      return dayKey(Math.min(toDay - 1, Math.max(fromDay, raw)));
    },
  } satisfies Scale;
}

/* ─── Text ────────────────────────────────────────────────────────────────── */

/** Estimated width of a label at `fontPx`. */
export function estimateTextWidth(text: string, fontPx = LABEL_FONT_PX) {
  return text.length * LABEL_CHAR_PX * (fontPx / LABEL_FONT_PX);
}

/** Occupied horizontal intervals on one text or bar line. */
export class LineOccupancy {
  private readonly lines = new Map<string, Array<[number, number]>>();

  /** True when `[a, b]` keeps `margin` from everything on `line`. */
  fits(line: string, a: number, b: number, margin = LABEL_MARGIN): boolean {
    for (const [c, d] of this.lines.get(line) ?? []) {
      if (a < d + margin && b > c - margin) return false;
    }
    return true;
  }

  add(line: string, a: number, b: number): void {
    const list = this.lines.get(line);
    if (list) list.push([a, b]);
    else this.lines.set(line, [[a, b]]);
  }

  /** Place `[a, b]` on `line` if it fits; report whether it did. */
  tryAdd(line: string, a: number, b: number, margin = LABEL_MARGIN) {
    if (!this.fits(line, a, b, margin)) return false;
    this.add(line, a, b);
    return true;
  }
}

/**
 * `text` cut to fit `maxWidth` at `fontPx`, with an ellipsis when it had to
 * be cut. Lane and value names sit in a fixed column; a long translation
 * must not run into the plot.
 */
export function fitText(
  text: string,
  maxWidth: number,
  fontPx = LABEL_FONT_PX,
) {
  if (estimateTextWidth(text, fontPx) <= maxWidth) return text;
  const perChar = LABEL_CHAR_PX * (fontPx / LABEL_FONT_PX);
  const keep = Math.max(1, Math.floor(maxWidth / perChar) - 1);
  return `${text.slice(0, keep).trimEnd()}…`;
}

/**
 * Words of `text` broken into lines that each fit `maxWidth`, or no lines
 * at all when a single word does not fit: a note that cannot be read whole
 * is better left out.
 */
export function wrapToWidth(
  text: string,
  maxWidth: number,
  fontPx = LABEL_FONT_PX,
) {
  const lines: string[] = [];
  for (const word of text.split(/\s+/)) {
    const last = lines.at(-1);
    if (
      last !== undefined &&
      estimateTextWidth(`${last} ${word}`, fontPx) <= maxWidth
    ) {
      lines[lines.length - 1] = `${last} ${word}`;
    } else {
      if (estimateTextWidth(word, fontPx) > maxWidth) return [];
      lines.push(word);
    }
  }
  return lines;
}

/* ─── Grid ────────────────────────────────────────────────────────────────── */

export interface GridTick {
  key: string;
  x: number;
  /** Text above the grid line, or null for an unlabelled line. */
  label: string | null;
  /** Year lines (all), month lines (year, quarter) are major. */
  major: boolean;
}

export interface GridFormat {
  year: (key: string) => string;
  monthShort: (key: string) => string;
  monthYear: (key: string) => string;
}

/**
 * Vertical grid lines and their axis labels. A label that would touch its
 * neighbour (or the "today" label at the right) is dropped; the line stays.
 */
export function gridTicks(
  window: TimeWindow,
  zoom: Exclude<TimelineZoom, "range">,
  scale: Scale,
  fmt: GridFormat,
): GridTick[] {
  const ticks: GridTick[] = [];
  const months = monthsBetween(window.from, window.to);
  if (zoom === "all") {
    const pxPerYear = (scale.x1 - scale.x0) / Math.max(1, months.length / 12);
    for (const m of months) {
      if (m < window.from) continue;
      const month = Number(m.slice(5, 7));
      if (month === 1) {
        ticks.push({ key: m, x: scale.x(m), label: fmt.year(m), major: true });
      } else if (
        pxPerYear >= 240 &&
        (month === 4 || month === 7 || month === 10)
      ) {
        ticks.push({ key: m, x: scale.x(m), label: null, major: false });
      }
    }
  } else if (zoom === "year") {
    for (const m of months) {
      if (m < window.from) continue;
      const january = m.slice(5, 7) === "01";
      ticks.push({
        key: m,
        x: scale.x(m),
        label: january ? fmt.year(m) : fmt.monthShort(m),
        major: true,
      });
    }
  } else {
    for (const m of months) {
      if (m < window.from) continue;
      ticks.push({
        key: m,
        x: scale.x(m),
        label: fmt.monthYear(m),
        major: true,
      });
    }
    // Weekly minor lines, on Mondays.
    const fromDay = dayNumber(window.from);
    const toDay = dayNumber(window.to);
    // 1970-01-01 was a Thursday: day numbers with (n + 3) % 7 === 0 are Mondays.
    for (let d = fromDay; d <= toDay; d++) {
      if ((d + 3) % 7 !== 0) continue;
      const key = dayKey(d);
      if (key.endsWith("-01")) continue;
      ticks.push({ key, x: scale.x(d), label: null, major: false });
    }
    ticks.sort((a, b) => a.x - b.x);
  }

  // Labels sit right of their line; drop the ones that would collide.
  const occupancy = new LineOccupancy();
  return ticks.map((tick) => {
    if (tick.label === null) return tick;
    const a = tick.x + 6;
    const b = a + estimateTextWidth(tick.label, 12);
    if (b > scale.x1 || !occupancy.tryAdd("axis", a, b, 8)) {
      return { ...tick, label: null };
    }
    return tick;
  });
}

/**
 * Whether the "Today" label (right-aligned to the today line) fits on the
 * axis: inside the plot and clear of every year or month label. The axis
 * labels win; the dashed line says "today" on its own.
 */
export function todayLabelFits(
  ticks: readonly GridTick[],
  todayX: number,
  labelWidth: number,
  x0: number,
): boolean {
  const a = todayX - 4 - labelWidth;
  const b = todayX - 4;
  if (a < x0) return false;
  return ticks.every((tick) => {
    if (!tick.label) return true;
    const ta = tick.x + 6;
    const tb = ta + estimateTextWidth(tick.label, 12);
    return b + 6 <= ta || a >= tb + 6;
  });
}

/* ─── Lanes ───────────────────────────────────────────────────────────────── */

/** Point shapes, one per kind; colour is never the only difference. */
export type PointShape =
  "dot" | "diamond" | "square" | "tick" | "ring" | "doseMark";

const POINT_SHAPE: Partial<Record<TimelineItemKind, PointShape>> = {
  lifeEvent: "diamond",
  vaccination: "dot",
  visit: "dot",
  procedure: "square",
  labDay: "ring",
  document: "tick",
  doseChange: "doseMark",
};

export interface PlacedSpan {
  item: TimelineItem;
  row: number;
  y: number;
  xStart: number;
  xEnd: number;
  /** Started before the window: drawn with a fade at the left edge. */
  clippedLeft: boolean;
  /** A pause, drawn as an outlined gap over the period it interrupts. */
  pause: boolean;
}

export interface PlacedPoint {
  item: TimelineItem;
  row: number;
  y: number;
  x: number;
  shape: PointShape;
}

export interface PlacedLabel {
  itemId: string;
  text: string;
  x: number;
  y: number;
  /** The person's own life events read as content; other labels as meta. */
  strong: boolean;
}

export interface LaneLayout {
  key: TimelineLaneKey;
  top: number;
  height: number;
  rows: number;
  spans: PlacedSpan[];
  points: PlacedPoint[];
  labels: PlacedLabel[];
}

/** A span is anything with an end or still open; the rest are points. */
export function isSpan(item: TimelineItem): boolean {
  return item.open || (item.end !== null && item.end !== item.start);
}

function inWindow(item: TimelineItem, window: TimeWindow): boolean {
  if (item.start > window.to) return false;
  if (isSpan(item)) {
    return item.open || (item.end ?? item.start) >= window.from;
  }
  return item.start >= window.from;
}

interface LaneInput {
  lane: TimelineLane;
  top: number;
}

/**
 * Lay out one lane: rows for the periods (first row that is free), points on
 * their own row above them, pauses and dose marks over the medication they
 * belong to, then the labels in priority order through one occupancy map.
 */
export function layoutLane(
  { lane, top }: LaneInput,
  window: TimeWindow,
  scale: Scale,
  options: {
    /** How an item reads (`item-words.ts`): codes worded, never raw. */
    words: ItemWordsFn;
    startMissing: string;
    today: string;
  },
): LaneLayout {
  const visible = lane.items.filter((item) => inWindow(item, window));
  const pointItems = visible.filter(
    (item) => !isSpan(item) && item.kind !== "doseChange",
  );
  const doseItems = visible.filter((item) => item.kind === "doseChange");
  const pauseItems = visible.filter(
    (item) => item.kind === "pause" && isSpan(item),
  );
  const spanItems = visible
    .filter((item) => isSpan(item) && item.kind !== "pause")
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  // Points take the first row(s); procedures sit on a second point row so
  // their names never cover the plain visits.
  const hasProcedures = pointItems.some((p) => p.kind === "procedure");
  const hasPlainPoints = pointItems.some((p) => p.kind !== "procedure");
  const pointRows = (hasPlainPoints ? 1 : 0) + (hasProcedures ? 1 : 0);
  const procedureRow = hasPlainPoints ? 1 : 0;

  const rowY = (row: number) => top + LANE_PAD_TOP + row * ROW_HEIGHT;
  const todayX = scale.x(dayNumber(options.today) + 1);

  // Period packing: the first row whose last bar ended before this one.
  const rowEnds: number[] = [];
  const spans: PlacedSpan[] = [];
  for (const item of spanItems) {
    const rawStart = scale.x(item.start);
    const clippedLeft = rawStart < scale.x0;
    const xStart = Math.max(scale.x0, rawStart);
    const lead = item.startKnown ? 0 : UNKNOWN_START_LEAD;
    const endX = item.end
      ? scale.x(dayNumber(item.end) + 1)
      : Math.min(scale.x1, todayX);
    const xEnd = Math.min(scale.x1, Math.max(xStart + 4, endX));
    let row = rowEnds.findIndex((end) => end + BAR_GAP <= xStart - lead);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(xEnd);
    } else {
      rowEnds[row] = xEnd;
    }
    spans.push({
      item,
      row: row + pointRows,
      y: rowY(row + pointRows),
      xStart,
      xEnd,
      clippedLeft,
      pause: false,
    });
  }

  // Pauses lie over the period they interrupt; one without a host gets a row.
  for (const item of pauseItems) {
    const xStart = Math.max(scale.x0, scale.x(item.start));
    const xEnd = Math.min(
      scale.x1,
      item.end ? scale.x(dayNumber(item.end) + 1) : todayX,
    );
    const host = spans.find(
      (s) => !s.pause && s.xStart <= xStart && s.xEnd >= xStart,
    );
    const row = host ? host.row : pointRows + rowEnds.length;
    if (!host) rowEnds.push(xEnd);
    spans.push({
      item,
      row,
      y: rowY(row),
      xStart,
      xEnd: Math.max(xStart + 4, xEnd),
      clippedLeft: false,
      pause: true,
    });
  }

  const points: PlacedPoint[] = [];
  for (const item of pointItems) {
    const row = item.kind === "procedure" ? procedureRow : 0;
    points.push({
      item,
      row,
      y: rowY(row),
      x: scale.xMid(item.start),
      shape: POINT_SHAPE[item.kind] ?? "dot",
    });
  }
  // Dose marks sit on the medication line that runs through their date.
  for (const item of doseItems) {
    const x = scale.xMid(item.start);
    const host = spans.find((s) => !s.pause && s.xStart <= x && s.xEnd >= x);
    const row = host ? host.row : pointRows;
    if (!host && rowEnds.length === 0) rowEnds.push(x);
    points.push({ item, row, y: rowY(row), x, shape: "doseMark" });
  }

  const rows = Math.max(1, pointRows + rowEnds.length);
  const height = LANE_PAD_TOP + (rows - 1) * ROW_HEIGHT + LANE_PAD_BOTTOM;

  const labels = placeLabels(
    spans,
    points,
    scale,
    options.words,
    options.startMissing,
  );
  return { key: lane.key, top, height, rows, spans, points, labels };
}

/**
 * Labels through one occupancy map per text line. Bars and point glyphs are
 * registered first as obstacles, so a label never covers a mark either.
 *
 * Priority: open periods (they define the lane), life events, procedures,
 * closed periods from the longest down, dose marks.
 */
function placeLabels(
  spans: PlacedSpan[],
  points: PlacedPoint[],
  scale: Scale,
  words: ItemWordsFn,
  startMissing: string,
): PlacedLabel[] {
  const occ = new LineOccupancy();
  const line = (row: number, where: "on" | "above") => `${row}:${where}`;
  for (const s of spans) {
    const lead = s.item.startKnown ? 0 : UNKNOWN_START_LEAD;
    // An open period ends in a small arrow head past its last day.
    occ.add(line(s.row, "on"), s.xStart - lead, s.xEnd + (s.item.open ? 7 : 0));
  }
  for (const p of points) {
    if (p.shape === "doseMark") continue;
    const half = GLYPH_HALF_WIDTH[p.shape];
    occ.add(line(p.row, "on"), p.x - half, p.x + half);
  }

  const labels: PlacedLabel[] = [];
  const fitsCard = (a: number, b: number) => a >= scale.x0 && b <= scale.x1 - 2;

  const openSpans = spans.filter((s) => s.item.open && !s.pause);
  const closedSpans = spans
    .filter((s) => !s.item.open && !s.pause)
    .sort((a, b) => b.xEnd - b.xStart - (a.xEnd - a.xStart));
  const pausesWithLabel = spans.filter((s) => s.pause);

  const aboveLabel = (s: PlacedSpan, text: string) => {
    const a = s.xStart + (s.clippedLeft ? 26 : 2);
    const b = a + estimateTextWidth(text);
    if (!fitsCard(a, b)) return false;
    if (!occ.tryAdd(line(s.row, "above"), a, b)) return false;
    labels.push({ itemId: s.item.id, text, x: a, y: s.y - 7, strong: false });
    return true;
  };
  const rightLabel = (
    id: string,
    row: number,
    x: number,
    y: number,
    text: string,
    strong: boolean,
  ) => {
    const a = x;
    const b = a + estimateTextWidth(text);
    if (!fitsCard(a, b)) return false;
    // The label already keeps its own distance from the mark it names, so a
    // smaller margin here; the full margin still separates it from the next
    // mark because that mark's own box is wider than this gap.
    if (!occ.tryAdd(line(row, "on"), a, b, BESIDE_MARGIN)) return false;
    labels.push({ itemId: id, text, x: a, y: y + 4, strong });
    return true;
  };

  const leftLabel = (
    id: string,
    row: number,
    xRight: number,
    y: number,
    text: string,
    strong: boolean,
  ) => {
    const b = xRight;
    const a = b - estimateTextWidth(text);
    if (!fitsCard(a, b)) return false;
    if (!occ.tryAdd(line(row, "on"), a, b, BESIDE_MARGIN)) return false;
    labels.push({ itemId: id, text, x: a, y: y + 4, strong });
    return true;
  };

  for (const s of openSpans) {
    aboveLabel(s, itemLine(s.item, words, startMissing));
  }
  // A point's name starts just clear of its own glyph.
  const besideGlyph = (p: PlacedPoint) =>
    p.x + GLYPH_HALF_WIDTH[p.shape] + BESIDE_MARGIN + 1;
  const leftOfGlyph = (p: PlacedPoint) =>
    p.x - GLYPH_HALF_WIDTH[p.shape] - BESIDE_MARGIN - 1;
  for (const kind of ["lifeEvent", "procedure"] as const) {
    const strong = kind === "lifeEvent";
    for (const p of points.filter((p) => p.item.kind === kind)) {
      const { label } = words(p.item);
      if (rightLabel(p.item.id, p.row, besideGlyph(p), p.y, label, strong))
        continue;
      leftLabel(p.item.id, p.row, leftOfGlyph(p), p.y, label, strong);
    }
  }
  // A period's name goes right of its bar, else above it, else left of it.
  // A name already shown on the same row (a winter course every year) is
  // shown once: the repeats read as the same thing again.
  const shownOnRow = new Set<string>();
  for (const s of closedSpans.sort((a, b) => a.xStart - b.xStart)) {
    const text = itemLine(s.item, words, startMissing);
    const rowKey = `${s.row}:${text}`;
    if (shownOnRow.has(rowKey)) continue;
    const strong = s.item.kind === "lifeEvent";
    const placed =
      rightLabel(s.item.id, s.row, s.xEnd + 6, s.y, text, strong) ||
      aboveLabel(s, text) ||
      leftLabel(s.item.id, s.row, s.xStart - 6, s.y, text, strong);
    if (placed) shownOnRow.add(rowKey);
  }
  for (const s of pausesWithLabel) aboveLabel(s, words(s.item).label);
  for (const p of points.filter((p) => p.shape === "doseMark")) {
    const dose = words(p.item);
    const text = dose.sub ?? dose.label;
    const a = p.x + 2;
    const b = a + estimateTextWidth(text);
    if (fitsCard(a, b) && occ.tryAdd(line(p.row, "above"), a, b)) {
      labels.push({ itemId: p.item.id, text, x: a, y: p.y - 7, strong: false });
    }
  }
  // A labelled point with no room left is simply drawn without its name.
  return labels;
}

/* ─── Value lines ─────────────────────────────────────────────────────────── */

export interface SeriesPointLayout {
  /** The bucket's first day. */
  t: string;
  mean: number;
  /** Readings behind the mean. */
  count: number;
  x: number;
  y: number;
  /** Fewer than {@link THIN_BUCKET_COUNT} readings: drawn hollow. */
  thin: boolean;
}

export interface SeriesLayout {
  key: string;
  unit: string | null;
  top: number;
  height: number;
  /** SVG path data of the solid runs; empty when no two points touch. */
  path: string;
  /** SVG path data of the dashed bridges over short gaps; may be empty. */
  bridges: string;
  /** The most recent mean inside the window, or null. */
  latest: number | null;
  points: SeriesPointLayout[];
}

/** A bucket mean from fewer readings than this is drawn hollow. */
export const THIN_BUCKET_COUNT = 3;

/**
 * The most missing buckets a dashed bridge spans. Beyond it the line stops
 * and starts again, so a long silence reads as one and not as a trend.
 *
 * The rule is one length, about six months between the two points a bridge
 * joins, never more, and never more than a third of what the zoom shows:
 * one missing quarter (the points are six months apart), two missing months
 * in a year (three months apart, a sixth of the window) and four missing
 * weeks in three months (five weeks apart, the window's third). A longer
 * bridge would draw a slope through a stretch where nothing was measured.
 */
export const MAX_BRIDGED_GAP: Readonly<Record<TimelineBucket, number>> = {
  quarter: 1,
  month: 2,
  week: 4,
  // Days come only with a chosen range under six weeks. Three missing days
  // (points four days apart) bridge a weekend away or a forgotten cuff;
  // a longer silence in a window that short is a break worth seeing, and
  // the bridge stays well under a third of even a two-week range.
  day: 3,
};

/**
 * One neutral line per series, scaled to its own range inside the window.
 * A point sits in the middle of its bucket, and every bucket with a reading
 * gets its point, so one month with no neighbours stays visible. Missing
 * buckets stay missing: a short gap is bridged by a dashed stroke
 * ({@link MAX_BRIDGED_GAP}) that joins the two real points and invents none
 * between them, a longer one breaks the line.
 */
export function layoutSeries(
  series: readonly TimelineSeries[],
  top: number,
  window: TimeWindow,
  scale: Scale,
  bucket: TimelineBucket,
): SeriesLayout[] {
  return series.map((s, index) => {
    const rowTop = top + index * SERIES_HEIGHT + 6;
    const height = SERIES_HEIGHT - 16;
    // A bucket that starts before the window still belongs to it while any
    // of its days lie inside.
    const inside = s.points
      .filter((p) => p.t <= window.to && bucketAfter(p.t, bucket) > window.from)
      .sort((a, b) => (a.t < b.t ? -1 : 1));
    if (inside.length === 0) {
      return {
        key: s.key,
        unit: s.unit,
        top: rowTop,
        height,
        path: "",
        bridges: "",
        latest: null,
        points: [],
      };
    }
    let lo = Math.min(...inside.map((p) => p.mean));
    let hi = Math.max(...inside.map((p) => p.mean));
    const pad = Math.max((hi - lo) * 0.12, Math.abs(hi) * 0.01, 0.5);
    lo -= pad;
    hi += pad;
    const y = (v: number) => rowTop + height * (1 - (v - lo) / (hi - lo));
    const points = inside.map((p) => {
      const mid = (dayNumber(p.t) + dayNumber(bucketAfter(p.t, bucket))) / 2;
      const x = Math.min(scale.x1, Math.max(scale.x0, scale.x(mid)));
      return {
        t: p.t,
        mean: p.mean,
        count: p.count,
        x,
        y: y(p.mean),
        thin: p.count < THIN_BUCKET_COUNT,
      };
    });
    const xy = (p: SeriesPointLayout) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    let path = "";
    let bridges = "";
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const cur = points[i];
      const missing =
        bucketIndex(cur.t, bucket) - bucketIndex(prev.t, bucket) - 1;
      if (missing === 0) {
        // Continue the run, or open a new one at the previous point.
        path += path.endsWith(xy(prev))
          ? `L${xy(cur)}`
          : `M${xy(prev)}L${xy(cur)}`;
      } else if (missing <= MAX_BRIDGED_GAP[bucket]) {
        bridges += `M${xy(prev)}L${xy(cur)}`;
      }
    }
    return {
      key: s.key,
      unit: s.unit,
      top: rowTop,
      height,
      path,
      bridges,
      latest: inside[inside.length - 1].mean,
      points,
    };
  });
}

/* ─── Whole chart ─────────────────────────────────────────────────────────── */

export interface TimelineLayout {
  width: number;
  height: number;
  scale: Scale;
  lanes: LaneLayout[];
  seriesTop: number;
  series: SeriesLayout[];
}

/** Width of the lane-name column at a given chart width. */
export function labelColumnWidth(width: number): number {
  return width >= 600 ? 164 : 140;
}

export function layoutTimeline(input: {
  width: number;
  window: TimeWindow;
  lanes: readonly TimelineLane[];
  series: readonly TimelineSeries[];
  bucket: TimelineBucket;
  words: ItemWordsFn;
  startMissing: string;
  today: string;
}): TimelineLayout {
  const x0 = labelColumnWidth(input.width);
  const scale = createScale(input.window, x0, input.width - 8);
  let top = AXIS_HEIGHT;
  const lanes: LaneLayout[] = [];
  for (const key of LANE_ORDER) {
    const lane = input.lanes.find((l) => l.key === key);
    if (!lane) continue;
    const layout = layoutLane({ lane, top }, input.window, scale, {
      words: input.words,
      startMissing: input.startMissing,
      today: input.today,
    });
    // An empty lane is not drawn at all.
    if (layout.spans.length === 0 && layout.points.length === 0) continue;
    lanes.push(layout);
    top += layout.height;
  }
  const seriesTop = top + (input.series.length > 0 ? SERIES_GAP : 0);
  const series = layoutSeries(
    input.series,
    seriesTop,
    input.window,
    scale,
    input.bucket,
  );
  const height = seriesTop + series.length * SERIES_HEIGHT + 4;
  return { width: input.width, height, scale, lanes, seriesTop, series };
}

/* ─── Interaction ─────────────────────────────────────────────────────────── */

/**
 * The date a pointer at (x, y) selects: the date of a mark within reach, the
 * start of a period it lands on, otherwise the day under the pointer.
 */
export function dateAtPointer(
  layout: TimelineLayout,
  x: number,
  y: number,
): string {
  let best: { distance: number; date: string } | null = null;
  for (const lane of layout.lanes) {
    if (y < lane.top || y > lane.top + lane.height) continue;
    for (const p of lane.points) {
      const distance = Math.hypot(p.x - x, (p.y - y) / 2);
      if (distance <= HIT_SLOP && (!best || distance < best.distance)) {
        best = { distance, date: p.item.start };
      }
    }
    if (best) return best.date;
    for (const s of lane.spans) {
      if (
        Math.abs(s.y - y) <= HIT_SLOP &&
        x >= s.xStart - 2 &&
        x <= s.xEnd + 2
      ) {
        const startInside = s.item.start >= layout.scale.dayAt(layout.scale.x0);
        return startInside ? s.item.start : layout.scale.dayAt(x);
      }
    }
  }
  return layout.scale.dayAt(x);
}

/**
 * The selection after an arrow key: a day in `quarter`, a month in `year`,
 * a year in `all`, never past `today` and never before `floor`.
 */
export function stepSelection(
  current: string,
  direction: -1 | 1,
  zoom: Exclude<TimelineZoom, "range">,
  today: string,
  floor: string,
): string {
  let next: string;
  if (zoom === "quarter") next = dayKey(dayNumber(current) + direction);
  else if (zoom === "year") next = addMonths(current, direction);
  else next = addMonths(current, 12 * direction);
  if (next > today) return today;
  if (next < floor) return floor;
  return next;
}

/**
 * What the selection bar names for the period `[from, to]` (the bucket that
 * holds the selected day): everything that happens, starts or ends in it,
 * and every closed period that runs through it. A period that has been open
 * since before the period (a chronic condition, a standing medication, an
 * allergy) is the backdrop of every period and is left out, as are
 * documents, which the day lists with their visit. Lane order kept. The
 * same rule holds for a week, a month and a quarter.
 */
export function itemsInPeriod(
  lanes: readonly TimelineLane[],
  from: string,
  to: string,
  today: string,
): Array<{ lane: TimelineLaneKey; item: TimelineItem; through: boolean }> {
  const out: Array<{
    lane: TimelineLaneKey;
    item: TimelineItem;
    through: boolean;
  }> = [];
  for (const key of LANE_ORDER) {
    if (key === "documents") continue;
    const lane = lanes.find((l) => l.key === key);
    if (!lane) continue;
    for (const item of lane.items) {
      const end = item.open ? today : (item.end ?? item.start);
      if (item.start > to || end < from) continue;
      const startsInside = item.start >= from;
      if (item.open && !startsInside) continue;
      const endsInside = !item.open && end <= to;
      out.push({ lane: key, item, through: !startsInside && !endsInside });
    }
  }
  return out;
}

/**
 * The day to select before anyone has picked one: the latest day inside
 * `window` (and not after today) that the selection bar has something for,
 * so the bar opens on the newest bucket with data, never on an empty one.
 * A lane entry counts on the last day `itemsInPeriod` would name it (an open
 * period on its start, a closed one on its end); a value line counts on the
 * first day of its newest bucket. Null when the window holds nothing.
 */
export function latestDataDate(
  timeline: {
    lanes: readonly TimelineLane[];
    series: readonly TimelineSeries[];
  },
  today: string,
  window: TimeWindow,
): string | null {
  const last = window.to < today ? window.to : today;
  let best: string | null = null;
  const consider = (day: string) => {
    if (day < window.from || day > last) return;
    if (!best || day > best) best = day;
  };
  for (const lane of timeline.lanes) {
    if (lane.key === "documents") continue;
    for (const item of lane.items) {
      if (item.start > last) continue;
      if (item.open) {
        consider(item.start);
        continue;
      }
      const end = item.end ?? item.start;
      // A closed period still running past the window's end is named in
      // every bucket up to it; its last named day here is the window's end.
      consider(end > last ? last : end);
    }
  }
  for (const series of timeline.series) {
    for (const point of series.points) consider(point.t);
  }
  return best;
}
