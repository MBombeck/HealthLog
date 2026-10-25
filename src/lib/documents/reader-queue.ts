/**
 * Who gets the document reader next.
 *
 * The reader (`./pdf-isolation.ts`) runs one child process at a time, because
 * the server and one child at its memory ceiling are what fit the default
 * container. It used to hand that one slot out first come, first served,
 * with no limit on how long anyone waited: a few heavy PDFs from one account,
 * each allowed up to a minute, put every other person's lab scan behind them
 * for as long as the uploads kept coming.
 *
 * Now the slot goes:
 *
 *   - to interactive work first: a read a person started and is waiting on
 *     (a lab scan, a medication label, a document read) is served before
 *     background work (thumbnails, indexing, summaries) that nobody watches;
 *   - round robin across accounts within each lane, so one account's queue
 *     takes one turn and then waits behind everyone else's next item;
 *   - to at most `maxQueuedPerOwner` waiting items per account; one more is
 *     refused at once rather than queued;
 *   - within a deadline per lane: an item still waiting when it passes leaves
 *     the queue with a retryable "busy" answer instead of waiting on.
 *
 * Nothing here knows what a PDF is, so the order can be tested on its own.
 */

export type ReaderLane = "interactive" | "background";

/** Interactive before background. */
const LANE_ORDER: readonly ReaderLane[] = ["interactive", "background"];

export interface ReaderQueueOptions {
  /** Work running at once. */
  slots: number;
  /** Items one owner may have waiting, across both lanes. */
  maxQueuedPerOwner: number;
  /** How long an item may wait in each lane before it is answered busy. */
  waitMs: Record<ReaderLane, number>;
}

/** The slot, or why there is none. `release` must be called exactly once. */
export type ReaderTicket =
  | { ok: true; release: () => void }
  | { ok: false; reason: "queue-full" | "wait-expired"; retryAfterMs: number };

interface Waiter {
  owner: string;
  grant: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ReaderQueue {
  acquire(owner: string, lane: ReaderLane): Promise<ReaderTicket>;
  /** Items running and waiting, for the suites and diagnostics. */
  snapshot(): { running: number; waiting: Record<ReaderLane, number> };
}

export function createReaderQueue(options: ReaderQueueOptions): ReaderQueue {
  let running = 0;
  // Per lane, one FIFO per owner. A Map iterates in insertion order, so the
  // first key is the owner whose turn it is; after a turn the owner moves to
  // the back.
  const lanes: Record<ReaderLane, Map<string, Waiter[]>> = {
    interactive: new Map(),
    background: new Map(),
  };

  const waitingFor = (owner: string): number =>
    LANE_ORDER.reduce(
      (sum, lane) => sum + (lanes[lane].get(owner)?.length ?? 0),
      0,
    );

  const remove = (lane: ReaderLane, waiter: Waiter): void => {
    const queue = lanes[lane].get(waiter.owner);
    if (!queue) return;
    const at = queue.indexOf(waiter);
    if (at !== -1) queue.splice(at, 1);
    if (queue.length === 0) lanes[lane].delete(waiter.owner);
  };

  const next = (): Waiter | null => {
    for (const lane of LANE_ORDER) {
      const owners = lanes[lane];
      const first = owners.keys().next();
      if (first.done) continue;
      const owner = first.value;
      const queue = owners.get(owner)!;
      const waiter = queue.shift()!;
      owners.delete(owner);
      if (queue.length > 0) owners.set(owner, queue);
      return waiter;
    }
    return null;
  };

  const release = (): void => {
    const waiter = next();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.grant();
    } else {
      running--;
    }
  };

  const ticket = (): ReaderTicket => {
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        release();
      },
    };
  };

  return {
    acquire(owner, lane) {
      if (running < options.slots) {
        running++;
        return Promise.resolve(ticket());
      }
      if (waitingFor(owner) >= options.maxQueuedPerOwner) {
        return Promise.resolve({
          ok: false,
          reason: "queue-full",
          retryAfterMs: options.waitMs[lane],
        });
      }
      return new Promise<ReaderTicket>((resolve) => {
        const waiter: Waiter = {
          owner,
          // The slot passes straight from the releasing item to this one;
          // `running` stays as it is.
          grant: () => resolve(ticket()),
          timer: setTimeout(() => {
            remove(lane, waiter);
            resolve({
              ok: false,
              reason: "wait-expired",
              retryAfterMs: options.waitMs[lane],
            });
          }, options.waitMs[lane]),
        };
        const queue = lanes[lane].get(owner);
        if (queue) queue.push(waiter);
        else lanes[lane].set(owner, [waiter]);
      });
    },
    snapshot() {
      const count = (lane: ReaderLane) =>
        [...lanes[lane].values()].reduce((sum, q) => sum + q.length, 0);
      return {
        running,
        waiting: {
          interactive: count("interactive"),
          background: count("background"),
        },
      };
    },
  };
}
