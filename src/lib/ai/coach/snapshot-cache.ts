/**
 * In-memory result cache for the Coach snapshot builder.
 *
 * v1.4.33 — 60-second in-memory cache for `buildCoachSnapshot()`. The
 * snapshot reads only persisted data; a single chat conversation sends
 * 2-4 turns within a minute and the snapshot would otherwise rebuild
 * from the same rows each turn. Caching the result for 60s shaves the
 * ~10 measurement reads + the GLP-1 / mood / intake side-fetches off
 * every turn after the first, which `.planning/round-v1433-audit-perf.md`
 * §3.3 estimates at 200-800 ms of server-side tail.
 *
 * Scope is part of the cache key so a switch from `last30days` to
 * `last7days` (or a different `sources` set) computes fresh. The map
 * is bounded at 64 entries — a multi-tenant deployment with a few
 * active power users sits well inside that ceiling even if each cycles
 * through several scopes per minute.
 *
 * Split out of `snapshot.ts` so the builder file carries only the
 * assembly logic; the public surface (`buildCoachSnapshot`,
 * `__resetCoachSnapshotCacheForTests`) stays importable from
 * `./snapshot` via re-export.
 */
import type { CoachSnapshotResult } from "./snapshot";
import type { CoachScope, CoachScopeWindow } from "./types";
import { reachCacheToken, type CoachHistoryReach } from "./history-reach";

/** Default window when the caller doesn't pass a scope. */
export const DEFAULT_WINDOW: CoachScopeWindow = "last30days";

const SNAPSHOT_TTL_MS = 60_000;
const SNAPSHOT_LRU_MAX = 64;
const snapshotCache = new Map<
  string,
  { expiresAt: number; result: CoachSnapshotResult }
>();

export function snapshotCacheKey(
  userId: string,
  scope: CoachScope | undefined,
  /**
   * The lookback limit the build honoured. Part of the key so a build read
   * without a limit (MCP) is never served to a limited Coach turn, nor the
   * other way round. No limit adds nothing, so those keys are unchanged.
   */
  reach?: CoachHistoryReach,
): string {
  // v1.7.0 — when the request pins an explicit source list, key on it.
  // Otherwise the source set is derived from the user's saved
  // `dataClusters`, which we don't read here (the cache must stay
  // I/O-free on a hit) — key on a stable `clusters` marker instead.
  // A cluster change is reflected on the next cache miss (≤60 s), the
  // same staleness window every other pref change already tolerates.
  const window = scope?.window ?? DEFAULT_WINDOW;
  const sourceList =
    scope?.sources && scope.sources.length > 0
      ? Array.from(scope.sources).sort().join(",")
      : "clusters";
  return `${userId}|${window}|${sourceList}${reachCacheToken(reach)}`;
}

export function readSnapshotCache(key: string): CoachSnapshotResult | null {
  const entry = snapshotCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    snapshotCache.delete(key);
    return null;
  }
  // Touch for LRU — re-insert moves to the end of the Map's iteration order.
  snapshotCache.delete(key);
  snapshotCache.set(key, entry);
  return entry.result;
}

export function writeSnapshotCache(
  key: string,
  result: CoachSnapshotResult,
): void {
  if (snapshotCache.size >= SNAPSHOT_LRU_MAX) {
    // Evict the oldest entry — JS Map iteration order is insertion order,
    // so the first key is the least-recently inserted/touched.
    const oldest = snapshotCache.keys().next().value;
    if (oldest !== undefined) {
      snapshotCache.delete(oldest);
    }
  }
  snapshotCache.set(key, {
    expiresAt: Date.now() + SNAPSHOT_TTL_MS,
    result,
  });
}

/** Clear the snapshot cache. Test-only escape hatch. */
export function __resetCoachSnapshotCacheForTests(): void {
  snapshotCache.clear();
}
