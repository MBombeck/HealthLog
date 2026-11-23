/**
 * The longest any entry lives: fifteen minutes. The cache is process-local
 * (see the module comment), and with `HEALTHLOG_PROCESS_TYPE=web` beside a
 * worker (`docs/self-hosting/scaling.md`) a cloud sync, a file import or a
 * restore runs in the worker, whose write tail invalidates the worker's
 * cache only. The web process serves what it holds until the entry expires,
 * so a TTL is the longest a split deployment can show a number from before
 * a write, whatever the invalidation says. A bucket TTL above it is refused
 * at construction; a per-key override above it is capped.
 */
export const PROCESS_CACHE_MAX_TTL_MS = 15 * 60_000;

/** A TTL as the cache keeps it: never above the ceiling. */
export function cappedTtl(ttlMs: number): number {
  return Math.min(ttlMs, PROCESS_CACHE_MAX_TTL_MS);
}

/** Refuse a cache bucket whose own TTL is above the ceiling. */
export function assertBucketTtl(ttlMs: number, name = ""): void {
  if (ttlMs > PROCESS_CACHE_MAX_TTL_MS) {
    throw new Error(
      `ServerCache ${name}: ttlMs ${ttlMs} is above the ` +
        `${PROCESS_CACHE_MAX_TTL_MS} ms ceiling (PROCESS_CACHE_MAX_TTL_MS)`,
    );
  }
}
