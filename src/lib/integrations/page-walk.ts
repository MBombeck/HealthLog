/**
 * The one way a provider client walks a paged collection, and the contract a
 * history backfill reads off it.
 *
 * Every client used to keep its own `while (pages < MAX)` loop, and each one
 * ended the same way at its ceiling: it returned what it had read, said
 * nothing, and the backfill around it stamped the connection complete. A
 * history longer than the ceiling, or a cursor that never advanced, was cut
 * off for good without a trace. `walkPages` keeps the ceiling, because a
 * runaway cursor must stop somewhere, but a walk that stops with a page still
 * pending, or on a cursor it has already followed, reports itself
 * `truncated`: on the run's wide event, and in the ledger a backfill opens
 * with `withPageWalkLedger`.
 *
 * The backfill contract (`backfillVerdict`), the same for every provider:
 *   - a failed collection fails the run: the job throws with the provider's
 *     error as the cause (`noteBackfillFailure`), and the drain sends it
 *     again after an outage (`jobs/integration-backfill-retry.ts`);
 *   - a truncated collection is not complete: the marker is not stamped, and
 *     boot discovery offers the account again, without a retry storm. Where
 *     a real history can outrun the ceiling (Strava's forty pages, about
 *     4 000 activities), the backfill records how far it got and the next
 *     run goes on from there (`strava-backfill.ts`), or each run would read
 *     the same newest pages again. The other ceilings sit far above any
 *     history (a thousand pages for WHOOP and Withings), so a truncation
 *     there is a cursor that does not advance, which no resume can cure;
 *     the repeat check ends it on the first page it would read twice;
 *   - a connection parked for re-authorisation is permanent until the person
 *     reconnects: the runner returns without stamping and without a retry.
 *
 * Google Health's dailyRollUp chunks walk through here. Its `dataPoints.list`
 * walk (`forEachDataPointPage`) stays outside on purpose: it is bounded by
 * progress in time rather than by a cursor ceiling (`google-health/
 * backfill-bounds.ts`), streams pages instead of collecting them, stops on a
 * backfill slice's budget and keeps its place for the next slice, and its
 * backfill decides with a sliced verdict these three outcomes cannot carry.
 * `src/__tests__/page-walk-guard.test.ts` keeps hand-rolled page loops out of
 * the provider directories and names that one exception with its reasons.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { annotate } from "@/lib/logging/context";

/**
 * One page as the client read it. A null, absent or empty `next` ends the
 * walk: WHOOP and Oura answer the last page with `next_token: ""` as well as
 * with null, and an empty token followed as a cursor is no cursor at all, so
 * the client asked for the first page again, read it twice and the walk
 * ended as a repeat, leaving the backfill incomplete for good.
 */
export interface WalkPage<C, T> {
  items: readonly T[];
  next: C | null | undefined;
  /**
   * The provider refused to go on for now (a rate limit) with history left.
   * The walk ends here with what it read, reported `truncated` like a walk
   * cut off at its ceiling, so a backfill resumes later instead of stamping
   * a history it did not finish.
   */
  interrupted?: boolean;
}

/** What the walk came to. */
export interface PageWalk<T> {
  items: T[];
  pages: number;
  /** Stopped at the ceiling or on a repeated cursor with history left. */
  truncated: boolean;
}

interface Ledger {
  walks: Set<string>;
  failure?: unknown;
}

const ledger = new AsyncLocalStorage<Ledger>();

/**
 * Walk `fetchPage` from `first` (or no cursor) until a page has no `next`,
 * at most `maxPages` pages. `label` names the collection (`whoop.recovery`)
 * on the wide event and in the ledger.
 */
export async function walkPages<C, T>(
  label: string,
  maxPages: number,
  fetchPage: (cursor: C | undefined, page: number) => Promise<WalkPage<C, T>>,
  first?: C,
): Promise<PageWalk<T>> {
  const items: T[] = [];
  const seen = new Set<C>(first === undefined ? [] : [first]);
  let cursor = first;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchPage(cursor, page);
    items.push(...result.items);
    if (result.interrupted) {
      return truncated(label, items, page + 1, "interrupted");
    }
    const next = result.next;
    if (next === null || next === undefined || next === "") {
      return { items, pages: page + 1, truncated: false };
    }
    if (seen.has(next)) return truncated(label, items, page + 1, "repeat");
    seen.add(next);
    cursor = next;
  }
  return truncated(label, items, maxPages, "ceiling");
}

function truncated<T>(
  label: string,
  items: T[],
  pages: number,
  reason: "ceiling" | "repeat" | "interrupted",
): PageWalk<T> {
  annotate({
    action: { name: "integration.page_walk.truncated" },
    meta: { walk: label, pages, reason },
  });
  ledger.getStore()?.walks.add(label);
  return { items, pages, truncated: true };
}

/**
 * Note the error a collection failed on, from a sync that carries on past it
 * (WHOOP, Google Health). The first one is kept: the backfill throws with it
 * as the cause, so the drain can tell an outage from a bug.
 */
export function noteBackfillFailure(err: unknown): void {
  const store = ledger.getStore();
  if (store && store.failure === undefined) store.failure = err;
}

/**
 * Run `run` with a ledger of the walks inside it that ended truncated and the
 * first collection failure noted. A backfill wraps its full sync in this and
 * reads the ledger before it stamps its marker.
 */
export async function withPageWalkLedger<R>(
  run: () => Promise<R>,
): Promise<{ result: R; truncated: string[]; failure: unknown }> {
  const store: Ledger = { walks: new Set() };
  const result = await ledger.run(store, run);
  return {
    result,
    truncated: [...store.walks].sort(),
    failure: store.failure,
  };
}

/** The error a backfill throws when its run failed, with the cause noted. */
export function backfillIncomplete(message: string, failure: unknown): Error {
  return new Error(
    message,
    failure === undefined ? undefined : { cause: failure },
  );
}

/** What a backfill does with its full sync's outcome. */
export type BackfillVerdict = "complete" | "retry" | "incomplete";

export function backfillVerdict(outcome: {
  failed: boolean;
  truncated: readonly string[];
}): BackfillVerdict {
  if (outcome.failed) return "retry";
  return outcome.truncated.length > 0 ? "incomplete" : "complete";
}
