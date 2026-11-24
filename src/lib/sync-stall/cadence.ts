/**
 * When has a source that delivers on its own gone quiet? The one rule, kept
 * pure, behind the stall notice, the "quiet since" line in the web and the
 * integration watchdog's silence flag.
 *
 * A source qualifies only when its own history says it delivers: it must have
 * delivered on at least {@link MIN_DELIVERY_DAYS} of the {@link HISTORY_DAYS}
 * days before it went quiet. A source the person uses now and then (a scale,
 * a phone left in a drawer) never qualifies, so its silence is never news.
 *
 * Its cadence is the typical gap between two deliveries, read from the hours
 * it delivered in (the median gap, so one long weekend does not stretch it).
 * The source counts as stalled once it has been quiet for
 * {@link CADENCE_FACTOR} times that gap, and never sooner than the source's
 * floor: 24 hours for an iPhone (whose silent catch-up wake asks first, after
 * six), longer for a ring or a watch that uploads only when its phone app is
 * opened. A phone that uploads every hour and a ring that uploads once a day
 * are judged each against its own rhythm, and nothing waits longer than
 * {@link MAX_THRESHOLD_MS} past the floor.
 *
 * Every duration here is absolute (milliseconds between instants), so a DST
 * change moves no threshold; only the notice's daytime window reads a local
 * clock, and it does that through the zone (`notice.ts`).
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How many days of a source's own history decide "normally delivers". */
export const HISTORY_DAYS = 14;

/** Days with a delivery, out of {@link HISTORY_DAYS}, that make a source "normally delivering". */
export const MIN_DELIVERY_DAYS = 10;

/** A source is stalled after this many typical gaps without a delivery. */
export const CADENCE_FACTOR = 2;

/** The most a cadence may add to the floor. */
export const MAX_THRESHOLD_MS = 3 * DAY_MS;

export interface Cadence {
  /** Distinct UTC days with a delivery in the history window. */
  deliveredDays: number;
  /** The median gap between consecutive delivery hours; null with fewer than two. */
  typicalGapMs: number | null;
}

/**
 * Learn a cadence from delivery instants (any order, duplicates allowed; an
 * hour bucket per delivery is enough). Only the {@link HISTORY_DAYS} up to and
 * including `until` count, which is where the silence began, so the history is
 * the one the silence breaks with.
 */
export function learnCadence(
  deliveries: readonly Date[],
  until: Date,
): Cadence {
  const end = until.getTime();
  const start = end - HISTORY_DAYS * DAY_MS;
  const instants = [
    ...new Set(
      deliveries
        .map((d) => d.getTime())
        .filter((ms) => Number.isFinite(ms) && ms > start && ms <= end),
    ),
  ].sort((a, b) => a - b);
  const days = new Set(instants.map((ms) => Math.floor(ms / DAY_MS)));
  const gaps: number[] = [];
  for (let i = 1; i < instants.length; i += 1) {
    gaps.push(instants[i]! - instants[i - 1]!);
  }
  return { deliveredDays: days.size, typicalGapMs: median(gaps) };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whether a cadence says the source normally delivers. */
export function deliversNormally(cadence: Cadence): boolean {
  return cadence.deliveredDays >= MIN_DELIVERY_DAYS;
}

/**
 * How long the source may stay quiet before it counts as stalled: the floor,
 * or {@link CADENCE_FACTOR} typical gaps when that is longer, never more than
 * {@link MAX_THRESHOLD_MS} past the floor.
 */
export function stallThresholdMs(floorMs: number, cadence: Cadence): number {
  const byCadence =
    cadence.typicalGapMs === null ? 0 : CADENCE_FACTOR * cadence.typicalGapMs;
  return Math.min(Math.max(floorMs, byCadence), floorMs + MAX_THRESHOLD_MS);
}

export type StallVerdict =
  /** The last delivery is inside the floor, or there never was one. */
  | { kind: "fresh" }
  /** Quiet past the floor; the history decides. */
  | { kind: "needs_history" }
  /** Quiet, but not yet for its own cadence's threshold. */
  | { kind: "within_cadence"; thresholdMs: number }
  /** Quiet past its threshold, and its history says it should deliver. */
  | { kind: "stalled"; since: Date; thresholdMs: number }
  /** Quiet, and it does not normally deliver: nothing to tell. */
  | { kind: "not_expected" };

/**
 * Judge one source. Without a cadence the verdict stops at `needs_history`
 * once the floor is passed, so a caller reads the history only for a source
 * that is quiet at all.
 */
export function judgeStall(input: {
  floorMs: number;
  lastAt: Date | null;
  cadence: Cadence | null;
  now: Date;
}): StallVerdict {
  const { floorMs, lastAt, cadence, now } = input;
  if (lastAt === null) return { kind: "fresh" };
  const quietMs = now.getTime() - lastAt.getTime();
  if (quietMs <= floorMs) return { kind: "fresh" };
  if (cadence === null) return { kind: "needs_history" };
  if (!deliversNormally(cadence)) return { kind: "not_expected" };
  const thresholdMs = stallThresholdMs(floorMs, cadence);
  if (quietMs <= thresholdMs) return { kind: "within_cadence", thresholdMs };
  return { kind: "stalled", since: lastAt, thresholdMs };
}

/** The start of the UTC hour an instant falls in. */
export function hourBucket(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}
