/**
 * Start work the caller does not wait for (a status re-warm, a reminder
 * enqueue, a stale-cache rebuild) so it cannot rename the event it was
 * started from.
 *
 * Detached work still runs inside the request's context: it reads the
 * request's auth for its audit rows and adds meta, warnings and external
 * calls to the request's event while that event is open. What it must not do
 * is set the event's action. Its `annotate({ action })` used to land on the
 * request's event whenever it ran before the event was emitted, so the same
 * write was logged as `measurement.create` on one request and as the
 * re-warm's `insights.status.invalidate.skipped` on the next. Under
 * `runDetached` an action from the detached work is dropped for the parent
 * event (`annotate` in ./context checks `detachedParent`); an event the work
 * opens for itself (`withBackgroundEvent`) is its own and keeps its action.
 *
 * Kept apart from ./context, which most unit tests replace wholesale: a test
 * that mocks the context still gets a working `runDetached`, which then
 * simply starts the work.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** The event a piece of detached work was started from. */
const detachedFrom = new AsyncLocalStorage<object>();

let currentEvent: () => object | null = () => null;

/** Called once by ./context with its event getter. */
export function registerDetachedEventSource(source: () => object | null): void {
  currentEvent = source;
}

/** The event the running work was detached from, if any. */
export function detachedParent(): object | undefined {
  return detachedFrom.getStore();
}

/** Start `start` detached from the current event; it runs synchronously. */
export function runDetached<T>(start: () => Promise<T>): Promise<T> {
  const parent = currentEvent();
  if (!parent) return start();
  try {
    return detachedFrom.run(parent, start);
  } catch (error) {
    return Promise.reject(error);
  }
}
