/**
 * In-flight registry for `probeRollupCoverage`, kept in its own module so the
 * cache invalidators can reach it without importing the rollup read path.
 *
 * A single Coach snapshot, derived-metric batch or Insights page fans out into
 * a dozen readers that each probe the same account's coverage at the same
 * moment; one MCP `get_metrics` call was seen holding 59 of these probes open
 * on the database at once. Concurrent probes for one account now share the
 * query that is already running. Nothing is kept across requests once it
 * settles, and a measurement write drops the entry, so a probe that starts
 * after a write always reads afresh.
 *
 * Within one GET request the first answer also holds once it has settled.
 * Sharing only what is in flight made the number of probes a request sent
 * depend on scheduling: the digest and the dashboard snapshot it composes
 * each probe again for their score readers, and whether those later probes
 * overlapped an earlier one decided between two and four statements for the
 * same request on the same data. A GET writes no measurement, so one answer
 * per request is also the consistent one (every reader of the request takes
 * its read path from the same coverage). A write anywhere in the process
 * (`forgetCoverageProbe`) retires every held answer; any other method, a job
 * or a script holds nothing past the query in flight, as before.
 */
import { getEvent } from "@/lib/logging/context";

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

/**
 * Counts measurement writes in this process. A held answer is used only
 * while the count is the one it was taken at, so a write in the middle of a
 * request (any account's: the count is not kept per account, which costs at
 * most one extra probe) is never answered from before it.
 */
const writeGeneration = ((
  globalThis as unknown as {
    __healthlogCoverageWriteGeneration?: { value: number };
  }
).__healthlogCoverageWriteGeneration ??= { value: 0 });

interface HeldProbe {
  shared: Promise<Map<string, boolean>>;
  generation: number;
}

const requestMemos = new WeakMap<object, Map<string, HeldProbe>>();

/** Join the probe already running for `userId`, or start `run` as the one. */
export function joinCoverageProbe(
  userId: string,
  run: () => Promise<Map<string, boolean>>,
): Promise<Map<string, boolean>> {
  const memo = readRequestMemo();
  const held = memo?.get(userId);
  let shared =
    held && held.generation === writeGeneration.value
      ? held.shared
      : inFlight.get(userId);
  if (!shared) {
    const started = run();
    shared = started;
    inFlight.set(userId, started);
    const release = () => {
      if (inFlight.get(userId) === started) inFlight.delete(userId);
    };
    started.then(release, release);
  }
  if (memo && memo.get(userId)?.shared !== shared) {
    const kept = shared;
    memo.set(userId, { shared: kept, generation: writeGeneration.value });
    // A failed probe is not kept: the next reader of the request asks again.
    kept.catch(() => {
      if (memo.get(userId)?.shared === kept) memo.delete(userId);
    });
  }
  // Each caller gets its own map: a reader that adjusts its copy must not
  // change what the others see.
  return shared.then((coverage) => new Map(coverage));
}

/**
 * Called on a measurement write: the next probe for the account starts
 * afresh, in this request and in every other one.
 */
export function forgetCoverageProbe(userId: string): void {
  inFlight.delete(userId);
  writeGeneration.value += 1;
}

/** The held answers of the current GET request; null outside one. */
function readRequestMemo(): Map<string, HeldProbe> | null {
  const event = getEvent();
  if (!event || (event.getHttpMethod() ?? "").toUpperCase() !== "GET") {
    return null;
  }
  let memo = requestMemos.get(event);
  if (!memo) {
    memo = new Map();
    requestMemos.set(event, memo);
  }
  return memo;
}
