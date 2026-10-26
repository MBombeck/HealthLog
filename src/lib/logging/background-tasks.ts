/**
 * The registry of detached background work, so a test can await what a
 * request-path shortcut deliberately does not.
 *
 * ## The failure this exists for
 *
 * Several code paths start a promise and return without awaiting it, then log
 * on the detached handle so the failure is not swallowed — `fireAndForget`,
 * the stale-while-revalidate cache refresh, the offline query persister. That
 * is right for production and hostile to a test runner: vitest replaces
 * `globalThis.console` with a sink that forwards every write to the main
 * thread as an `onUserConsoleLog` RPC call, and when a worker finishes a test
 * file it awaits the calls in flight and then REJECTS whatever was started
 * after that point. A detached write that lands in the window between those
 * two steps fails the entire run with
 *
 *   EnvironmentTeardownError: [vitest-worker]: Closing rpc while
 *   "onUserConsoleLog" was pending
 *
 * blamed on the file the worker was tearing down — which need not contain a
 * single console call of its own, and never points at the test that started
 * the work. Muting the console in tests would hide the log line the detached
 * path exists to produce and leave the race in place; awaiting the work
 * removes the precondition.
 *
 * ## Why the registry is test-only
 *
 * Production never awaits it, so tracking there would buy nothing and cost
 * something real: a strong reference to every background promise for as long
 * as it stays unsettled. One wedged task on a long-lived pg-boss worker would
 * then be retained for the life of the process, which turns an observability
 * affordance into a slow leak. Under test the worker is short-lived and the
 * set is drained after every test, so neither concern applies. Outside test
 * every call site keeps exactly the behaviour and cost it had before — start
 * the promise, discard the handle, one boolean check.
 *
 * The module deliberately imports nothing: it is reachable from client code
 * (`lib/pwa/query-persister.ts`) as well as from the server tree, and must not
 * drag `node:async_hooks` into the browser bundle the way `./context` would.
 */
const TRACK_IN_FLIGHT =
  typeof process !== "undefined" &&
  (process.env?.VITEST === "true" || process.env?.NODE_ENV === "test");

const inFlight = new Set<Promise<unknown>>();

/**
 * Register a detached promise so `settleBackgroundTasks()` can await it.
 *
 * Pass a handle that CANNOT reject — the `.catch(...)` result, not the raw
 * work. A rejecting handle would surface as an unhandled rejection through the
 * bookkeeping below, which is a louder signal than this helper should invent.
 *
 * A no-op outside test.
 */
export function trackBackgroundTask(settled: Promise<unknown>): void {
  if (!TRACK_IN_FLIGHT) return;

  // A test double that stands in for the background work often returns
  // nothing at all. Filed as is, `undefined` would never leave the set and
  // `settleBackgroundTasks` would spin on it forever at full CPU. A real
  // promise passes through `Promise.resolve` as the same object.
  const handle = Promise.resolve(settled);
  inFlight.add(handle);
  void handle.finally(() => {
    inFlight.delete(handle);
  });
}

/**
 * Await every registered task still in flight, including work that a settling
 * task starts itself.
 *
 * Both suite setups call this from `afterEach`, so no test can leave
 * background work running past its own end. A no-op outside test, where
 * nothing registers.
 */
export async function settleBackgroundTasks(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

/**
 * How many tasks are registered right now. Test-only introspection for the
 * registration guard, which asserts both that a task registers and that the
 * set drains back to empty — a retained reference would otherwise pass
 * unnoticed.
 */
export function pendingBackgroundTaskCount(): number {
  return inFlight.size;
}
