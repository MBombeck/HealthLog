/**
 * Request-scoped capture of the rate-limiter's last verdict, plus the one
 * builder that turns a verdict into response headers — a LEAF module.
 *
 * It lives apart from `rate-limit.ts` on purpose. Nearly two hundred route
 * tests replace `@/lib/rate-limit` wholesale with a `vi.mock` factory, so
 * anything `apiHandler` needs from the limiter has to come from a module those
 * factories do not stand in for; otherwise the wrapper calls `undefined()` the
 * moment a mocked route is exercised.
 *
 * Why the capture exists at all: a route that refuses a request answers 429
 * from its own handler body, and most of them build that response with a bare
 * `apiError(...)`. Threading the headers through every one of those call sites
 * is 129 edits that the next new route immediately forgets. Instead the
 * limiter records its verdict here, `apiHandler` runs every handler inside the
 * store, and any 429 that leaves without headers gets them on the way out. A
 * route that already attaches them keeps exactly the response it built.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** What a rate-limit verdict has to carry to be renderable as headers. */
export interface RateLimitSnapshot {
  /** Requests allowed per window. */
  limit: number;
  /** Requests left in the current window; zero once the cap is hit. */
  remaining: number;
  /** Epoch milliseconds at which the current window rolls over. */
  resetAt: number;
}

interface RateLimitCapture {
  last: RateLimitSnapshot | null;
  denied: RateLimitSnapshot | null;
}

const storage = new AsyncLocalStorage<RateLimitCapture>();

/**
 * Run `fn` with a fresh capture cell. Called once per request by
 * `apiHandler`; outside one, every capture below is a no-op and
 * {@link capturedRateLimit} reads null.
 */
export function runWithRateLimitCapture<T>(fn: () => T): T {
  return storage.run({ last: null, denied: null }, fn);
}

/**
 * Record a limiter verdict for the request in flight.
 *
 * A denied verdict wins over an allowed one: a handler that consults two
 * buckets and is refused by the second must report the bucket that actually
 * refused it, not the one it passed.
 */
export function captureRateLimitResult(
  result: RateLimitSnapshot & { allowed: boolean },
): void {
  const store = storage.getStore();
  if (!store) return;
  store.last = result;
  if (!result.allowed) store.denied = result;
}

/** The verdict to render for this request, or null when none was taken. */
export function capturedRateLimit(): RateLimitSnapshot | null {
  const store = storage.getStore();
  if (!store) return null;
  return store.denied ?? store.last;
}

/**
 * The rate-limit response headers.
 *
 * `Retry-After` is whole seconds and rounds UP, per RFC 9110 §10.2.3: a client
 * that waits the value it is given must find the window already rolled over,
 * which flooring cannot promise. It never goes below zero — a window that
 * expired between the verdict and the response says "retry now" rather than
 * naming a time in the past.
 *
 * `X-RateLimit-Reset` keeps the ISO-8601 instant it has always carried. It is
 * the wrong convention for the header name and every other deployment uses
 * epoch or delta seconds, but it is on the wire today and changing it is a
 * contract decision of its own; `Retry-After` gives an integer-parsing client
 * the number it needs without touching the existing field.
 */
export function rateLimitResponseHeaders(
  snapshot: RateLimitSnapshot,
  now: number = Date.now(),
): Record<string, string> {
  return {
    "Retry-After": String(
      Math.max(0, Math.ceil((snapshot.resetAt - now) / 1000)),
    ),
    "X-RateLimit-Limit": String(snapshot.limit),
    "X-RateLimit-Remaining": String(snapshot.remaining),
    "X-RateLimit-Reset": new Date(snapshot.resetAt).toISOString(),
  };
}
