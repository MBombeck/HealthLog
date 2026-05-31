/**
 * v1.4.34 IW-G — in-process LRU + single-flight server cache.
 *
 * Generalises the v1.4.33 Coach snapshot cache shape
 * (`src/lib/ai/coach/snapshot.ts:292-336`, commit `af17db5d`) into a
 * reusable primitive. Same recipe: `Map<string, { expiresAt, value }>`
 * gives us insertion-order iteration for LRU touch, a hard cap on
 * entries to bound memory, and a `pending` map so concurrent reads of
 * the same cold key fan into a single builder call.
 *
 * Design notes:
 *
 *   - LRU touch is `delete + set` so re-insertion moves the key to the
 *     end of the Map's iteration order. Eviction reads the first key
 *     (least-recently-touched) via `map.keys().next().value`.
 *
 *   - `wrap(key, builder)` is the only public read path. Misses register
 *     the in-flight promise on `pending` before awaiting the builder so
 *     a second caller for the same key inside the build window awaits
 *     the same promise instead of starting a duplicate read. Rejected
 *     promises remove themselves from `pending` so a transient failure
 *     doesn't poison the key.
 *
 *   - Metrics are per-instance: hits, misses, evictions, stampedes (a
 *     caller that hit the single-flight join), and capacity (current
 *     entry count). Read these via `stats()` for the wide-event
 *     annotations the route handlers attach to each request.
 *
 *   - The cache is process-local. A multi-instance Coolify deploy keeps
 *     each container's cache isolated; the TTL bounds the staleness
 *     window. The Redis migration path is sketched in the blueprint
 *     (`.planning/research/v1434-r-cache-aggregation.md` §7).
 *
 *   - `__resetForTests()` matches the snapshot pattern's escape hatch so
 *     vitest's afterEach can clear every instance between tests without
 *     reaching into the private `Map`.
 */

export interface ServerCacheOptions {
  /** Hard cap on entries. Oldest entry is evicted on overflow. */
  readonly maxEntries: number;
  /** Time-to-live in milliseconds. Expired entries miss on read. */
  readonly ttlMs: number;
  /**
   * Optional name for observability — surfaced in `stats().name` so the
   * wide-event meta keys can carry the cache identity without the
   * caller having to remember which `caches.*` instance it pulled.
   */
  readonly name?: string;
}

export interface ServerCacheStats {
  readonly name: string;
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly stampedes: number;
}

export class ServerCache<T> {
  private readonly map = new Map<string, { expiresAt: number; value: T }>();
  private readonly pending = new Map<string, Promise<T>>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private stampedes = 0;

  constructor(private readonly opts: ServerCacheOptions) {}

  /**
   * Read a key. Returns null on miss, expired entry, or absent entry.
   * Side effect: an expired entry is removed; a live entry is
   * LRU-touched (re-inserted) so subsequent reads keep it warm.
   *
   * Does NOT increment `hits`/`misses` — those live on the
   * `wrap()` path because the bare `get` is also called from tests
   * and from the test escape hatch.
   */
  get(key: string): T | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    // LRU touch — re-insertion moves the key to the end of the Map's
    // iteration order (which is the most-recently-used end).
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /**
   * Insert or overwrite. Evicts the oldest entry if the cap is hit.
   *
   * `ttlMsOverride` lets a single key carry a longer (or shorter) TTL
   * than the bucket default without splitting it into a separate cache
   * instance — used by the dashboard-snapshot key, which must outlive
   * the 60 s analytics default so the client's 120 s refetch interval
   * lands on a warm entry, while still sharing the bucket's `${userId}|`
   * prefix-sweep invalidation.
   */
  set(key: string, value: T, ttlMsOverride?: number): void {
    // The key might already exist (eviction-by-set is a write through
    // the same slot — no cap eviction needed). Delete-then-set to keep
    // the LRU ordering predictable.
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.opts.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
        this.evictions += 1;
      }
    }
    this.map.set(key, {
      expiresAt: Date.now() + (ttlMsOverride ?? this.opts.ttlMs),
      value,
    });
  }

  /** Single-key eviction. Returns true when the key was present. */
  delete(key: string): boolean {
    return this.map.delete(key);
  }

  /**
   * Bulk eviction. Removes every entry whose key starts with `prefix`.
   * Returns the count of removed entries.
   *
   * The invalidation helpers in `./invalidate.ts` use this to flush an
   * entire user-bucket from a cache without having to enumerate every
   * possible cache-key variant the user might have warmed.
   */
  deleteByPrefix(prefix: string): number {
    let removed = 0;
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) {
        this.map.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Read-through + single-flight. On a live hit, returns the cached
   * value. On a miss, either joins an in-flight builder (single-flight)
   * or kicks off a new builder, stores the result, and returns it.
   *
   * Builder rejections do NOT poison the cache — the `pending` entry
   * is removed on reject so the next caller retries.
   */
  async wrap(
    key: string,
    builder: () => Promise<T>,
    ttlMsOverride?: number,
  ): Promise<{
    value: T;
    outcome: "hit" | "miss" | "stampede";
  }> {
    const live = this.get(key);
    if (live !== null) {
      this.hits += 1;
      return { value: live, outcome: "hit" };
    }

    const inFlight = this.pending.get(key);
    if (inFlight) {
      this.stampedes += 1;
      const value = await inFlight;
      return { value, outcome: "stampede" };
    }

    this.misses += 1;
    const promise = builder()
      .then((value) => {
        this.set(key, value, ttlMsOverride);
        return value;
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, promise);
    const value = await promise;
    return { value, outcome: "miss" };
  }

  /** Snapshot of per-instance counters for the wide-event annotation. */
  stats(): ServerCacheStats {
    return {
      name: this.opts.name ?? "unnamed",
      size: this.map.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      stampedes: this.stampedes,
    };
  }

  /** Reset every counter + entry. Test-only escape hatch. */
  __resetForTests(): void {
    this.map.clear();
    this.pending.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.stampedes = 0;
  }
}

/**
 * Per-route cache instances. Module-scope so every request lands in the
 * same `Map`. Sizes match the blueprint §5 table.
 *
 * The blueprint's full eight-cache roster is provisioned so future
 * rounds can wire the remaining routes (`/api/medications`,
 * `/api/dashboard/widgets`, `/api/bugreport/status`, `/api/workouts`,
 * `/api/mood/analytics`) without churning the helper module.
 */
export const caches = {
  analytics: new ServerCache<unknown>({
    name: "analytics",
    maxEntries: 1000,
    ttlMs: 60_000,
  }),
  medications: new ServerCache<unknown>({
    name: "medications",
    maxEntries: 1000,
    ttlMs: 60_000,
  }),
  achievements: new ServerCache<unknown>({
    name: "achievements",
    maxEntries: 1000,
    ttlMs: 60_000,
  }),
  dashboardWidgets: new ServerCache<unknown>({
    name: "dashboardWidgets",
    maxEntries: 500,
    ttlMs: 300_000,
  }),
  bugreportStatus: new ServerCache<unknown>({
    name: "bugreportStatus",
    maxEntries: 10,
    ttlMs: 600_000,
  }),
  workouts: new ServerCache<unknown>({
    name: "workouts",
    maxEntries: 1000,
    ttlMs: 60_000,
  }),
  medicationsIntake: new ServerCache<unknown>({
    name: "medicationsIntake",
    maxEntries: 1000,
    ttlMs: 900_000,
  }),
  moodAnalytics: new ServerCache<unknown>({
    name: "moodAnalytics",
    maxEntries: 1000,
    ttlMs: 60_000,
  }),
  /**
   * v1.4.36 W1 — `/api/insights/targets` is read on every Insights
   * mount and runs >1 s cold (it pulls 30-day measurements for every
   * type + medications + intakes + mood + glucose). 60 s TTL matches
   * the analytics cache so multiple sub-page mounts inside a minute
   * all hit a warm cache. Invalidated alongside the analytics bucket
   * on measurement / mood / medication writes.
   */
  insightsTargets: new ServerCache<unknown>({
    name: "insightsTargets",
    maxEntries: 1000,
    ttlMs: 60_000,
  }),
  /**
   * v1.5.5 — per-user insights tile layout cache. Mirrors
   * `dashboardWidgets` (same 5-minute TTL, same per-user bucket size).
   * Read on every `/insights` mount; the layout only changes on a
   * Settings save, which invalidates this cache via
   * `invalidateUserInsightsLayout()`.
   */
  insightsLayout: new ServerCache<unknown>({
    name: "insightsLayout",
    maxEntries: 500,
    ttlMs: 300_000,
  }),
} as const;

/**
 * Non-reversible 32-bit hash of the cache key. Used in wide-event meta
 * so we can correlate hit / miss patterns without leaking the raw
 * userId portion of the key into logs.
 *
 * djb2 — public domain, two lines, matches the blueprint §8 sketch.
 */
export function hashCacheKey(key: string): number {
  let hash = 5381;
  for (let i = 0; i < key.length; i += 1) {
    hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/**
 * Read-through wrapper that also annotates the active wide-event with
 * the cache hit / miss / stampede outcome and a key hash. Matches the
 * observability contract in the blueprint §8.
 *
 * Falls back gracefully when no logging context is active (the
 * `annotate()` call is a no-op outside of `apiHandler`).
 */
export async function cached<T>(
  cache: ServerCache<T>,
  key: string,
  builder: () => Promise<T>,
  annotateFn?: (fields: { meta: Record<string, unknown> }) => void,
  ttlMsOverride?: number,
): Promise<T> {
  const { value, outcome } = await cache.wrap(key, builder, ttlMsOverride);
  if (annotateFn) {
    const name = cache.stats().name;
    annotateFn({
      meta: {
        [`cache.${name}.outcome`]: outcome,
        [`cache.${name}.key_hash`]: hashCacheKey(key),
      },
    });
  }
  return value;
}

/** Test helper — reset every cache in the registry. */
export function __resetAllCachesForTests(): void {
  for (const cache of Object.values(caches)) {
    cache.__resetForTests();
  }
}
