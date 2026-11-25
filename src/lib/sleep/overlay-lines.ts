/**
 * Chart rows for the lines drawn over the night timeline (#1419).
 *
 * The server hands every metric of a night on one grid of buckets (`from`,
 * `bucketMinutes`), so the lines share their x positions and one row per
 * bucket carries every line's value at that moment. Pure, so the gap rule
 * below is tested without rendering a chart.
 *
 * A bucket without a reading is a gap. A watch that samples every five to
 * ten minutes leaves single empty buckets all night, and a line broken at
 * each of them would read as missing data; a watch taken off for an hour
 * leaves a real gap. So a line bridges a gap up to three times its own
 * usual spacing (at least three buckets), and never one longer than its
 * metric's `maxBridgeMinutes`: a series measured about once an hour has an
 * hour as its usual spacing, and a line across those hours would draw
 * values that were never measured. Past either limit the line breaks, and a
 * reading with no line to either side is marked as a point (`soloKey`). The
 * bridged rows carry the straight line between the two readings for drawing
 * only; the value shown on hover is always a reading (`raw`).
 *
 * The rows are cut to the session (`fromMs`..`toMs`), with a row on each
 * edge so a line reaches the edge rather than stopping at the last bucket
 * inside it.
 */

export interface OverlayLineInput {
  key: string;
  points: ReadonlyArray<{ at: string; value: number }>;
  /** The longest gap between two readings a line is drawn across. */
  maxBridgeMinutes: number;
}

/** One row: `t` (epoch ms), then per line its drawn value and its reading. */
export type OverlayRow = { t: number } & Record<string, number | null>;

export interface OverlayRows {
  rows: OverlayRow[];
  /** Per line, the y domain that fills the plot with a margin. */
  domains: Record<string, [number, number]>;
}

/** The column holding a line's reading (as opposed to its drawn value). */
export function rawKey(key: string): string {
  return `${key}:raw`;
}

/** The column that is 1 on a reading no drawn line reaches. */
export function soloKey(key: string): string {
  return `${key}:solo`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function buildOverlayRows(opts: {
  lines: readonly OverlayLineInput[];
  gridFromMs: number;
  bucketMs: number;
  fromMs: number;
  toMs: number;
}): OverlayRows {
  const { gridFromMs, bucketMs, fromMs, toMs } = opts;
  const drawn = new Map<string, Map<number, number>>();
  const raw = new Map<string, Map<number, number>>();
  const domains: Record<string, [number, number]> = {};
  let lastIdx = Math.ceil((toMs - gridFromMs) / bucketMs);

  for (const line of opts.lines) {
    const readings = new Map<number, number>();
    for (const p of line.points) {
      const at = Date.parse(p.at);
      if (!Number.isFinite(at) || !Number.isFinite(p.value)) continue;
      readings.set(Math.round((at - gridFromMs) / bucketMs), p.value);
    }
    const idxs = [...readings.keys()].sort((a, b) => a - b);
    const values = new Map(readings);
    if (idxs.length >= 2) {
      const steps = idxs.slice(1).map((idx, i) => idx - idxs[i]!);
      const ceiling = Math.max(
        1,
        Math.floor((line.maxBridgeMinutes * 60_000) / bucketMs),
      );
      const maxGap = Math.min(Math.max(3, 3 * median(steps)), ceiling);
      for (let i = 1; i < idxs.length; i++) {
        const a = idxs[i - 1]!;
        const b = idxs[i]!;
        if (b - a <= 1 || b - a > maxGap) continue;
        const va = readings.get(a)!;
        const vb = readings.get(b)!;
        for (let k = a + 1; k < b; k++) {
          values.set(k, va + ((vb - va) * (k - a)) / (b - a));
        }
      }
    }
    drawn.set(line.key, values);
    raw.set(line.key, readings);
    if (idxs.length > 0) lastIdx = Math.max(lastIdx, idxs[idxs.length - 1]!);
    const all = [...readings.values()];
    if (all.length > 0) {
      const lo = Math.min(...all);
      const hi = Math.max(...all);
      const pad = Math.max((hi - lo) * 0.15, Math.abs(hi) * 0.02, 0.5);
      domains[line.key] = [lo - pad, hi + pad];
    }
  }

  const rowAt = (t: number, idx: number | null): OverlayRow => {
    const row: OverlayRow = { t } as OverlayRow;
    for (const line of opts.lines) {
      const values = drawn.get(line.key)!;
      if (idx !== null) {
        const reading = raw.get(line.key)!.get(idx);
        row[line.key] = values.get(idx) ?? null;
        row[rawKey(line.key)] = reading ?? null;
        row[soloKey(line.key)] =
          reading !== undefined && !values.has(idx - 1) && !values.has(idx + 1)
            ? 1
            : null;
        continue;
      }
      // An edge between two buckets: the straight line between them, when
      // the line runs through both.
      const pos = (t - gridFromMs) / bucketMs;
      const a = values.get(Math.floor(pos));
      const b = values.get(Math.ceil(pos));
      row[line.key] =
        a !== undefined && b !== undefined
          ? a + (b - a) * (pos - Math.floor(pos))
          : null;
      row[rawKey(line.key)] = null;
      row[soloKey(line.key)] = null;
    }
    return row;
  };

  const rows: OverlayRow[] = [];
  const firstIdx = Math.ceil((fromMs - gridFromMs) / bucketMs);
  if (gridFromMs + firstIdx * bucketMs !== fromMs)
    rows.push(rowAt(fromMs, null));
  for (let idx = Math.max(0, firstIdx); idx <= lastIdx; idx++) {
    const t = gridFromMs + idx * bucketMs;
    if (t > toMs) break;
    rows.push(rowAt(t, idx));
  }
  if (rows.length === 0 || rows[rows.length - 1]!.t !== toMs) {
    rows.push(rowAt(toMs, null));
  }
  return { rows, domains };
}
