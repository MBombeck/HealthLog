/**
 * The heap a cached value holds, estimated, and the byte budget of each
 * server-cache bucket.
 *
 * The buckets were bounded by entry count alone, and an entry can be a few
 * hundred bytes (a layout) or several megabytes (a closed window of dense
 * readings, a ten-year series). A thousand entries is therefore no bound on
 * memory at all, and on a 1 GB container the caches are one of the few
 * things whose size the code chooses. Each bucket now also carries a byte
 * budget, a share of the process's heap limit, and evicts from its
 * least-recently-used end until the estimated bytes fit.
 *
 * The estimate walks the value the way V8 lays it out, roughly: a string is
 * its length plus a header, a number eight bytes, an object its slots and
 * what they point to. It visits at most {@link VISIT_BUDGET} nodes: an array
 * longer than {@link SAMPLE} is measured on {@link SAMPLE} evenly spaced
 * elements and scaled to its length, so a 100 000-row array costs the same to
 * weigh as a ten-row one. It is a budget, not an accounting: what matters is
 * that a large value weighs large.
 */
import { getHeapStatistics } from "node:v8";

/** Elements of an array weighed before the rest is extrapolated. */
const SAMPLE = 16;
/** Nodes one estimate may visit. */
const VISIT_BUDGET = 2_000;
/** What a node the budget no longer reaches is taken to weigh. */
const UNVISITED_NODE_BYTES = 64;

const HEADER = 16;
const SLOT = 8;

/** The estimated bytes `value` holds. */
export function approxBytes(value: unknown): number {
  const state = { visits: 0 };
  return weigh(value, state, new Set());
}

function weigh(
  value: unknown,
  state: { visits: number },
  seen: Set<object>,
): number {
  if (value === null || value === undefined) return 0;
  switch (typeof value) {
    case "string":
      return HEADER + value.length;
    case "number":
    case "boolean":
    case "bigint":
    case "symbol":
      return SLOT;
    case "function":
      return 0;
  }
  const obj = value as object;
  if (seen.has(obj)) return 0;
  state.visits += 1;
  if (state.visits > VISIT_BUDGET) return UNVISITED_NODE_BYTES;
  seen.add(obj);
  if (obj instanceof Date) return HEADER + SLOT;
  if (ArrayBuffer.isView(obj)) return HEADER + obj.byteLength;
  if (obj instanceof ArrayBuffer) return HEADER + obj.byteLength;
  if (Array.isArray(obj)) return weighList(obj, state, seen);
  if (obj instanceof Map) {
    return (
      HEADER +
      weighList([...obj.keys()], state, seen) +
      weighList([...obj.values()], state, seen)
    );
  }
  if (obj instanceof Set) return HEADER + weighList([...obj], state, seen);
  let bytes = HEADER;
  for (const key of Object.keys(obj)) {
    bytes += SLOT + weigh((obj as Record<string, unknown>)[key], state, seen);
  }
  return bytes;
}

function weighList(
  list: readonly unknown[],
  state: { visits: number },
  seen: Set<object>,
): number {
  const n = list.length;
  if (n <= SAMPLE) {
    let bytes = HEADER + n * SLOT;
    for (const item of list) bytes += weigh(item, state, seen);
    return bytes;
  }
  let sampled = 0;
  for (let i = 0; i < SAMPLE; i++) {
    sampled += weigh(list[Math.floor((i * n) / SAMPLE)], state, seen);
  }
  return HEADER + n * SLOT + Math.ceil((sampled / SAMPLE) * n);
}

/**
 * Every server-cache bucket together may hold this share of the heap limit:
 * about 52 MB under the 524 MB heap of a 1 GB container, 79 MB under the
 * 792 MB of the supported 1.5 GB floor.
 */
export const CACHE_HEAP_SHARE = 0.1;

/**
 * Each bucket's part of {@link CACHE_HEAP_SHARE}. The analytics bucket holds
 * the dashboard snapshot, the series blocks and every closed window, so it
 * gets the most; the layout buckets hold a few hundred bytes per account.
 * A bucket without a share here gets {@link DEFAULT_BUCKET_SHARE}.
 */
export const CACHE_BUCKET_SHARES: Readonly<Record<string, number>> = {
  analytics: 0.4,
  insightsDerived: 0.12,
  insightsTargets: 0.08,
  medicationCompliance: 0.08,
  moodInsights: 0.06,
  medications: 0.05,
  achievements: 0.04,
  moodAnalytics: 0.04,
  medicationsIntake: 0.04,
};
export const DEFAULT_BUCKET_SHARE = 0.02;

/** The byte budget of the bucket called `name`. */
export function bucketByteBudget(
  name: string | undefined,
  heapLimitBytes: number = getHeapStatistics().heap_size_limit,
): number {
  const share =
    (name !== undefined ? CACHE_BUCKET_SHARES[name] : undefined) ??
    DEFAULT_BUCKET_SHARE;
  return Math.floor(heapLimitBytes * CACHE_HEAP_SHARE * share);
}
