/**
 * v1.4.34 IW-G — in-process LRU + single-flight server cache.
 *
 * Generalises the v1.4.33 Coach snapshot cache shape
 * (`src/lib/ai/coach/snapshot.ts:292-336`, commit `af17db5d`) into a
 * reusable primitive. A `Map` gives insertion-order iteration for LRU touch,
 * entry-count and optional weighted caps bound memory, and a `pending` map
 * lets concurrent reads of the same cold key share one builder call.
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

import type { WorkoutsProjection } from "@/lib/workouts/list-read";

export interface ServerCacheOptions<T = unknown> {
  /** Hard cap on entries. Oldest entry is evicted on overflow. */
  readonly maxEntries: number;
  /** Time-to-live in milliseconds. Expired entries miss on read. */
  readonly ttlMs: number;
  /**
   * Optional hard cap on the combined weight of resident entries.
   * Entries are evicted from the LRU end until both caps are satisfied.
   */
  readonly maxWeight?: number;
  /**
   * Returns a positive capacity weight for one entry. Defaults to 1, making
   * `maxWeight` equivalent to a second entry-count cap when omitted.
   */
  readonly weightOf?: (value: T, key: string) => number;
  /**
   * v1.12.1 — stale-while-revalidate window in milliseconds. When set,
   * an entry whose `ttlMs` has lapsed but is still inside
   * `ttlMs + staleTtlMs` is served immediately (stale) by `wrapSwr()`,
   * which kicks off a single background recompute to refresh it. Past
   * the stale window the entry is a hard miss like any other. Leave
   * unset for the legacy hard-TTL behaviour.
   */
  readonly staleTtlMs?: number;
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

/**
 * v1.16.9 — single-flight slot with invalidation fencing. A builder that
 * was in flight when an invalidation (`delete` / `deleteByPrefix` /
 * `markStaleByPrefix`) hit its key must NOT commit its result: the build
 * read pre-write data, and committing it after the eviction would
 * re-cache the pre-write body as fresh for the full TTL. The slot is the
 * fence — invalidation flips `invalidated` and detaches the slot from
 * `pending`, so (a) the builder's `.then` skips the `set()` and (b) the
 * next read starts a fresh build instead of joining the stale one.
 * Callers already awaiting the detached promise still receive its value
 * (equivalent to having read a moment before the write); it just never
 * enters the cache.
 */
interface PendingBuild<T> {
  promise: Promise<T>;
  invalidated: boolean;
}

export class ServerCache<T> {
  private readonly map = new Map<
    string,
    { expiresAt: number; staleUntil: number; value: T; weight: number }
  >();
  private readonly pending = new Map<string, PendingBuild<T>>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private stampedes = 0;
  private totalWeight = 0;

  constructor(private readonly opts: ServerCacheOptions<T>) {}

  /**
   * Fence + detach the in-flight builder for one key (no-op when none).
   * Part of every invalidation op — see `PendingBuild`.
   */
  private detachPending(key: string): void {
    const slot = this.pending.get(key);
    if (slot) {
      slot.invalidated = true;
      this.pending.delete(key);
    }
  }

  /** Fence + detach every in-flight builder under `prefix`. */
  private detachPendingByPrefix(prefix: string): void {
    for (const [key, slot] of this.pending) {
      if (key.startsWith(prefix)) {
        slot.invalidated = true;
        this.pending.delete(key);
      }
    }
  }

  /**
   * Register a fenced single-flight build for `key`. The commit only
   * lands when no invalidation hit the key while the builder ran; the
   * `finally` only clears the slot it owns (an invalidation may already
   * have detached it and a newer build may occupy the key).
   */
  private startBuild(
    key: string,
    builder: () => Promise<T>,
    ttlMsOverride?: number,
  ): PendingBuild<T> {
    const slot: PendingBuild<T> = {
      promise: undefined as unknown as Promise<T>,
      invalidated: false,
    };
    slot.promise = builder()
      .then((value) => {
        if (!slot.invalidated) {
          this.set(key, value, ttlMsOverride);
        }
        return value;
      })
      .finally(() => {
        if (this.pending.get(key) === slot) {
          this.pending.delete(key);
        }
      });
    this.pending.set(key, slot);
    return slot;
  }

  /**
   * Read a key. Returns null on miss, expired entry, or absent entry.
   * Side effect: an expired entry is removed; a live entry is
   * LRU-touched (re-inserted) so subsequent reads keep it warm.
   *
   * Does NOT increment `hits`/`misses` — those live on the
   * `wrap()` path because the bare `get` is also called from tests
   * and from the test escape hatch.
   */
  private entryWeight(key: string, value: T): number {
    if (this.opts.maxWeight === undefined) return 1;
    const weight = this.opts.weightOf?.(value, key) ?? 1;
    return Number.isFinite(weight) && weight > 0 ? Math.ceil(weight) : 1;
  }

  get(key: string): T | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      this.totalWeight -= entry.weight;
      return null;
    }
    // LRU touch — re-insertion moves the key to the end of the Map's
    // iteration order (which is the most-recently-used end).
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /**
   * Insert or overwrite. Evicts least-recently-used entries until every
   * configured capacity limit is satisfied.
   * `ttlMsOverride` lets a single key carry a longer (or shorter) TTL
   * than the bucket default without splitting it into a separate cache
   * instance — used by the dashboard-snapshot key, which must outlive
   * the 60 s analytics default so the client's 120 s refetch interval
   * lands on a warm entry, while still sharing the bucket's `${userId}|`
   * prefix-sweep invalidation.
   */
  set(key: string, value: T, ttlMsOverride?: number): void {
    const weight = this.entryWeight(key, value);
    if (this.opts.maxWeight !== undefined && weight > this.opts.maxWeight) {
      return;
    }
    // The key might already exist. Remove its old weight before replacing it,
    // then reinsert at the most-recently-used end.
    const existing = this.map.get(key);
    if (existing) {
      this.map.delete(key);
      this.totalWeight -= existing.weight;
    }
    const now = Date.now();
    const expiresAt = now + (ttlMsOverride ?? this.opts.ttlMs);
    this.map.set(key, {
      expiresAt,
      // The stale window extends past the fresh TTL only when the
      // bucket opted into SWR; otherwise `staleUntil === expiresAt`
      // so `getAllowStale` behaves exactly like `get`.
      staleUntil: expiresAt + (this.opts.staleTtlMs ?? 0),
      value,
      weight,
    });
    this.totalWeight += weight;

    while (
      this.map.size > this.opts.maxEntries ||
      (this.opts.maxWeight !== undefined &&
        this.totalWeight > this.opts.maxWeight)
    ) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.map.get(oldest);
      this.map.delete(oldest);
      this.totalWeight -= evicted?.weight ?? 0;
      this.evictions += 1;
    }
  }

  /**
   * v1.12.1 — read a key allowing a stale entry inside the SWR window.
   * Returns the value plus a `stale` flag (true when the fresh TTL has
   * lapsed but the entry is still inside `staleTtlMs`). Past the stale
   * window the entry is removed and `null` is returned. LRU-touches a
   * live or stale entry so a hot key never falls out under pressure.
   */
  getAllowStale(key: string): { value: T; stale: boolean } | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    const now = Date.now();
    if (entry.staleUntil <= now) {
      this.map.delete(key);
      this.totalWeight -= entry.weight;
      return null;
    }
    // LRU touch.
    this.map.delete(key);
    this.map.set(key, entry);
    return { value: entry.value, stale: entry.expiresAt <= now };
  }

  /**
   * v1.12.1 — mark every entry under `prefix` stale without dropping it.
   * Collapses the fresh TTL to "now" so the next `wrapSwr` read serves
   * the prior value immediately while a single coalesced recompute warms
   * a fresh value. This replaces the hard-evict on a mood write so an
   * active logger no longer re-pays the cold compute on every entry.
   *
   * Stale-serve bound: marking does NOT touch `staleUntil`, which was
   * fixed at insert time as `insert + ttlMs + staleTtlMs`. A marked
   * entry can therefore keep serving stale until up to `ttlMs +
   * staleTtlMs` after it was INSERTED — not `staleTtlMs` after the
   * mark. (Marking near the end of the fresh window leaves close to
   * `staleTtlMs` of serveability; marking right after insert leaves
   * nearly the full `ttlMs + staleTtlMs`.) No-op for buckets without
   * `staleTtlMs` (the entry is already at/over its hard TTL after this,
   * so the next read is a clean miss — identical to the old evict
   * behaviour).
   */
  markStaleByPrefix(prefix: string): number {
    // v1.16.9 — fence in-flight builders too: a refresh that started
    // before the write would otherwise complete after this mark and
    // re-cache the pre-write body as FRESH for the full TTL. Detaching
    // keeps the SWR contract — the marked entry still serves stale, and
    // the next read kicks off a fresh (post-write) recompute.
    this.detachPendingByPrefix(prefix);
    let marked = 0;
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (key.startsWith(prefix)) {
        entry.expiresAt = now;
        marked += 1;
      }
    }
    return marked;
  }

  /** Single-key eviction. Returns true when the key was present. */
  delete(key: string): boolean {
    // v1.16.9 — fence the in-flight builder so a pre-write build can
    // neither be joined by post-evict reads nor commit its result.
    this.detachPending(key);
    const entry = this.map.get(key);
    const removed = this.map.delete(key);
    if (removed && entry) this.totalWeight -= entry.weight;
    return removed;
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
    // v1.16.9 — fence in-flight builders under the prefix (see `delete`).
    this.detachPendingByPrefix(prefix);
    let removed = 0;
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) {
        const entry = this.map.get(key);
        this.map.delete(key);
        this.totalWeight -= entry?.weight ?? 0;
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
      const value = await inFlight.promise;
      return { value, outcome: "stampede" };
    }

    this.misses += 1;
    const slot = this.startBuild(key, builder, ttlMsOverride);
    const value = await slot.promise;
    return { value, outcome: "miss" };
  }

  /**
   * v1.12.1 — stale-while-revalidate read. On a fresh hit it returns the
   * cached value like `wrap`. On a stale hit (entry past its fresh TTL
   * but inside the SWR window) it returns the prior value IMMEDIATELY
   * and kicks off a single background recompute — the active caller
   * never pays the cold compute. On a hard miss / cold key it falls back
   * to `wrap`'s single-flight builder and awaits it.
   *
   * Background revalidation reuses the `pending` single-flight slot so a
   * burst of stale reads coalesces into one recompute. A rejected
   * background build is swallowed (the stale value already served) and
   * clears `pending` so the next read retries.
   */
  async wrapSwr(
    key: string,
    builder: () => Promise<T>,
    ttlMsOverride?: number,
  ): Promise<{
    value: T;
    outcome: "hit" | "stale" | "miss" | "stampede";
  }> {
    const cachedEntry = this.getAllowStale(key);
    if (cachedEntry && !cachedEntry.stale) {
      this.hits += 1;
      return { value: cachedEntry.value, outcome: "hit" };
    }

    if (cachedEntry && cachedEntry.stale) {
      // Serve stale now; revalidate in the background under the
      // single-flight slot so concurrent stale reads share one rebuild.
      this.hits += 1;
      if (!this.pending.has(key)) {
        // v1.16.9 — the background refresh runs through the same fenced
        // single-flight slot as `wrap`, so an invalidation that lands
        // while it is in flight discards its (pre-write) result instead
        // of re-caching it as fresh.
        const refresh = this.startBuild(key, builder, ttlMsOverride).promise;
        // Detach: the foreground caller does not await the rebuild.
        // Handle the rejection on the detached handle so an
        // unhandled-rejection warning never fires — but never silently:
        // a refresh that keeps failing means the bucket serves an
        // ever-older stale value until the SWR window finally lapses,
        // so the failure must reach the logs. There is no request
        // context here (the caller already returned), so a structured
        // console.error stands in for the wide-event annotation; the
        // key is logged as its djb2 hash, matching the cache-outcome
        // meta convention, so the userId segment never reaches stdout.
        refresh.catch((err) => {
          console.error(
            `cache.${this.opts.name ?? "unnamed"}.refresh_failed`,
            JSON.stringify({
              key_hash: hashCacheKey(key),
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        });
      }
      return { value: cachedEntry.value, outcome: "stale" };
    }

    // Hard miss / cold key — fall back to the awaited single-flight path.
    return this.wrap(key, builder, ttlMsOverride);
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
    this.totalWeight = 0;
    // Fence any in-flight builder so a build crossing a test boundary
    // cannot commit into the next test's clean cache.
    for (const slot of this.pending.values()) {
      slot.invalidated = true;
    }
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
 * `/api/dashboard/widgets`, `/api/workouts`,
 * `/api/mood/analytics`) without churning the helper module.
 */
export const caches = {
  /**
   * Slim / thick analytics cells, the iOS summary cell, the dashboard
   * summary, AND the unified dashboard first-paint snapshot (per-key TTL
   * override). 60 s fresh TTL keeps multiple sub-page mounts inside a
   * minute on a warm entry.
   *
   * v1.12.7 — stale-while-revalidate window. The snapshot read uses
   * `cachedSwr` and a measurement write marks the bucket stale (not a
   * hard evict) via `invalidateUserMeasurements`, so a high-frequency
   * iOS Apple-Health sync no longer busts the snapshot into a cold
   * rebuild on every batch (the v1.8.7 "sync evicting the cache all day"
   * class, on the dashboard snapshot). Slim / thick / summary cells read
   * via plain `cached` are unaffected: a marked-stale entry has
   * `expiresAt === now`, so their next `cached` read is a clean miss and
   * rebuilds fresh — only the `cachedSwr` snapshot serves stale + warms a
   * background recompute. The stale window bounds how old a served
   * snapshot can be when no reader triggers a revalidation.
   *
   * v1.16.12 — stale window widened 10 min → 1 h. A single self-hoster
   * visits the dashboard / insights every ~20-30 min; the old 10-minute
   * window meant nearly every return landed PAST it (a `miss`, ~1.5 s of
   * synchronous rebuild) instead of inside it (a `stale`, instant + one
   * background refresh). Each stale-serve re-inserts, so an active session
   * stays warm regardless of the exact window; the value only governs how
   * long an ABSENCE still gets an instant response. 1 h covers a normal
   * break while keeping the dashboard's time-derived `nextDueOverdue` /
   * tally drift bounded — and that field already self-corrects within the
   * snapshot client's 120 s poll and the immediate background refresh.
   */
  analytics: new ServerCache<unknown>({
    name: "analytics",
    maxEntries: 1000,
    ttlMs: 60_000,
    staleTtlMs: 3_600_000,
  }),
  /**
   * v1.16.8 — stale-while-revalidate on the list bucket. The 60 s fresh
   * TTL meant every visit minutes apart paid the full cold list build
   * (five parallel reads + the next-due engine per medication). The list
   * GET reads via `cachedSwr` now: inside the 10-minute stale window the
   * prior list serves immediately while one background recompute warms a
   * fresh one. Interactive writes hard-evict the bucket through
   * `invalidateUserMedications({ evict: true })`, so the window only
   * bounds wall-clock drift (`todayEventCount`, `nextDueAt`), never
   * user-action staleness.
   */
  medications: new ServerCache<unknown>({
    name: "medications",
    maxEntries: 1000,
    ttlMs: 60_000,
    staleTtlMs: 600_000,
  }),
  /**
   * v1.18.11 (W5 perf) — stale-while-revalidate window. The
   * `AchievementUnlockNotifier` is mounted on every authenticated page and
   * polls this endpoint every 2 minutes. Against a 60 s hard-TTL bucket
   * that poll always landed on an expired entry, firing a cold ~400 ms
   * rebuild on every session every 2 minutes. With a stale window the poll
   * (and the inline `/achievements` page mount) serves the prior payload
   * instantly while one coalesced background recompute refreshes it.
   *
   * SWR is safe here: the route persists `pendingUnlocks` OUTSIDE the
   * cached factory (idempotent `createMany({ skipDuplicates: true })`), so
   * serving a stale body never skips an unlock write. The 10-minute window
   * mirrors the `medications` bucket; measurement / mood / medication /
   * intake writes invalidate the `${userId}|` prefix so a user's own
   * action still surfaces on the next read.
   */
  achievements: new ServerCache<unknown>({
    name: "achievements",
    maxEntries: 1000,
    ttlMs: 60_000,
    staleTtlMs: 600_000,
  }),
  dashboardWidgets: new ServerCache<unknown>({
    name: "dashboardWidgets",
    maxEntries: 500,
    ttlMs: 300_000,
  }),
  // Retain at most 50k canonical workout rows across all filter projections.
  // The selected row shape is fixed and narrow, so row count is a stable
  // byte proxy without serializing or walking every field on each cache set.
  // A projection larger than the entire budget is returned to its caller but
  // immediately evicted rather than monopolizing process memory.
  workouts: new ServerCache<WorkoutsProjection>({
    name: "workouts",
    maxEntries: 1000,
    // A row-weight budget prevents a handful of full-history projections
    // from looking as cheap as tiny lists under the entry-count cap.
    maxWeight: 50_000,
    ttlMs: 60_000,
    weightOf: (projection) => Math.max(1, projection.canonical.length),
  }),
  medicationsIntake: new ServerCache<unknown>({
    name: "medicationsIntake",
    maxEntries: 1000,
    ttlMs: 900_000,
  }),
  /**
   * v1.15.20 — per-medication compliance payload
   * (`GET /api/medications/[id]/compliance`). The medications list fans
   * the endpoint out once per card, and each cold build runs the full
   * band-expansion pass — so the warm path has to live server-side.
   * Keyed `${userId}|${medicationId}|compliance|${userTz}` (the payload's
   * day buckets derive from the user timezone, so a timezone change must
   * miss rather than serve the previous zone's buckets); every intake /
   * medication write flushes the `${userId}|` prefix via
   * `invalidateUserMedications`, so the 15-minute TTL only bounds
   * wall-clock drift (a dose flipping overdue), never user-action
   * staleness. Sized for a few hundred users × a handful of meds.
   *
   * v1.16.8 — stale-while-revalidate. Both compliance routes (the per-id
   * detail read and the batched card read) consume via `cachedSwr`:
   * inside the 10-minute stale window an expired cell serves the prior
   * payload immediately while one coalesced rebuild warms it. Interactive
   * intake / medication writes — including the iOS bulk-intake endpoint,
   * which carries the phone user's own taken/skipped doses — hard-evict
   * (the user must see their own dose on the next read); the genuinely
   * background writers (the auto-miss cron, slot dedup) mark stale so a
   * high-frequency pass never busts every card into an inline cold
   * rebuild.
   */
  medicationCompliance: new ServerCache<unknown>({
    name: "medicationCompliance",
    maxEntries: 2000,
    ttlMs: 900_000,
    staleTtlMs: 600_000,
  }),
  moodAnalytics: new ServerCache<unknown>({
    name: "moodAnalytics",
    maxEntries: 1000,
    ttlMs: 60_000,
  }),
  /**
   * v1.8.5 — pre-computed mood-insights aggregates (heatmap, distribution,
   * weekday, tags, cross-metric correlations) for the Mood Insights page.
   * Read on every `/insights/mood` mount; bounded 365-day live read behind
   * the cache. 60 s fresh TTL matches `moodAnalytics`.
   *
   * v1.12.1 — stale-while-revalidate. The read route uses `cachedSwr` and
   * a mood write marks the bucket stale (not a hard evict) via
   * `invalidateUserMood`. An active logger now serves the prior aggregate
   * immediately while a single background recompute warms a fresh one,
   * instead of re-paying the multi-second cold compute on every entry
   * (the v1.8.7 "sync evicting the cache all day" class, on mood). The
   * 10-minute stale window bounds how old a served aggregate can be when
   * no reader has triggered a revalidation.
   */
  moodInsights: new ServerCache<unknown>({
    name: "moodInsights",
    maxEntries: 1000,
    ttlMs: 60_000,
    staleTtlMs: 600_000,
  }),
  /**
   * v1.4.36 W1 — `/api/insights/targets` is read on every Insights
   * mount and runs >1 s cold (it pulls 30-day measurements for every
   * type + medications + intakes + mood + glucose). 60 s TTL matches
   * the analytics cache so multiple sub-page mounts inside a minute
   * all hit a warm cache. Invalidated alongside the analytics bucket
   * on measurement / mood / medication writes.
   *
   * v1.16.8 — stale-while-revalidate. The 60 s fresh TTL meant every
   * Insights mount more than a minute after the last one re-paid the
   * full multi-query build inline (>1 s cold). The route reads via
   * `cachedSwr` now: inside the 10-minute stale window the prior body
   * serves immediately while one coalesced background rebuild warms a
   * fresh one. Writes keep their hard evict (`deleteByPrefix`) so a
   * user's own measurement / mood / medication action is always
   * reflected on the very next read — the window only bounds
   * wall-clock drift, never user-action staleness.
   */
  insightsTargets: new ServerCache<unknown>({
    name: "insightsTargets",
    maxEntries: 1000,
    ttlMs: 60_000,
    staleTtlMs: 600_000,
  }),
  /**
   * v1.16.8 — batched derived-wellness payload
   * (`GET /api/insights/derived/batch`). The Insights overview reads
   * ~16 metric computes in one request; each cold build walks the
   * rollup tier per metric and lands at 1–2 s wall-clock even under the
   * bounded `p-limit(4)` fan-out. Keyed
   * `${userId}|batch|${sortedTokens}|${locale}` so the overview's one
   * canonical token set always lands on one cell. Measurement writes
   * cover it through `invalidateUserMeasurements` (evict on interactive
   * writes, mark-stale on background syncs); mood writes mark it stale
   * (READINESS folds the mood series in). Stale-while-revalidate keeps
   * any repeat read inside the 10-minute window instant while one
   * background recompute refreshes the cell.
   */
  insightsDerived: new ServerCache<unknown>({
    name: "insightsDerived",
    maxEntries: 2000,
    ttlMs: 60_000,
    // v1.16.12 — 10 min → 1 h, same rationale as the analytics bucket: the
    // derived-insight aggregates are trend data (no time-critical due
    // state), so a returning visitor serves an instant stale payload +
    // background refresh instead of a ~1.1 s cold rebuild.
    staleTtlMs: 3_600_000,
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
  /**
   * v1.16.10 — per-user medications list presentation (view choice +
   * manual order). Mirrors `insightsLayout` (same 5-minute TTL, same
   * per-user bucket size). Read on every /medications mount; changes
   * only on a view toggle / order save, which invalidates via
   * `invalidateUserMedicationListLayout()`.
   */
  medicationListLayout: new ServerCache<unknown>({
    name: "medicationListLayout",
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

/**
 * v1.12.1 — stale-while-revalidate read-through. Same observability
 * contract as `cached` (annotates the wide-event with the outcome +
 * key hash) but routes through `wrapSwr`: a stale entry inside the
 * bucket's `staleTtlMs` window is served immediately while a single
 * background recompute refreshes it, so an active caller never pays
 * the cold compute on an expired or freshly-marked-stale bucket.
 */
export async function cachedSwr<T>(
  cache: ServerCache<T>,
  key: string,
  builder: () => Promise<T>,
  annotateFn?: (fields: { meta: Record<string, unknown> }) => void,
  ttlMsOverride?: number,
): Promise<T> {
  const { value } = await cachedSwrWithMeta(
    cache,
    key,
    builder,
    annotateFn,
    ttlMsOverride,
  );
  return value;
}

/**
 * v1.16.7 — `cachedSwr` variant that also surfaces the read outcome so
 * a route can mark a stale-served response (`outcome === "stale"`) as
 * `revalidating` for the client. Non-breaking addition: `cachedSwr`
 * keeps its value-only shape and delegates here.
 */
export async function cachedSwrWithMeta<T>(
  cache: ServerCache<T>,
  key: string,
  builder: () => Promise<T>,
  annotateFn?: (fields: { meta: Record<string, unknown> }) => void,
  ttlMsOverride?: number,
): Promise<{ value: T; outcome: "hit" | "stale" | "miss" | "stampede" }> {
  const { value, outcome } = await cache.wrapSwr(key, builder, ttlMsOverride);
  if (annotateFn) {
    const name = cache.stats().name;
    annotateFn({
      meta: {
        [`cache.${name}.outcome`]: outcome,
        [`cache.${name}.key_hash`]: hashCacheKey(key),
      },
    });
  }
  return { value, outcome };
}

/** Test helper — reset every cache in the registry. */
export function __resetAllCachesForTests(): void {
  for (const cache of Object.values(caches)) {
    cache.__resetForTests();
  }
}
