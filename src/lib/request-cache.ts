/**
 * v1.4.33 — per-request memoisation carrier.
 *
 * Multiple gated routes share the same in-process request lifecycle
 * (api-handler wraps every handler in `eventStorage.run(builder, …)`),
 * yet the gate helpers and snapshot builders re-read the same row on
 * every call. The Coach drawer opening fires five fetches in parallel,
 * each of which resolves the AI capabilities —
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

export interface MemoizeOptions {
  /**
   * Read afresh on every call inside a background event.
   *
   * A request is short and acts for one record, so one read of the operator's
   * switches serves all of it. A background job opens one wide event for its
   * whole run, and a nightly pass loops over every user inside it: a cached
   * switch, module map, provider presence or consent set would be the answer
   * from the start of the run, served to every later user and to the wire
   * re-check, so turning the Assistant off at 02:05 would not stop the pass
   * that began at 02:00. Every input that decides whether AI work may run
   * sets this.
   */
  freshInBackground?: boolean;
  /**
   * Memoise only inside a GET or HEAD request. A read that a write in the
   * same request may change (a registration the request is updating, a
   * preference it just stored) is shared between the readers of a GET, which
   * writes nothing, and read afresh on every call anywhere else.
   */
  readsOnly?: boolean;
}

function isReadRequest(event: WideEventBuilder): boolean {
  const method = (event.getHttpMethod?.() ?? "").toUpperCase();
  return method === "GET" || method === "HEAD";
}

/**
 * Hand a row the request has already read to later readers of the same
 * request, under `key`. Only inside a GET or HEAD request, for the reason
 * `readsOnly` gives; a key already present is left alone.
 */
export function primePerRequest<T>(key: string, value: T): void {
  const event = getEvent();
  if (!event || event.getKind?.() === "background" || !isReadRequest(event)) {
    return;
  }
  const cache = getCache(event);
  if (!cache.has(key)) cache.set(key, Promise.resolve(value));
}

/** What `primePerRequest` (or a memoised read) stored under `key`, if any. */
export function peekPerRequest<T>(key: string): Promise<T> | undefined {
  const event = getEvent();
  if (!event || event.getKind?.() === "background" || !isReadRequest(event)) {
    return undefined;
  }
  return getCache(event).get(key) as Promise<T> | undefined;
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
 * mounts resolve the same capabilities in parallel.
 */
export function memoizePerRequest<T>(
  key: string,
  factory: () => Promise<T>,
  options: MemoizeOptions = {},
): Promise<T> {
  const event = getEvent();
  if (!event) {
    return factory();
  }
  if (options.freshInBackground && event.getKind() === "background") {
    return factory();
  }
  if (options.readsOnly && !isReadRequest(event)) {
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
