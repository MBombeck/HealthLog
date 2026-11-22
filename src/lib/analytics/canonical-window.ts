/**
 * The 90-day canonical window aggregate of the summaries slice: per type the
 * 7- and 30-day means, the mean of days [30, 60) back and the 90-day median,
 * each over the ladder-canonical source of every (type, UTC day), an
 * hourly-mean type (pulse) weighing each day once as the mean of its hours.
 *
 * It used to be one statement that ranked every raw reading of the window
 * with a window function, then sorted the canonical readings twice more for
 * the hour and day weights. On a dense stream (a watch syncing about 35 000
 * pulse readings a day) that is a sort of three million rows per call, and
 * the slice is rebuilt after every sync, so it held the app's launch read
 * (the daily digest) at one to four seconds.
 *
 * Here the readings are folded before anything is ranked
 * (`canonical-window-sql.ts`), and the window is cut in two:
 *
 * - the whole UTC days between the window's first day and today are a closed
 *   block (`closedBlockKeyPart(today)`): the canonical source's hours (count
 *   and sum), the median's value counts and the pick of each day. A sync of
 *   today's readings leaves it in place; a write that reaches back before
 *   today, or does not say how far back it reached, drops it, and the next
 *   UTC day names a new key;
 * - the edge read takes the rest on every call: the window's first day (cut
 *   at `now - 90 days`), today and after, and the three hours the 7-, 30- and
 *   60-day edges cut, split at the edge.
 *
 * The figures are composed from those cells with the statistic the old
 * statement computed: every reading once for a mean of readings, a reading
 * weighted `w(n) / (n × Σ w)` of its hour and day for an hourly-mean type,
 * and `PERCENTILE_CONT(0.5)` over every reading for the median. Only the
 * order of the floating-point additions differs (the old statement summed in
 * whatever order its parallel sort left equal keys, so it did not repeat
 * itself to the last bit either); the median is exact.
 * `tests/integration/canonical-window-parity.test.ts` holds the old
 * statement as its reference.
 */
import { createHash } from "node:crypto";

import {
  closedWindowSql,
  edgeWindowSql,
  type ClosedWindowRow,
  type EdgeCellRow,
} from "@/lib/analytics/canonical-window-sql";
import { closedBlockKeyPart } from "@/lib/cache/closed-block";
import { caches, type ServerCache } from "@/lib/cache/server-cache";
import { prisma } from "@/lib/db";
import {
  activePulseDayMeanMethod,
  usesHourlyMeanDay,
  hourWeight,
  type PulseDayMeanMethod,
} from "@/lib/measurements/day-statistic";
import { READING_SPREAD, varianceOfCounts } from "@/lib/stats/spread";
import { startOfUtcDay } from "@/lib/tz/start-of-utc-day";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A closed block's lifetime when no write reaches it. */
const CLOSED_WINDOW_TTL_MS = 15 * 60_000;

/** One type's figures, as the old window statement returned them. */
export interface CanonicalWindowRow {
  type: string;
  avg7: number | null;
  avg30: number | null;
  avg30_last_month: number | null;
  median: number | null;
  /**
   * Readings more than two standard deviations from the window's mean (the
   * comprehensive aggregate's anomaly count).
   */
  anomalies: number;
}

interface ClosedType {
  /** The canonical source's hours, oldest first. */
  hourAt: Float64Array;
  hourN: Float64Array;
  hourTotal: Float64Array;
  /** The median's values, ascending, and how often each occurs. */
  values: Float64Array;
  counts: Float64Array;
  /** The canonical source per UTC day (ms). */
  picks: Map<number, string>;
}

type ClosedWindow = Map<string, ClosedType>;

/** Where the window is cut, all from the request's `now`. */
export interface WindowCuts {
  now: Date;
  /** End of the window's first UTC day, where the closed block starts. */
  blockFrom: Date;
  /** Start of today (UTC), where the closed block ends. */
  blockTo: Date;
  /** The hours the 7-, 30- and 60-day edges fall in. */
  hour7: Date;
  hour30: Date;
  hour60: Date;
}

export function windowCuts(now: Date): WindowCuts {
  const ms = now.getTime();
  const hourOf = (days: number) =>
    new Date(Math.floor((ms - days * DAY_MS) / HOUR_MS) * HOUR_MS);
  return {
    now,
    blockFrom: new Date(
      startOfUtcDay(new Date(ms - 90 * DAY_MS)).getTime() + DAY_MS,
    ),
    blockTo: startOfUtcDay(now),
    hour7: hourOf(7),
    hour30: hourOf(30),
    hour60: hourOf(60),
  };
}

async function readClosedWindowLive(
  userId: string,
  cuts: WindowCuts,
  rankUnqualified: string,
): Promise<ClosedWindow> {
  const rows = await prisma.$queryRawUnsafe<ClosedWindowRow[]>(
    closedWindowSql(rankUnqualified),
    userId,
    cuts.blockFrom,
    cuts.blockTo,
  );
  const hours = new Map<string, Array<[number, number, number]>>();
  const values = new Map<string, Array<[number, number]>>();
  const picks = new Map<string, Map<number, string>>();
  const listOf = <V>(map: Map<string, V[]>, type: string): V[] => {
    let list = map.get(type);
    if (!list) map.set(type, (list = []));
    return list;
  };
  for (const r of rows) {
    if (r.kind === "hour") {
      listOf(hours, r.type).push([
        new Date(r.at!).getTime(),
        Number(r.n),
        Number(r.total),
      ]);
    } else if (r.kind === "value") {
      listOf(values, r.type).push([Number(r.value), Number(r.n)]);
    } else {
      let map = picks.get(r.type);
      if (!map) picks.set(r.type, (map = new Map()));
      map.set(new Date(r.at!).getTime(), r.source!);
    }
  }
  const block: ClosedWindow = new Map();
  for (const [type, list] of hours) {
    list.sort((a, b) => a[0] - b[0]);
    const vals = (values.get(type) ?? []).sort((a, b) => a[0] - b[0]);
    block.set(type, {
      hourAt: Float64Array.from(list, (h) => h[0]),
      hourN: Float64Array.from(list, (h) => h[1]),
      hourTotal: Float64Array.from(list, (h) => h[2]),
      values: Float64Array.from(vals, (v) => v[0]),
      counts: Float64Array.from(vals, (v) => v[1]),
      picks: picks.get(type) ?? new Map(),
    });
  }
  return block;
}

function ladderKey(priorityJson: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(priorityJson ?? null))
    .digest("base64url")
    .slice(0, 16);
}

/** The closed block's cache key: user, ladder, the block's days. */
export function closedWindowKey(
  userId: string,
  priorityJson: unknown,
  cuts: WindowCuts,
): string {
  return `${userId}|canonical-window|${ladderKey(priorityJson)}|from:${cuts.blockFrom.getTime()}|${closedBlockKeyPart(cuts.blockTo)}`;
}

function readClosedWindow(
  userId: string,
  cuts: WindowCuts,
  priorityJson: unknown,
  rankUnqualified: string,
): Promise<ClosedWindow> {
  const cache = caches.analytics as ServerCache<ClosedWindow>;
  return cache
    .wrap(
      closedWindowKey(userId, priorityJson, cuts),
      () => readClosedWindowLive(userId, cuts, rankUnqualified),
      CLOSED_WINDOW_TTL_MS,
    )
    .then((r) => r.value);
}

/** A running weighted sum: numerator and weight. */
class Mean {
  num = 0;
  den = 0;
  add(total: number, weight: number): void {
    this.num += total;
    this.den += weight;
  }
  value(): number | null {
    return this.den === 0 ? null : this.num / this.den;
  }
}

interface TypeFold {
  w7: Mean;
  w30: Mean;
  lastMonth: Mean;
  /** Edge values of the median, value → count. */
  edgeValues: Map<number, number>;
}

function newFold(): TypeFold {
  return {
    w7: new Mean(),
    w30: new Mean(),
    lastMonth: new Mean(),
    edgeValues: new Map(),
  };
}

/** The block's and the edge's value counts merged, ascending by value. */
function mergeValues(
  values: Float64Array,
  counts: Float64Array,
  edge: Map<number, number>,
): Array<[number, number]> {
  const edgeSorted = [...edge.entries()].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < values.length || j < edgeSorted.length) {
    if (
      j >= edgeSorted.length ||
      (i < values.length && values[i] <= edgeSorted[j][0])
    ) {
      out.push([values[i], counts[i]]);
      i += 1;
    } else {
      out.push(edgeSorted[j]);
      j += 1;
    }
  }
  return out;
}

/** `PERCENTILE_CONT(0.5)` over the readings an ascending value list holds. */
function medianOf(merged: ReadonlyArray<[number, number]>): number | null {
  let total = 0;
  for (const [, c] of merged) total += c;
  if (total === 0) return null;
  const pos = 0.5 * (total - 1);
  const loIdx = Math.floor(pos);
  const hiIdx = Math.ceil(pos);
  let lo: number | null = null;
  let hi: number | null = null;
  let seen = 0;
  for (const [value, count] of merged) {
    seen += count;
    if (lo === null && loIdx < seen) lo = value;
    if (hiIdx < seen) {
      hi = value;
      break;
    }
  }
  // PostgreSQL's interpolation, `lo + pct × (hi − lo)`, to the bit.
  return loIdx === hiIdx ? lo : lo! + (pos - loIdx) * (hi! - lo!);
}

/**
 * The readings more than two population standard deviations from the
 * window's mean, as the comprehensive aggregate counts them:
 * `|ROUND(((value − mean) / sd)::numeric, 2)| > 2`. PostgreSQL converts a
 * double to numeric at 15 significant digits and rounds half away from
 * zero, so the test is `|z| ≥ 2.005` on the 15-digit value.
 */
function anomaliesOf(merged: ReadonlyArray<[number, number]>): number {
  let n = 0;
  let sum = 0;
  for (const [value, count] of merged) {
    n += count;
    sum += value * count;
  }
  const v = varianceOfCounts(merged, READING_SPREAD);
  if (v === null || !(v > 0)) return 0;
  const mean = sum / n;
  const sd = Math.sqrt(v);
  let out = 0;
  for (const [value, count] of merged) {
    const z = Number(((value - mean) / sd).toPrecision(15));
    if (Math.abs(z) >= 2.005) out += count;
  }
  return out;
}

/**
 * Compose the window from the closed block and the edge cells. Exported for
 * its unit test; `readCanonicalWindow` is the reader.
 */
export function composeCanonicalWindow(
  block: ClosedWindow,
  edge: readonly EdgeCellRow[],
  cuts: WindowCuts,
  method: PulseDayMeanMethod,
): CanonicalWindowRow[] {
  const h7 = cuts.hour7.getTime();
  const h30 = cuts.hour30.getTime();
  const h60 = cuts.hour60.getTime();
  const cutHours = new Set([h7, h30, h60]);
  const folds = new Map<string, TypeFold>();
  const foldOf = (type: string) => {
    let f = folds.get(type);
    if (!f) folds.set(type, (f = newFold()));
    return f;
  };
  /** Add `total` over `n` readings of weight `w` each to the windows they fall in. */
  const addTo = (
    f: TypeFold,
    total: number,
    n: number,
    w: number,
    in7: boolean,
    in30: boolean,
    in60: boolean,
  ) => {
    if (in7) f.w7.add(total * w, n * w);
    if (in30) f.w30.add(total * w, n * w);
    if (in60 && !in30) f.lastMonth.add(total * w, n * w);
  };

  // The closed block: every hour but the cut ones lies wholly on one side of
  // each edge. A day's weight is the sum of its hours' weights.
  const dayWeights = new Map<string, Map<number, number>>();
  for (const [type, t] of block) {
    const f = foldOf(type);
    const hourly = usesHourlyMeanDay(type);
    const weights = new Map<number, number>();
    for (let k = 0; k < t.hourAt.length; k++) {
      const day = startOfUtcDay(new Date(t.hourAt[k])).getTime();
      weights.set(
        day,
        (weights.get(day) ?? 0) + hourWeight(t.hourN[k], method),
      );
    }
    dayWeights.set(type, weights);
    for (let k = 0; k < t.hourAt.length; k++) {
      const at = t.hourAt[k];
      if (cutHours.has(at)) continue;
      const n = t.hourN[k];
      const w = hourly
        ? hourWeight(n, method) /
          (n * weights.get(startOfUtcDay(new Date(at)).getTime())!)
        : 1;
      addTo(
        f,
        t.hourTotal[k],
        n,
        w,
        at >= h7 + HOUR_MS,
        at >= h30 + HOUR_MS,
        at >= h60 + HOUR_MS && at < h30,
      );
    }
  }

  // The edge: the cut hours keep the block's pick and weights; the days the
  // edge holds whole are picked and weighed here.
  const cutHourN = new Map<string, number>();
  const liveHourN = new Map<string, number>();
  const cutKey = (type: string, at: number) => `${type}|${at}`;
  const canonical: EdgeCellRow[] = [];
  for (const c of edge) {
    const at = new Date(c.at).getTime();
    if (c.pick === null) {
      const pick = block
        .get(c.type)
        ?.picks.get(startOfUtcDay(new Date(at)).getTime());
      if (pick !== c.source) continue;
      const key = cutKey(c.type, at);
      cutHourN.set(key, (cutHourN.get(key) ?? 0) + Number(c.n));
    } else {
      if (c.pick !== c.source) continue;
      const key = cutKey(c.type, at);
      liveHourN.set(key, (liveHourN.get(key) ?? 0) + Number(c.n));
    }
    canonical.push(c);
  }
  const liveDayWeight = new Map<string, number>();
  for (const [key, n] of liveHourN) {
    const [type, at] = key.split("|");
    const dayKey = `${type}|${startOfUtcDay(new Date(Number(at))).getTime()}`;
    liveDayWeight.set(
      dayKey,
      (liveDayWeight.get(dayKey) ?? 0) + hourWeight(n, method),
    );
  }
  for (const c of canonical) {
    const at = new Date(c.at).getTime();
    const f = foldOf(c.type);
    const n = Number(c.n);
    const value = Number(c.value);
    const day = startOfUtcDay(new Date(at)).getTime();
    let w = 1;
    if (usesHourlyMeanDay(c.type)) {
      const key = cutKey(c.type, at);
      const hourN = c.pick === null ? cutHourN.get(key)! : liveHourN.get(key)!;
      const dayWeight =
        c.pick === null
          ? (dayWeights.get(c.type)?.get(day) ?? hourWeight(hourN, method))
          : liveDayWeight.get(`${c.type}|${day}`)!;
      w = hourWeight(hourN, method) / (hourN * dayWeight);
    }
    addTo(f, value * n, n, w, c.in7, c.in30, c.in60);
    // A cut hour's readings are in the block's value counts already.
    if (c.pick !== null) {
      f.edgeValues.set(value, (f.edgeValues.get(value) ?? 0) + n);
    }
  }

  const out: CanonicalWindowRow[] = [];
  const empty = new Float64Array(0);
  for (const [type, f] of folds) {
    const t = block.get(type);
    const merged = mergeValues(
      t?.values ?? empty,
      t?.counts ?? empty,
      f.edgeValues,
    );
    const median = medianOf(merged);
    // A type is in the answer when the window holds a canonical reading.
    if (median === null) continue;
    out.push({
      type,
      avg7: f.w7.value(),
      avg30: f.w30.value(),
      avg30_last_month: f.lastMonth.value(),
      median,
      anomalies: anomaliesOf(merged),
    });
  }
  return out;
}

/**
 * The window aggregate for `userId` at `now`. `rankUnqualified` is the
 * ladder CASE over unqualified `"type"` / `"source"` built from
 * `priorityJson`, which also names the closed block.
 */
export async function readCanonicalWindow(
  userId: string,
  now: Date,
  priorityJson: unknown,
  rankUnqualified: string,
): Promise<CanonicalWindowRow[]> {
  const cuts = windowCuts(now);
  const method = activePulseDayMeanMethod();
  const [block, edge] = await Promise.all([
    readClosedWindow(userId, cuts, priorityJson, rankUnqualified),
    prisma.$queryRawUnsafe<EdgeCellRow[]>(
      edgeWindowSql(rankUnqualified),
      userId,
      now,
      cuts.blockFrom,
      cuts.blockTo,
      cuts.hour7,
      cuts.hour30,
      cuts.hour60,
    ),
  ]);
  return composeCanonicalWindow(block, edge, cuts, method);
}
