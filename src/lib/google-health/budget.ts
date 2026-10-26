/**
 * The limits a Google Health walk runs under and what it reports back.
 *
 * A walk asks before each request whether to stop: on the job's own budget
 * (the full-history backfill runs under its pg-boss job's budget and abort
 * signal), and, in a backfill slice, on the slice's tighter limit of minutes
 * and pages. Each walk also adds to the per-resource outcome tally the cycle
 * reports (pages, fetched, mapped, written, truncated, reason). Both live in
 * async-local scopes the sync opens, so the walker needs no parameters for
 * them.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface GoogleHealthClientOutcome {
  pages: number;
  fetched: number;
  mapped: number;
  written: number;
  truncated: boolean;
  reasonCode:
    | "collection_failed"
    | "token_failed"
    | "upsert_failed"
    | "rollup_failed"
    | "existing_page_limit"
    | null;
}

const clientOutcomeStorage = new AsyncLocalStorage<GoogleHealthClientOutcome>();

function addOutcomeCount(current: number, value: number): number {
  if (!Number.isFinite(value) || value <= 0) return current;
  return Math.min(2_147_483_647, current + Math.trunc(value));
}

export function notePagination(
  pages: number,
  fetched: number,
  truncated: boolean,
): void {
  const tracker = clientOutcomeStorage.getStore();
  if (!tracker) return;
  tracker.pages = addOutcomeCount(tracker.pages, pages);
  tracker.fetched = addOutcomeCount(tracker.fetched, fetched);
  if (truncated) {
    tracker.truncated = true;
    tracker.reasonCode = "existing_page_limit";
  }
}

export function noteGoogleHealthMapped(count: number): void {
  const tracker = clientOutcomeStorage.getStore();
  if (tracker) tracker.mapped = addOutcomeCount(tracker.mapped, count);
}

export function noteGoogleHealthWritten(count: number): void {
  const tracker = clientOutcomeStorage.getStore();
  if (tracker) tracker.written = addOutcomeCount(tracker.written, count);
}

export function noteGoogleHealthOutcomeFailure(
  reasonCode: Exclude<GoogleHealthClientOutcome["reasonCode"], null>,
): void {
  const tracker = clientOutcomeStorage.getStore();
  if (tracker && !tracker.reasonCode) tracker.reasonCode = reasonCode;
}

/** Whether a walk in the current resource scope has ended short so far. */
export function googleHealthOutcomeTruncated(): boolean {
  return clientOutcomeStorage.getStore()?.truncated === true;
}

export async function runWithGoogleHealthClientOutcome<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; outcome: GoogleHealthClientOutcome }> {
  const outcome: GoogleHealthClientOutcome = {
    pages: 0,
    fetched: 0,
    mapped: 0,
    written: 0,
    truncated: false,
    reasonCode: null,
  };
  const result = await clientOutcomeStorage.run(outcome, fn);
  return { result, outcome };
}

/**
 * A stop condition for the walks below, set by a caller that runs under a
 * time limit (the full-history backfill, which runs under its pg-boss job's
 * budget and abort signal). A walk asks it before each request and, when it
 * says stop, ends there and reports itself truncated, the same outcome as
 * reaching the page ceiling: the resource is incomplete, the cycle is not
 * stamped, and the reason shown is that only part of the history was
 * processed. Outside such a scope the walks never stop early.
 *
 * A backfill slice adds a second, tighter limit (`GoogleHealthSliceBudget`):
 * minutes and pages rather than the job's hours. Only a walk that keeps its
 * place across attempts (`resumable`) honours it, because only such a walk
 * loses nothing by stopping; a walk that would start over from its first page
 * runs on to the end under the job's limit alone.
 */
interface GoogleHealthWalkLimits {
  shouldStop: () => boolean;
  slice?: GoogleHealthSliceBudget;
}

/** Why a backfill slice stopped walking. */
export type GoogleHealthSliceStopReason =
  "time_budget" | "page_budget" | "rate_limited" | "job_budget" | "lane_wanted";

/**
 * One backfill slice's share of the work: a span of wall-clock time and a
 * page count, both well inside the job's own expiry. The clock starts the
 * first time a walk asks, which is after the slice has the account's lock: a
 * slice that waited for an hourly sync to finish does not start out with its
 * time already spent. `pages` counts every page the slice's walks have read;
 * `stopReason` is set the first time a limit is reached and stays set, so
 * every walk after it stops too.
 */
export interface GoogleHealthSliceBudget {
  ms: number;
  /** When the slice's time is up; null until the first walk asks. */
  deadline: number | null;
  maxPages: number;
  pages: number;
  /**
   * Of `pages`, those a walk only passed over on its way to its edge, because
   * Google refused the edge filter (see `forEachDataPointPage`). They are not
   * charged against `maxPages`. Their time is: a skip runs on the slice's
   * clock like any other read, and on its own shorter limit
   * (`GOOGLE_HEALTH_SKIP_MS`), and keeps its place for the next slice when it
   * stops. Only a skip that had to start over from the newest page, because
   * its saved place was refused, moves `deadline` on by the time it took.
   */
  skippedPages: number;
  stopReason: GoogleHealthSliceStopReason | null;
  now: () => number;
  /**
   * Whether another heavy job waits for the lane this slice holds
   * (`laneWanted` in `jobs/heavy-lane.ts`). Asked where the slice's own
   * limits are, so giving way keeps every walk's place, and only once the
   * slice has read a page, so the slice it ends has something on disk and is
   * continued rather than failed.
   */
  yieldWanted: () => boolean;
}

/** A fresh slice budget of `ms` milliseconds and `maxPages` pages. */
export function googleHealthSliceBudget(
  ms: number,
  maxPages: number,
  now: () => number = Date.now,
  yieldWanted: () => boolean = () => false,
): GoogleHealthSliceBudget {
  return {
    ms,
    deadline: null,
    maxPages,
    pages: 0,
    skippedPages: 0,
    stopReason: null,
    now,
    yieldWanted,
  };
}

const stopStorage = new AsyncLocalStorage<GoogleHealthWalkLimits>();

/** Whether the slice in scope has used its budget (and why, once it has). */
function sliceExhausted(slice: GoogleHealthSliceBudget): boolean {
  if (slice.stopReason) return true;
  slice.deadline ??= slice.now() + slice.ms;
  if (slice.now() >= slice.deadline) slice.stopReason = "time_budget";
  else if (slice.pages - slice.skippedPages >= slice.maxPages) {
    slice.stopReason = "page_budget";
  } else if (slice.pages > 0 && slice.yieldWanted()) {
    slice.stopReason = "lane_wanted";
  }
  return slice.stopReason !== null;
}

/**
 * Whether a walk should stop before its next request. Every walk stops on the
 * job's limit; a resumable one also stops on the slice's.
 */
export function stopRequested(resumable = false): boolean {
  const limits = stopStorage.getStore();
  if (!limits) return false;
  if (limits.shouldStop()) {
    if (limits.slice && !limits.slice.stopReason) {
      limits.slice.stopReason = "job_budget";
    }
    return true;
  }
  return (
    resumable && limits.slice !== undefined && sliceExhausted(limits.slice)
  );
}

/**
 * Whether the backfill slice in scope has used its budget. A collection that
 * has not started yet waits for the next slice rather than starting now.
 * False outside a slice.
 */
export function googleHealthSliceExhausted(): boolean {
  const limits = stopStorage.getStore();
  if (!limits) return false;
  if (limits.shouldStop()) {
    if (limits.slice && !limits.slice.stopReason) {
      limits.slice.stopReason = "job_budget";
    }
    return true;
  }
  return limits.slice !== undefined && sliceExhausted(limits.slice);
}

/** Pages the slice in scope has read so far (0 outside a slice). */
export function googleHealthSlicePagesRead(): number {
  return stopStorage.getStore()?.slice?.pages ?? 0;
}

/** Count one page read against the slice in scope, if any. */
export function noteSlicePage(): void {
  const slice = stopStorage.getStore()?.slice;
  if (slice) slice.pages += 1;
}

/**
 * Note one page the walk only passed over on its way to its edge: read, but
 * not charged against the slice's pages (no-op outside a slice).
 */
export function noteSliceSkip(): void {
  const slice = stopStorage.getStore()?.slice;
  if (slice) slice.skippedPages += 1;
}

/**
 * Give back to the slice in scope the time a skip took that had to start over
 * from the newest page (no-op outside a slice).
 */
export function extendSliceDeadline(ms: number): void {
  const slice = stopStorage.getStore()?.slice;
  if (slice && slice.deadline !== null) slice.deadline += ms;
}

/** The slice clock in scope, or the wall clock outside a slice. */
export function sliceNow(): number {
  return stopStorage.getStore()?.slice?.now() ?? Date.now();
}

/** End the slice in scope for `reason` (no-op outside a slice). */
export function endSlice(reason: GoogleHealthSliceStopReason): void {
  const slice = stopStorage.getStore()?.slice;
  if (slice && !slice.stopReason) slice.stopReason = reason;
}

/** Whether a resumable walk can stop and keep its place here. */
export function inSlice(): boolean {
  return stopStorage.getStore()?.slice !== undefined;
}

export async function runWithGoogleHealthStop<T>(
  shouldStop: () => boolean,
  fn: () => Promise<T>,
  slice?: GoogleHealthSliceBudget,
): Promise<T> {
  return stopStorage.run({ shouldStop, slice }, fn);
}

/**
 * Mark the resource in scope truncated without a walk: a collection a slice
 * left for the next one. The cycle then reports itself incomplete, so the
 * backfill does not mistake a skipped collection for an empty one.
 */
export function noteGoogleHealthDeferred(): void {
  notePagination(0, 0, true);
}
