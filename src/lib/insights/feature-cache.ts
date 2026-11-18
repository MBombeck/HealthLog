/**
 * v1.18.11 — request/run-scoped shared feature cache.
 *
 * The comprehensive briefing builds its feature snapshot via
 * `extractFeatures(userId, includeRaw, { sinceDays })`. That call materialises a
 * bounded measurement read + the per-type rollup folds + the all-time-extremes
 * aggregation — the most expensive read in the insight pipeline. Two patterns
 * paid for it more than once:
 *
 *   1. The on-demand route + `comprehensive-generate.ts` each run a downgrade
 *      ladder that, on an oversize payload, re-invokes
 *      `extractFeatures(userId, false, window)` with byte-identical arguments —
 *      a second (and third) full read for the same user in the same request.
 *   2. A single nightly tick warms one user's briefing and may, in the same
 *      run-scope, touch the same feature read again (e.g. a follow-on reduce
 *      stage). Without a shared object each consumer re-queried the DB.
 *
 * This module turns `extractFeatures` into a compute-ONCE-per-scope read: a
 * caller opens a scope with `withFeatureCacheScope(...)`, and every
 * `getCachedFeatures(...)` inside that scope keyed on the SAME
 * `(userId, calendar-day, includeRaw, sinceDays, inputHash)` reuses the first
 * computed object. This is an INPUT gate (compute-once + reuse), not a
 * post-build skip: the key folds a cheap input fingerprint so an unchanged
 * input set is computed once and a genuinely changed one recomputes.
 *
 * Scope discipline:
 *   - The cache lives only for the duration of the `withFeatureCacheScope`
 *     callback (an `AsyncLocalStorage` store). Outside any scope
 *     `getCachedFeatures` falls straight through to the computer — no global
 *     state, no cross-user leak, no stale-across-requests hazard.
 *   - The key is `(userId, day, includeRaw, sinceDays, inputHash)`. `day` is
 *     the user's own calendar day (v1.30.3 QA F5 — was Berlin-pinned for
 *     every user) so a scope that straddles the user's local midnight
 *     recomputes rather than serving yesterday's window. `inputHash` is a cheap
 *     count/newest fingerprint of the salient measurement + mood inputs, so a
 *     mid-scope ingest (rare, but possible on a long-running warm) recomputes
 *     instead of reusing a pre-ingest snapshot.
 *
 * The Coach owns its own snapshot builder and is deliberately NOT routed
 * through here (its snapshot layers many blocks beyond `extractFeatures`); this
 * cache is exposed as a standalone helper either could adopt without coupling.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "@/lib/db";
import { hashInsightSnapshot } from "@/lib/insights/snapshot-hash";
import { resolveUserTimezone, userDayKey } from "@/lib/tz/resolver";
import { annotate } from "@/lib/logging/context";

/** One memoised feature read, with the input fingerprint it was keyed on. */
interface CacheEntry {
  /** The resolved feature object (typed loosely — the caller re-narrows). */
  value: unknown;
  /** The salient-input fingerprint the value was computed for. */
  inputHash: string;
}

/** The per-scope store: a map from the stable key prefix to its entry. */
type FeatureCacheStore = Map<string, CacheEntry>;

const store = new AsyncLocalStorage<FeatureCacheStore>();

/**
 * Run `fn` inside a fresh feature-cache scope. Every `getCachedFeatures` call
 * made (synchronously or via awaited async work) within `fn` shares one cache.
 * Nesting reuses the innermost store, so an inner scope never shadows an outer
 * one's already-computed reads.
 */
export function withFeatureCacheScope<T>(fn: () => Promise<T>): Promise<T> {
  const existing = store.getStore();
  if (existing) return fn();
  return store.run(new Map(), fn);
}

/**
 * Cheap input fingerprint for `userId`: the newest `updated_at` of any of the
 * account's measurement rows, live or deleted. Every write stamps it (a new
 * reading, an edit, a soft delete), so a reading that lands or goes mid-scope
 * flips the hash and the read is recomputed. One backward step on the
 * `(user_id, updated_at, id)` index.
 *
 * It used to be a count and the newest reading per salient type, grouped over
 * every live row of those types: on an account with a watch's heart rate that
 * was the whole stream counted on each cached read, to protect a read that
 * was itself bounded. Best-effort: a read failure yields a sentinel hash so
 * the cache degrades to "always recompute" rather than reusing a wrong
 * object.
 */
async function computeFeatureInputHash(userId: string): Promise<string> {
  try {
    const newest = await prisma.measurement.findFirst({
      where: { userId },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { updatedAt: true, id: true },
    });
    const fingerprint = newest
      ? { updatedAt: newest.updatedAt.toISOString(), id: newest.id }
      : null;
    return hashInsightSnapshot({ featureInput: fingerprint });
  } catch {
    // A probe failure must never serve a stale object: a unique sentinel makes
    // the key miss so the caller computes fresh.
    return `nofingerprint:${Date.now()}:${Math.random()}`;
  }
}

/**
 * Compute-once-per-scope wrapper around a feature read.
 *
 * Inside a `withFeatureCacheScope`, the first call for a given
 * `(userId, day, includeRaw, sinceDays, inputHash)` runs `compute()` and stores
 * the result; subsequent calls with the same key reuse it. Outside any scope it
 * simply runs `compute()` (no caching). The returned value is whatever
 * `compute()` resolves to — callers re-narrow it to their feature type.
 *
 * The input fingerprint is probed once per call (one index step); the
 * cost is paid to GUARANTEE correctness (a mid-scope ingest recomputes). The
 * net saving is the full feature read on every cache HIT, which dwarfs the
 * fingerprint probe.
 */
export async function getCachedFeatures<T>(args: {
  userId: string;
  includeRaw: boolean;
  sinceDays: number;
  compute: () => Promise<T>;
}): Promise<T> {
  const current = store.getStore();
  if (!current) {
    // No active scope — pass straight through. This keeps the helper a no-op
    // for callers that never opened a scope (e.g. unit paths) so behaviour is
    // identical to a bare `extractFeatures`.
    return args.compute();
  }

  // v1.30.3 — the day-key rolls over at the USER'S own midnight, not
  // Berlin's, so a Coach/briefing scope spanning the user's local midnight
  // recomputes at the right instant for that user.
  const [inputHash, userTz] = await Promise.all([
    computeFeatureInputHash(args.userId),
    resolveUserTimezone(args.userId),
  ]);
  const dayKey = userDayKey(new Date(), userTz);
  const key = `${args.userId}|${dayKey}|${args.includeRaw ? "raw" : "agg"}|${args.sinceDays}`;

  const hit = current.get(key);
  if (hit && hit.inputHash === inputHash) {
    annotate({
      action: { name: "insights.feature_cache.hit" },
      meta: { since_days: args.sinceDays, include_raw: args.includeRaw },
    });
    return hit.value as T;
  }

  const value = await args.compute();
  current.set(key, { value, inputHash });
  annotate({
    action: { name: "insights.feature_cache.miss" },
    meta: { since_days: args.sinceDays, include_raw: args.includeRaw },
  });
  return value;
}
