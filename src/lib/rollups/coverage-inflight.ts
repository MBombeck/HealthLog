/**
 * In-flight registry for `probeRollupCoverage`, kept in its own module so the
 * cache invalidators can reach it without importing the rollup read path.
 *
 * A single Coach snapshot, derived-metric batch or Insights page fans out into
 * a dozen readers that each probe the same account's coverage at the same
 * moment; one MCP `get_metrics` call was seen holding 59 of these probes open
 * on the database at once. Concurrent probes for one account now share the
 * query that is already running. Nothing is kept once it settles, and a
 * measurement write drops the entry, so a probe that starts after a write
 * always reads afresh.
 */

// Parked on `globalThis` like the Prisma client: a production build loads this
// module once per server bundle, and a write handled in one bundle must reach
// a probe started in another.
const registry = globalThis as unknown as {
  __healthlogCoverageInFlight?: Map<string, Promise<Map<string, boolean>>>;
};
const inFlight: Map<
  string,
  Promise<Map<string, boolean>>
> = (registry.__healthlogCoverageInFlight ??= new Map());

/** Join the probe already running for `userId`, or start `run` as the one. */
export function joinCoverageProbe(
  userId: string,
  run: () => Promise<Map<string, boolean>>,
): Promise<Map<string, boolean>> {
  let shared = inFlight.get(userId);
  if (!shared) {
    const started = run();
    shared = started;
    inFlight.set(userId, started);
    const release = () => {
      if (inFlight.get(userId) === started) inFlight.delete(userId);
    };
    started.then(release, release);
  }
  // Each caller gets its own map: a reader that adjusts its copy must not
  // change what the others see.
  return shared.then((coverage) => new Map(coverage));
}

/** Called on a measurement write: the next probe for the account starts afresh. */
export function forgetCoverageProbe(userId: string): void {
  inFlight.delete(userId);
}
