/**
 * Layout of one night's hypnogram: which stage lanes to draw, where each
 * segment sits, and which clock hours label the axis.
 *
 * Pure, so the chart component stays a thin Recharts wrapper and the rules
 * here can be tested without rendering one.
 *
 *   - Lanes run top to bottom from Awake to Deep, the "cityscape" order
 *     Apple Health and Oura use: depth increases downward. Only the stages
 *     the night actually holds get a lane, so an Apple night (Awake, REM,
 *     Core, Deep) draws four rows, not six.
 *   - Axis ticks fall on whole hours of the zone the night is read in (the
 *     profile zone, or the reading's own zone when it carries one), with a
 *     step of one, two or three hours depending on the night's length. Each
 *     candidate is checked against its own offset, so a night across a DST
 *     change still labels real wall-clock hours.
 */
import { dateOnlyKey } from "@/lib/tz/date-only";
import { tzOffsetMinutes } from "@/lib/tz/format";

/** Every stage the night endpoint can name, top lane first. */
export const HYPNOGRAM_LANE_ORDER = [
  "AWAKE",
  "IN_BED",
  "ASLEEP",
  "REM",
  "CORE",
  "DEEP",
] as const;

export type HypnogramStage = (typeof HYPNOGRAM_LANE_ORDER)[number];

export interface HypnogramSegmentInput {
  stage: string | null;
  start: string;
  end: string;
}

export interface HypnogramSpan {
  stage: HypnogramStage;
  /** Epoch ms. */
  x1: number;
  x2: number;
  /** Lane index, 0 at the bottom. */
  lane: number;
}

export interface HypnogramLayout {
  /** Present stages, top lane first. */
  lanes: HypnogramStage[];
  spans: HypnogramSpan[];
}

const KNOWN = new Set<string>(HYPNOGRAM_LANE_ORDER);

export function hypnogramLayout(
  segments: readonly HypnogramSegmentInput[],
): HypnogramLayout {
  const valid = segments
    .filter(
      (seg): seg is HypnogramSegmentInput & { stage: HypnogramStage } =>
        seg.stage !== null && KNOWN.has(seg.stage),
    )
    .map((seg) => ({
      stage: seg.stage,
      x1: Date.parse(seg.start),
      x2: Date.parse(seg.end),
    }))
    .filter(
      (s) => Number.isFinite(s.x1) && Number.isFinite(s.x2) && s.x2 > s.x1,
    )
    .sort((a, b) => a.x1 - b.x1);
  const present = new Set(valid.map((s) => s.stage));
  const lanes = HYPNOGRAM_LANE_ORDER.filter((stage) => present.has(stage));
  const laneOf = new Map(
    lanes.map((stage, i) => [stage, lanes.length - 1 - i]),
  );
  return {
    lanes,
    spans: valid.map((s) => ({ ...s, lane: laneOf.get(s.stage)! })),
  };
}

/**
 * Whether a layout is worth drawing as a timeline. A synthesised night
 * (WHOOP, Polar: stage totals laid out in a fixed order) is not, because the
 * bar would show a phase order that was never measured. Neither is a night
 * whose every segment starts on the same instant.
 */
export function hasHypnogramTrack(
  layout: HypnogramLayout,
  reconstructed: boolean,
): boolean {
  if (reconstructed || layout.spans.length === 0) return false;
  return (
    layout.spans.length === 1 || new Set(layout.spans.map((s) => s.x1)).size > 1
  );
}

const HOUR_MS = 3_600_000;

/** Whole-hour ticks in `timeZone` between `fromMs` and `toMs`, inclusive. */
export function hypnogramTicks(
  fromMs: number,
  toMs: number,
  timeZone: string,
): number[] {
  const spanHours = (toMs - fromMs) / HOUR_MS;
  if (!Number.isFinite(spanHours) || spanHours <= 0) return [];
  const step = spanHours <= 5 ? 1 : spanHours <= 10 ? 2 : 3;
  const localHour = (ms: number) => {
    const local = ms + tzOffsetMinutes(new Date(ms), timeZone) * 60_000;
    return Math.floor(local / HOUR_MS);
  };
  // The first instant at or after `fromMs` that is a whole local hour. A
  // zone offset in half or quarter hours moves that instant off the UTC
  // hour grid, so it is derived from the local clock, not from UTC.
  const offsetMs = tzOffsetMinutes(new Date(fromMs), timeZone) * 60_000;
  let t = Math.ceil((fromMs + offsetMs) / HOUR_MS) * HOUR_MS - offsetMs;
  const ticks: number[] = [];
  for (; t <= toMs; t += HOUR_MS) {
    const hour = ((localHour(t) % 24) + 24) % 24;
    if (hour % step === 0) ticks.push(t);
  }
  return ticks;
}

/** The wake-day key `days` away from `key` (`YYYY-MM-DD`). */
export function shiftNightKey(key: string, days: number): string {
  const ms = Date.parse(`${key}T12:00:00.000Z`) + days * 86_400_000;
  return dateOnlyKey(new Date(ms));
}
