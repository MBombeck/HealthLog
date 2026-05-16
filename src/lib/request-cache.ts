/**
 * v1.4.33 — per-request memoisation carrier.
 *
 * Multiple gated routes share the same in-process request lifecycle
 * (api-handler wraps every handler in `eventStorage.run(builder, …)`),
 * yet the gate helpers and snapshot builders re-read the same row on
 * every call. The Coach drawer opening fires five fetches in parallel,
 * each of which lands a `requireAssistantSurface("coach")` call —
 * five separate `SELECT` against `AppSettings.singleton` for the same
 * value within the same wall-clock millisecond.
 *
 * This helper attaches a request-scoped `Map<string, Promise<unknown>>`
 * to the active `WideEventBuilder` from `@/lib/logging/context`. Same
 * key inside one request = one compute; different requests get
 * independent caches; outside any request (e.g. tests with no event
 * context) the factory runs every time so behaviour is unchanged.
 *
 * The cache is keyed by string. Callers compose composite keys (e.g.
 * `"assistant-flags"` or `"coach-snapshot:${userId}:${windowKey}"`).
 * The cache is intentionally weak: it lives on the event builder
 * itself via a `WeakMap`, so it goes away as soon as the request
 * finishes and the builder is collected.
 */
import { getEvent } from "@/lib/logging/context";
import type { WideEventBuilder } from "@/lib/logging/event-builder";

const REQUEST_CACHES = new WeakMap<WideEventBuilder, Map<string, unknown>>();

function getCache(builder: WideEventBuilder): Map<string, unknown> {
  let cache = REQUEST_CACHES.get(builder);
  if (!cache) {
    cache = new Map<string, unknown>();
    REQUEST_CACHES.set(builder, cache);
  }
  return cache;
}

/**
 * Memoise `factory()` for the lifetime of the current request. Returns
 * the factory's result directly when no event context is active so
 * unit tests and background jobs that don't enter `eventStorage.run()`
 * keep their existing semantics.
 *
 * The cached value is the Promise itself, so concurrent callers within
 * the same request await one outstanding compute instead of starting
 * their own — important for the gate-cascade pattern where five
 * mounts fire `requireAssistantSurface()` in parallel.
 */
export function memoizePerRequest<T>(
  key: string,
  factory: () => Promise<T>,
): Promise<T> {
  const event = getEvent();
  if (!event) {
    return factory();
  }
  const cache = getCache(event);
  const existing = cache.get(key);
  if (existing !== undefined) {
    return existing as Promise<T>;
  }
  const promise = factory();
  cache.set(key, promise);
  // If the factory rejects, evict so a retry on the same key inside
  // this request gets a fresh attempt. Cached failures inside a single
  // request would mask real recovery (e.g. transient DB hiccup).
  promise.catch(() => {
    if (cache.get(key) === promise) {
      cache.delete(key);
    }
  });
  return promise;
}
