/**
 * Google Health sync service (v1.27.0).
 *
 * Token-management + per-resource orchestration:
 *   - `getValidToken` decrypts the stored token, refreshes at
 *     `tokenExpiresAt - 5 min`, persists the new access token + expiry, and —
 *     following Google's semantics — only overwrites the stored refresh token
 *     when the response carries a fresh one (Google does NOT rotate refresh
 *     tokens). A revoked / expired refresh token (the 7-day "Testing"-mode
 *     expiry, or a user-revoked grant) surfaces `invalid_grant`/401 →
 *     `reauth_required`, which parks the connection at `error_reauth` so the
 *     card prompts a reconnect.
 *   - `recordGoogleHealthSyncFailure` / `classificationToFailureKind` map a
 *     classified API error onto the shared integration-status ledger.
 *   - `syncUserGoogleHealth` drives the hourly poll, the manual trigger, and the
 *     boot-time backfill across every resource.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { annotate, getEvent } from "@/lib/logging/context";
import type { GoogleHealthCollectionKey } from "./collection-keys";
import {
  googleHealthBackfillEndIsFinal,
  googleHealthBackfillEndRetryAt,
  type GoogleHealthBackfillEnd,
} from "./backfill-bounds";
import {
  googleHealthBackfillProgressJson,
  type GoogleHealthBackfillCursor,
} from "./backfill-progress";
import { userDayKey } from "@/lib/tz/format";
import { isP2002 } from "@/lib/prisma-errors";
import {
  reconcileExternalMeasurement,
  type MeasurementReconciliationVerdict,
} from "@/lib/measurements/reconcile-external-measurement";
import { dropImplausibleMeasurements } from "@/lib/measurements/plausibility-gate";
import { withoutFoldedSamples } from "@/lib/measurements/folded-window";
import { emitInsertedMeasurementArrivals } from "@/lib/arrivals/measurement-emit";
import { recordSyncFailure, type FailureKind } from "@/lib/integrations/status";
import { collapseToTypeDayKeys } from "@/lib/rollups/measurement-rollups";
import { afterProviderWrite } from "@/lib/integrations/sync-kit/after-write";
import { type GoogleHealthResumePoint } from "./data-points";
import { type GoogleHealthTokenSource } from "./request";
import {
  googleHealthOutcomeTruncated,
  googleHealthSliceExhausted,
  googleHealthSlicePagesRead,
  noteGoogleHealthDeferred,
  noteGoogleHealthMapped,
  noteGoogleHealthOutcomeFailure,
  noteGoogleHealthWritten,
} from "./budget";
import {
  GOOGLE_HEALTH_TOKEN_REFRESH_BUFFER_MS,
  googleHealthTokenDescriptor,
} from "./oauth-descriptor";
import { obtainAccessToken } from "@/lib/integrations/oauth-kit/token";
import {
  GoogleHealthApiError,
  classifyGoogleHealthError,
  isGoogleHealthReauthRequired,
  type GoogleHealthClassification,
} from "./response-classifier";

/**
 * The status-ledger key for this integration. Distinct from the classic Fitbit
 * `"fitbit"` key so the two coexisting providers keep independent status rows.
 */
export const GOOGLE_HEALTH_INTEGRATION_KEY = "google-health";

/**
 * Overlap window for the incremental sync, in ms. Google re-rolls daily
 * summaries after the fact (a daily SpO2 / HRV / RHR can finalise hours after
 * the night), so the default overlap is a full 24 h to make sure the re-rolled
 * row is re-fetched on the next tick. Mirrors WHOOP's recovery/sleep overlap.
 */
export const GOOGLE_HEALTH_DEFAULT_OVERLAP_MS = 24 * 60 * 60 * 1000;

/**
 * v1.42 (#1023) — the overlap for intraday samples (heart rate, one point a
 * minute). The 24 h overlap exists for daily summaries and sleep, which
 * Google re-scores after the fact; a minute sample is final when it is
 * written. Re-reading a whole day of it every hour meant 38 to 40 pages per
 * sync on a per-minute stream, which a slow host felt. Two hours still
 * covers a watch that syncs to the phone late.
 */
export const GOOGLE_HEALTH_INTRADAY_OVERLAP_MS = 2 * 60 * 60 * 1000;

/**
 * The intraday overlap for one cycle. Two hours covers a watch that reaches
 * the phone a little late, but a watch worn without its phone uploads to
 * Google's cloud only when it next meets the phone, which can be many hours
 * after the samples were taken. Those samples carry their original sample
 * time, so once `lastSyncedAt` has moved past them a two-hour window never
 * sees them again.
 *
 * So the first successful cycle of each local day reads intraday samples
 * with the full day of overlap, and every later cycle that day keeps the
 * short window. "First of the day" is derived from the watermark itself
 * (`lastSyncedAt` falls on an earlier local day than now), so no extra state
 * is needed, and a failed wide cycle does not stamp `markSynced`, which makes
 * the next cycle wide again. Cost stays bounded: one day-wide read per day
 * instead of one per hour, still under the dense page cap (#1023).
 */
export function intradayOverlapMs(
  lastSyncedAt: Date | null,
  tz: string,
  now: Date = new Date(),
): number {
  if (!lastSyncedAt) return GOOGLE_HEALTH_INTRADAY_OVERLAP_MS;
  return userDayKey(lastSyncedAt, tz) === userDayKey(now, tz)
    ? GOOGLE_HEALTH_INTRADAY_OVERLAP_MS
    : GOOGLE_HEALTH_DEFAULT_OVERLAP_MS;
}

export interface GoogleHealthTokenInfo {
  accessToken: string;
  /** When `accessToken` stops being accepted. */
  expiresAt: Date;
  connection: { id: string; googleUserId: string | null };
}

/**
 * Resolve a valid Google Health access token for a user, refreshing if it is
 * within the 5-minute expiry buffer. Returns null when there is no connection,
 * no credentials, or the refresh fails (the failure is recorded so scheduled
 * syncs back off).
 *
 * Google does not rotate refresh tokens. On refresh, persist the new access
 * token + expiry and overwrite the stored `refreshToken` ONLY when the response
 * carries a fresh one — otherwise keep the existing refresh token so the next
 * refresh still authenticates.
 */
export async function getValidToken(
  userId: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<GoogleHealthTokenInfo | null> {
  const connection = await prisma.googleHealthConnection.findUnique({
    where: { userId },
    select: { id: true, googleUserId: true },
  });
  if (!connection) return null;

  try {
    const result = await obtainAccessToken(
      googleHealthTokenDescriptor,
      userId,
      { force: opts.forceRefresh === true },
    );
    if (result.kind === "token") {
      return {
        accessToken: result.accessToken,
        // Google always stores an expiry; the fallback only satisfies the type.
        expiresAt: result.expiresAt ?? new Date(),
        connection,
      };
    }
    if (result.kind === "none") return null;
    getEvent()?.addWarning(
      `No Google Health credentials found for user ${userId} during token refresh`,
    );
    await recordSyncFailure({
      userId,
      integration: GOOGLE_HEALTH_INTEGRATION_KEY,
      kind: "reauth_required",
      message: "Google Health credentials missing — token refresh skipped",
      errorCode: "credentials_missing",
    });
    // A dead token means every resource "succeeds" with 0 rows — without a
    // ledger entry the cycle would read as clean, stamp `markSynced`, and
    // `recordSyncSuccess` would flip a parked connection back to connected
    // (an hourly invalid-refresh hammer with an advancing watermark). Fail
    // the cycle's verdict so the park holds.
    noteHardFailure(GOOGLE_HEALTH_TOKEN_HARD_FAIL);
    return null;
  } catch (err) {
    getEvent()?.addWarning(
      `Google Health token refresh failed for user ${userId}: ${err}`,
    );
    // A revoked / expired refresh token (`invalid_grant` / 401 — the 7-day
    // Testing-mode refresh expiry, or a user-revoked grant) is a SOFT
    // disconnect: flag `needsReauth` on the connection so the card surfaces a
    // "reconnect" CTA rather than a hard error. The callback clears it on a
    // fresh consent. A transient refresh failure (network blip, 5xx) leaves
    // the flag untouched so we don't nag the user to reconnect needlessly.
    if (isGoogleHealthReauthRequired(err)) {
      await prisma.googleHealthConnection
        .update({
          where: { id: connection.id },
          data: { needsReauth: true },
        })
        .catch((e) =>
          getEvent()?.addWarning(
            `google-health: needsReauth flag write failed for ${userId}: ${e}`,
          ),
        );
    }
    await recordGoogleHealthSyncFailure(userId, err);
    // Same verdict rule as the credentials-missing branch above: a refresh
    // failure must fail the cycle, or the all-zeros run stamps success,
    // un-parks `error_reauth`, and the hourly cohort retries the dead
    // refresh token forever while `lastSyncedAt` advances past real data.
    noteHardFailure(GOOGLE_HEALTH_TOKEN_HARD_FAIL);
    return null;
  }
}

/**
 * Thrown by a token source when no valid token can be had any more. The
 * failure is already on the ledger and the cycle's verdict by then
 * (`getValidToken` records it), so the collection that hit it only has to
 * stop.
 */
export class GoogleHealthTokenUnavailableError extends Error {
  constructor() {
    super("Google Health access token unavailable");
    this.name = "GoogleHealthTokenUnavailableError";
  }
}

/**
 * The token source a resource hands to its walks (see
 * `GoogleHealthTokenSource`). It starts from the token the resource resolved
 * and renews it whenever it comes within the refresh buffer of expiring, or
 * when a request reports it refused.
 *
 * Before this the resource resolved one token and every walk carried it to
 * the end. An access token lives an hour, a full-history heart-rate walk runs
 * for several, and once the hour was up every remaining request answered 401.
 * A 401 classifies as a revoked grant, so the account was parked at
 * `error_reauth` over a token that had simply expired, with a refresh token
 * that was still perfectly good, and stayed parked until it was reconnected
 * by hand (#1194).
 */
export function googleHealthTokenSource(
  userId: string,
  initial: GoogleHealthTokenInfo,
): GoogleHealthTokenSource {
  let current = initial;
  return async ({ forceRefresh }) => {
    if (
      forceRefresh ||
      current.expiresAt.getTime() - GOOGLE_HEALTH_TOKEN_REFRESH_BUFFER_MS <
        Date.now()
    ) {
      const next = await getValidToken(userId, { forceRefresh });
      if (!next) throw new GoogleHealthTokenUnavailableError();
      current = next;
    }
    return current.accessToken;
  };
}

/**
 * True when a caught error is a per-data-class 403 (forbidden). The Google
 * Health Restricted bundles are granted independently in the consent flow, so a
 * 403 on ONE data class is a scope gate on THAT class — soft-skip it and keep
 * the connection connected rather than parking the whole integration at
 * `error_reauth`. Connection-wide reauth is reserved for a 401 (token rejected)
 * and for a 403 on the token-refresh / profile path (a genuine grant revoke),
 * which run outside the per-resource catch blocks.
 */
export function isCollectionForbidden(err: unknown): boolean {
  return err instanceof GoogleHealthApiError && err.httpStatus === 403;
}

/**
 * Per-`syncUserGoogleHealth`-cycle counter for collection-403 soft-skips.
 * Scoped by AsyncLocalStorage so the count never bleeds across concurrent
 * per-user pg-boss jobs. Mirrors the WHOOP `softSkipStorage` tracker.
 */
interface SoftSkipTracker {
  count: number;
}
const softSkipStorage = new AsyncLocalStorage<SoftSkipTracker>();

/**
 * Per-cycle ledger of collection fetches that HARD-failed (non-403). A hard
 * failure on one collection must not abort its siblings — steps 400ing must
 * not suppress distance / floors / active-energy — so
 * `handleCollectionFetchError` records the failure here and returns instead of
 * rethrowing. The orchestrator reads the ledger to keep the cycle's verdict
 * honest: any entry ⇒ the run counts as failed (partial error), the watermark
 * is NOT stamped, and the next tick refetches the window.
 */
interface HardFailTracker {
  failures: string[];
}
const hardFailStorage = new AsyncLocalStorage<HardFailTracker>();

/**
 * Ledger label for a dead-token failure (`getValidToken` returning null on a
 * missing-credentials or failed-refresh path). Exported so the one-shot jobs
 * that run a single resource inside their own ledger scope can tell "the token
 * is dead" (park, don't retry) apart from "a fetch/write hard-failed" (retry).
 */
export const GOOGLE_HEALTH_TOKEN_HARD_FAIL = "token";

/**
 * Record a hard failure on the ambient per-cycle ledger, if one is in scope.
 * No-op outside a ledger scope (e.g. a direct call from a REPL script). Used by
 * `getValidToken`'s dead-token paths, the measurement write catches, and the
 * workout upsert catch — anything that must fail the cycle's verdict without
 * aborting sibling work.
 */
export function noteHardFailure(label: string): void {
  const tracker = hardFailStorage.getStore();
  if (tracker) tracker.failures.push(label);
  noteGoogleHealthOutcomeFailure(
    label === GOOGLE_HEALTH_TOKEN_HARD_FAIL
      ? "token_failed"
      : label.includes("rollup")
        ? "rollup_failed"
        : "upsert_failed",
  );
}

/**
 * Run `fn` inside a fresh hard-fail ledger scope and surface the collected
 * failures. `syncUserGoogleHealth` owns its own scope; this export exists for
 * the one-shot jobs (sleep repair) that drive a single resource sync directly
 * and must still see a dead token or a hard fetch/write failure before
 * stamping their completion marker.
 */
export async function runWithGoogleHealthHardFailLedger<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; failures: string[] }> {
  const tracker: HardFailTracker = { failures: [] };
  const result = await hardFailStorage.run(tracker, fn);
  return { result, failures: tracker.failures };
}

/**
 * Per-cycle accumulator of the `(type, day)` keys every resource's writes
 * touched. Only populated on a `fullSync` backfill (when the inline per-day
 * rollup hook is deferred); the orchestrator drains it into ONE
 * `recomputeUserRollups(from, to)` pass at the end of the cycle. Scoped by
 * AsyncLocalStorage so concurrent per-user jobs never cross-pollinate.
 */
interface RollupDeferTracker {
  /**
   * One entry per touched `(type, UTC day)`, never one per reading. A
   * full-history heart-rate backfill touches over a million readings but only
   * a few hundred days; a per-reading list grew with the stream.
   */
  keys: Map<string, { type: MeasurementType; measuredAt: Date }>;
}
const rollupDeferStorage = new AsyncLocalStorage<RollupDeferTracker>();

export interface GoogleHealthSyncCycleResult<T> {
  result: T;
  softSkipCount: number;
  hardFailures: string[];
  deferredRollupKeys: Array<{ type: MeasurementType; measuredAt: Date }>;
}

/**
 * Scope every ambient ledger used by one orchestrated sync cycle. Resource
 * leaves record into these ledgers through the helpers in this module; the
 * orchestrator receives a snapshot only after every leaf has completed.
 */
export async function runWithGoogleHealthSyncCycle<T>(
  fn: () => Promise<T>,
): Promise<GoogleHealthSyncCycleResult<T>> {
  const softSkips: SoftSkipTracker = { count: 0 };
  const hardFailures: HardFailTracker = { failures: [] };
  const deferredRollups: RollupDeferTracker = { keys: new Map() };
  const result = await softSkipStorage.run(softSkips, () =>
    hardFailStorage.run(hardFailures, () =>
      rollupDeferStorage.run(deferredRollups, fn),
    ),
  );
  return {
    result,
    softSkipCount: softSkips.count,
    hardFailures: hardFailures.failures,
    deferredRollupKeys: Array.from(deferredRollups.keys.values()),
  };
}

/** What one collection came to in one backfill attempt. */
export interface GoogleHealthBackfillCollectionReport {
  key: string;
  /**
   * `done`: walked to the end. `stopped`: ended short on a budget, a page
   * ceiling or a rate limit, with nothing failed. `deferred`: not started,
   * left for the next slice. `failed`: a request or a write failed, or the
   * collection answered 403.
   */
  status: "done" | "stopped" | "deferred" | "failed";
  pages: number;
  durationMs: number;
  /** The edge before and after this attempt, for a resumable collection. */
  edgeFrom?: string | null;
  edgeTo?: string | null;
}

interface BackfillResumeTracker {
  userId: string;
  done: Set<string>;
  cursors: Map<string, GoogleHealthBackfillCursor>;
  /** Collections this attempt skipped because an earlier one finished them. */
  skipped: string[];
  /** Collections whose edge this attempt moved, with the edge they started from. */
  advanced: Map<string, string | null>;
  collections: GoogleHealthBackfillCollectionReport[];
  /** Collections whose resumed request Google refused the edge filter on. */
  edgeFilterUnsupported: Set<string>;
  /** Collections whose walk ended short of the history's start, and where. */
  ended: Map<string, GoogleHealthBackfillEnd>;
  /**
   * Collections walked again this attempt after an earlier one ended without
   * progress, with how many attempts in a row had ended that way and the edge
   * they ended at.
   */
  retrying: Map<string, { attempts: number; at: string }>;
}
const backfillResumeStorage = new AsyncLocalStorage<BackfillResumeTracker>();

/**
 * Write the tracker's progress with one change applied, and apply it to the
 * tracker only once the write has landed: progress that is not on disk is
 * progress the next attempt cannot see, so it must not count in this one.
 */
async function persistBackfillProgress(
  tracker: BackfillResumeTracker,
  next: {
    done: Set<string>;
    cursors: Map<string, GoogleHealthBackfillCursor>;
    edgeFilterUnsupported?: Set<string>;
    ended?: Map<string, GoogleHealthBackfillEnd>;
  },
): Promise<void> {
  const unsupported =
    next.edgeFilterUnsupported ?? tracker.edgeFilterUnsupported;
  const ended = next.ended ?? tracker.ended;
  await prisma.googleHealthConnection.update({
    where: { userId: tracker.userId },
    data: {
      backfillProgress: googleHealthBackfillProgressJson({
        done: next.done,
        cursors: next.cursors,
        edgeFilterUnsupported: unsupported,
        ended,
      }),
    },
  });
  if (unsupported !== tracker.edgeFilterUnsupported) {
    for (const key of unsupported) tracker.edgeFilterUnsupported.add(key);
  }
  if (ended !== tracker.ended) {
    for (const [key, e] of ended) tracker.ended.set(key, e);
  }
  // `next` may be the tracker's own collections: copy before clearing.
  const done = [...next.done];
  const cursors = [...next.cursors];
  tracker.done.clear();
  for (const key of done) tracker.done.add(key);
  tracker.cursors.clear();
  for (const [key, c] of cursors) tracker.cursors.set(key, c);
}

/** What one backfill attempt did, as `runWithGoogleHealthBackfillResume` reports it. */
export interface GoogleHealthBackfillAttempt<T> {
  result: T;
  skipped: string[];
  /** Collections whose edge moved, each with the edge it started from. */
  advanced: Map<string, string | null>;
  collections: GoogleHealthBackfillCollectionReport[];
  /** Every collection ended short so far, this attempt's and earlier ones. */
  ended: Map<string, GoogleHealthBackfillEnd>;
}

/**
 * Run a full-history backfill attempt that resumes: collections in `done` are
 * skipped, a collection with an edge in `cursors` starts from it, and each
 * collection finished or page written during this attempt is persisted at
 * once, so an attempt that dies part-way keeps what it did.
 */
export async function runWithGoogleHealthBackfillResume<T>(
  userId: string,
  done: Set<string>,
  fn: () => Promise<T>,
  cursors: Map<string, GoogleHealthBackfillCursor> = new Map(),
  edgeFilterUnsupported: Set<string> = new Set(),
  ended: Map<string, GoogleHealthBackfillEnd> = new Map(),
): Promise<GoogleHealthBackfillAttempt<T>> {
  const tracker: BackfillResumeTracker = {
    userId,
    done,
    cursors,
    skipped: [],
    advanced: new Map(),
    collections: [],
    edgeFilterUnsupported,
    ended,
    retrying: new Map(),
  };
  const result = await backfillResumeStorage.run(tracker, fn);
  return {
    result,
    skipped: tracker.skipped,
    advanced: tracker.advanced,
    collections: tracker.collections,
    ended: tracker.ended,
  };
}

/**
 * Where a resumable collection's walk starts in this backfill attempt: the
 * edge an earlier attempt recorded (if any), and whether Google may be asked
 * for it with a filter (false once Google refused that filter for the
 * collection). Null outside a backfill, where every walk reads its whole
 * window.
 */
export function googleHealthBackfillCursor(key: GoogleHealthCollectionKey): {
  edge?: {
    at: Date;
    order: "desc" | "asc";
    filter: boolean;
    resumeFrom?: GoogleHealthResumePoint;
  };
} | null {
  const resume = backfillResumeStorage.getStore();
  if (!resume) return null;
  const cursor = resume.cursors.get(key);
  const filter = !resume.edgeFilterUnsupported.has(key);
  return cursor
    ? {
        edge: {
          at: new Date(cursor.at),
          order: cursor.order,
          filter,
          ...(!filter && cursor.resume
            ? {
                resumeFrom: {
                  token: cursor.resume.token,
                  page: cursor.resume.page,
                },
              }
            : {}),
        },
      }
    : {};
}

/**
 * Record that a collection's backfill ended short of the start of its
 * history, at `at`, because of `reason` (see `backfill-bounds.ts`). A final
 * end (`googleHealthBackfillEndIsFinal`) counts the collection as finished
 * for this backfill (`runGoogleHealthCollection`) and outlives the
 * completion stamp, so the card can say where the history ends. A first end
 * without progress parks the collection with its edge until its next
 * attempt is due. Outside a backfill this does nothing.
 */
export async function recordGoogleHealthBackfillEnd(
  key: GoogleHealthCollectionKey,
  end: Pick<GoogleHealthBackfillEnd, "type" | "at" | "reason">,
): Promise<void> {
  const resume = backfillResumeStorage.getStore();
  if (!resume) return;
  const ended = new Map(resume.ended);
  // Counted across attempts that end at the same edge: a walk that got
  // further back before it stalled again made progress, and its count starts
  // over. Only attempts in a row that reach nowhere make the end final.
  const parked = resume.retrying.get(key);
  const sameEdge =
    parked !== undefined && Date.parse(parked.at) === Date.parse(end.at);
  ended.set(
    key,
    end.reason === "no_progress"
      ? {
          ...end,
          attempts: sameEdge ? parked.attempts + 1 : 1,
          endedAt: new Date().toISOString(),
        }
      : end,
  );
  // A fixed shape, not the whole note: the slice report carries every end in
  // full (`googleHealth.backfill.slice`). This names the one that just ended
  // and counts the rest. It is meta, not the event's action, because the job
  // names the action once the slice is over and that would replace it.
  const recorded = ended.get(key)!;
  const final = [...ended.values()].filter(googleHealthBackfillEndIsFinal);
  annotate({
    meta: {
      "googleHealth.backfill.ended": {
        collection: key,
        type: recorded.type,
        reason: recorded.reason,
        final: googleHealthBackfillEndIsFinal(recorded),
        endedCount: ended.size,
        finalCount: final.length,
        types: [...new Set([...ended.values()].map((e) => e.type))].sort(),
      },
    },
  });
  try {
    await persistBackfillProgress(resume, {
      done: resume.done,
      cursors: resume.cursors,
      ended,
    });
  } catch (err) {
    // Not ended, then: the next slice walks it again and meets the same end.
    getEvent()?.addWarning(
      `google-health: backfill progress write failed for ${key}: ${err}`,
    );
    annotate({
      meta: { "googleHealth.backfill.progressWriteFailed": key },
    });
  }
}

/**
 * Record where a collection's walk without the edge bound stopped in the
 * unbounded list, so the next slice goes on from there. A place further than
 * every one saved before counts as this slice's progress (the backfill sends
 * another slice on it), even when no page was written: a skip deeper than one
 * slice is worked through over several. Outside a backfill, or for a
 * collection without an edge, this does nothing.
 */
export async function recordGoogleHealthBackfillResumePoint(
  key: GoogleHealthCollectionKey,
  point: GoogleHealthResumePoint,
): Promise<void> {
  const resume = backfillResumeStorage.getStore();
  if (!resume) return;
  const current = resume.cursors.get(key);
  if (!current) return;
  const reached = current.resume?.reached ?? 0;
  const further = point.page > reached;
  const cursors = new Map(resume.cursors);
  cursors.set(key, {
    ...current,
    resume: {
      token: point.token,
      page: point.page,
      reached: Math.max(reached, point.page),
    },
  });
  try {
    await persistBackfillProgress(resume, { done: resume.done, cursors });
    if (further && !resume.advanced.has(key)) {
      resume.advanced.set(key, current.at);
    }
  } catch (err) {
    getEvent()?.addWarning(
      `google-health: backfill progress write failed for ${key}: ${err}`,
    );
    annotate({
      meta: { "googleHealth.backfill.progressWriteFailed": key },
    });
  }
}

/**
 * Note that Google refused the edge filter on a resumed request of this
 * collection, so every later slice reads without it from the start instead
 * of paying for the refusal again. Annotated as
 * `googleHealth.backfill.edgeFilterUnsupported` (the collections noted so
 * far) on the run that met the refusal. A note that cannot be written is a
 * warning, not a failure: the next slice meets the refusal once more and
 * falls back again. Outside a backfill this does nothing.
 */
export async function noteGoogleHealthEdgeFilterUnsupported(
  key: GoogleHealthCollectionKey,
): Promise<void> {
  const resume = backfillResumeStorage.getStore();
  if (!resume || resume.edgeFilterUnsupported.has(key)) return;
  const unsupported = new Set([...resume.edgeFilterUnsupported, key]);
  annotate({
    meta: { "googleHealth.backfill.edgeFilterUnsupported": [...unsupported] },
  });
  try {
    await persistBackfillProgress(resume, {
      done: resume.done,
      cursors: resume.cursors,
      edgeFilterUnsupported: unsupported,
    });
  } catch (err) {
    getEvent()?.addWarning(
      `google-health: backfill progress write failed for ${key}: ${err}`,
    );
  }
}

/**
 * Record that a resumable collection wrote one more page, holding samples
 * from `first` to `last` in the order Google returned them. Moves the
 * collection's edge to the far end of the page and persists it. Outside a
 * backfill this does nothing.
 *
 * The order is read off the first page whose two ends differ and kept for
 * the rest of the backfill; Google returns its lists newest first, which is
 * also what a page that cannot tell is taken to mean.
 */
export async function recordGoogleHealthBackfillPage(
  key: GoogleHealthCollectionKey,
  page: { first: Date | null; last: Date | null },
): Promise<void> {
  const resume = backfillResumeStorage.getStore();
  if (!resume) return;
  const current = resume.cursors.get(key);
  const order: "desc" | "asc" =
    current?.order ??
    (page.first && page.last && page.first.getTime() < page.last.getTime()
      ? "asc"
      : "desc");
  const ends = [page.first, page.last].filter((d): d is Date => d !== null);
  const far =
    ends.length === 0
      ? null
      : new Date(
          order === "desc"
            ? Math.min(...ends.map((d) => d.getTime()))
            : Math.max(...ends.map((d) => d.getTime())),
        );
  const currentAt = current ? Date.parse(current.at) : null;
  const moved =
    far !== null &&
    (currentAt === null ||
      (order === "desc"
        ? far.getTime() < currentAt
        : far.getTime() > currentAt));
  if (!current && !moved) return;
  const nextCursor: GoogleHealthBackfillCursor = {
    at: moved ? far.toISOString() : current!.at,
    order,
    pages: (current?.pages ?? 0) + 1,
    // The saved place stays until the walk records where it stopped.
    ...(current?.resume ? { resume: current.resume } : {}),
  };
  const cursors = new Map(resume.cursors);
  cursors.set(key, nextCursor);
  try {
    await persistBackfillProgress(resume, { done: resume.done, cursors });
    if (moved && !resume.advanced.has(key)) {
      resume.advanced.set(key, current?.at ?? null);
    }
  } catch (err) {
    // The page's rows are written; only the note of how far the walk got is
    // missing, so the next attempt reads this page again. Not a failure.
    getEvent()?.addWarning(
      `google-health: backfill progress write failed for ${key}: ${err}`,
    );
    annotate({
      meta: { "googleHealth.backfill.progressWriteFailed": key },
    });
  }
}

/** Hard failures the cycle in scope has recorded so far. */
export function googleHealthHardFailureCount(): number {
  return hardFailStorage.getStore()?.failures.length ?? 0;
}

/**
 * Walk one collection, under the backfill's resume bookkeeping when there is
 * one in scope. Outside a backfill this is just `fn()`.
 *
 * Inside one, a collection already walked to the end by an earlier attempt is
 * skipped, and so is one the slice has no budget left to start: it is left
 * for the next slice, and the cycle reports itself incomplete. Otherwise it
 * runs, and it counts as finished only when nothing went wrong while it ran:
 * no hard failure on the cycle's ledger, no 403 soft-skip, and no walk that
 * ended short (its page ceiling, or a budget asking it to stop). Anything
 * less is walked again next attempt, from its edge when it has one.
 */
export async function runGoogleHealthCollection(
  key: GoogleHealthCollectionKey,
  fn: () => Promise<number>,
): Promise<number> {
  const resume = backfillResumeStorage.getStore();
  if (!resume) return fn();
  const parked = resume.ended.get(key);
  if (
    resume.done.has(key) ||
    (parked &&
      (googleHealthBackfillEndIsFinal(parked) ||
        googleHealthBackfillEndRetryAt(parked)! > Date.now()))
  ) {
    resume.skipped.push(key);
    return 0;
  }
  if (googleHealthSliceExhausted()) {
    noteGoogleHealthDeferred();
    resume.collections.push({
      key,
      status: "deferred",
      pages: 0,
      durationMs: 0,
    });
    return 0;
  }
  if (parked) {
    // Its earlier attempt ended without progress and its wait is over: walk
    // it again from its edge. The note goes with the next write; the count
    // and the edge stay with the attempt, so a second end at the same edge
    // is final.
    resume.retrying.set(key, {
      attempts: parked.attempts ?? 1,
      at: parked.at,
    });
    resume.ended.delete(key);
  }
  const startedAt = performance.now();
  const pagesBefore = googleHealthSlicePagesRead();
  const edgeFrom = resume.cursors.get(key)?.at ?? null;
  const hardBefore = hardFailStorage.getStore()?.failures.length ?? 0;
  const softBefore = softSkipStorage.getStore()?.count ?? 0;
  const truncatedBefore = googleHealthOutcomeTruncated();
  const imported = await fn();
  const failedHard =
    (hardFailStorage.getStore()?.failures.length ?? 0) !== hardBefore ||
    (softSkipStorage.getStore()?.count ?? 0) !== softBefore;
  const truncated = truncatedBefore || googleHealthOutcomeTruncated();
  // A walk that ended short for good (the horizon, or no progress on its
  // last attempt) has read all it is going to: finished, though the walk may
  // report itself truncated. One that ended without progress for the first
  // time is not: it keeps its edge and waits for its next attempt.
  const end = resume.ended.get(key);
  const endedFinal = end !== undefined && googleHealthBackfillEndIsFinal(end);
  const clean = !failedHard && (endedFinal || (!truncated && !end));
  let finished = false;
  if (clean) {
    // The collection counts as finished only once the note says so. The job
    // reads the size of `done` as this attempt's progress and sends another
    // slice on it; a key added before a write that then failed would be
    // progress nobody can see next attempt, and a chain of slices could keep
    // "progressing" over the same collection forever.
    try {
      const cursors = new Map(resume.cursors);
      cursors.delete(key);
      await persistBackfillProgress(resume, {
        done: new Set([...resume.done, key]),
        cursors,
      });
      finished = true;
    } catch (err) {
      // Not finished, then: the collection is walked again next attempt. It
      // must not fail a collection whose rows are written.
      getEvent()?.addWarning(
        `google-health: backfill progress write failed for ${key}: ${err}`,
      );
      annotate({
        meta: { "googleHealth.backfill.progressWriteFailed": key },
      });
    }
  }
  const edgeTo = finished ? null : (resume.cursors.get(key)?.at ?? null);
  resume.collections.push({
    key,
    status: finished ? "done" : failedHard ? "failed" : "stopped",
    pages: googleHealthSlicePagesRead() - pagesBefore,
    durationMs: Math.round(performance.now() - startedAt),
    ...(edgeFrom !== null || edgeTo !== null ? { edgeFrom, edgeTo } : {}),
  });
  return imported;
}

/**
 * Single-source the per-resource collection-fetch error handling. A 403 on one
 * data class soft-skips it (warn + return 0) so sibling resources still sync; a
 * soft-skip increments the ambient tracker so `syncUserGoogleHealth` can refuse
 * to stamp success on an all-403 grant-revoke cycle that imported nothing.
 *
 * Anything else records a classified sync failure, warns with the per-type
 * detail, notes the collection on the ambient hard-fail ledger, and RETURNS —
 * it does not rethrow. Every call site sits in a per-collection catch, so
 * returning lets the sibling collections in the same resource keep fetching
 * (one 400 on steps must not kill distance / floors / active-energy), while
 * the ledger still fails the cycle so the watermark is not stamped past the
 * broken collection.
 */
export async function handleCollectionFetchError(
  resource: string,
  userId: string,
  err: unknown,
): Promise<number> {
  if (err instanceof GoogleHealthTokenUnavailableError) {
    // `getValidToken` already recorded the failure and failed the cycle;
    // recording it again would count one dead token twice.
    getEvent()?.addWarning(
      `google-health ${resource} stopped for ${userId}: no valid access token`,
    );
    return 0;
  }
  if (isCollectionForbidden(err)) {
    getEvent()?.addWarning(
      `google-health ${resource} sync skipped for ${userId}: collection 403 (soft-skip)`,
    );
    const tracker = softSkipStorage.getStore();
    if (tracker) tracker.count += 1;
    return 0;
  }
  noteGoogleHealthOutcomeFailure("collection_failed");
  await recordGoogleHealthSyncFailure(userId, err);
  getEvent()?.addWarning(
    `google-health ${resource} failed for ${userId}: ${err}`,
  );
  const hardTracker = hardFailStorage.getStore();
  if (hardTracker) hardTracker.failures.push(resource);
  return 0;
}

/**
 * Options threaded from `syncUserGoogleHealth` to each per-resource sync. The
 * `start` watermark is snapshotted ONCE by the orchestrator (a single
 * `lastSyncedAt` read) so every resource fetches from the same lower bound; no
 * resource re-reads `lastSyncedAt` or stamps `markSynced` itself. On a
 * full/backfill run `start` is undefined (no lower bound). The orchestrator owns
 * the single end-of-cycle `markSynced`.
 */
export interface GoogleHealthResourceSyncOptions {
  fullSync?: boolean;
  /** The incremental lower bound, snapshotted once by the orchestrator. */
  start?: Date;
  /**
   * v1.42 — the incremental lower bound for intraday samples, from the same
   * snapshot with `GOOGLE_HEALTH_INTRADAY_OVERLAP_MS`. Undefined on a full
   * run, like `start`; a resource that does not set it falls back to `start`.
   */
  intradayStart?: Date;
  /**
   * When true, `upsertGoogleHealthMeasurements` writes the rows but SKIPS the
   * inline per-(type,day) DAY-rollup recompute + status-insight invalidate,
   * returning the touched type-days to the caller instead. The orchestrator
   * collapses them into ONE `recomputeUserRollups(from, to)` pass at the end of
   * a `fullSync` cycle, so a multi-year backfill pays a single range-recompute
   * rather than thousands of per-day round-trips. The incremental path leaves
   * this unset and keeps the inline per-day hook.
   */
  deferRollup?: boolean;
}

/**
 * Compute the incremental `start` for a resource sync. `fullSync` returns
 * undefined (the backfill walks deep history without a lower bound). Otherwise
 * start from `lastSyncedAt - overlap`, or 30 days back on the very first
 * incremental tick. Mirrors WHOOP's `incrementalStart`.
 */
export function incrementalStart(
  lastSyncedAt: Date | null,
  opts: { fullSync?: boolean; overlapMs?: number } = {},
): Date | undefined {
  if (opts.fullSync) return undefined;
  const overlap = opts.overlapMs ?? GOOGLE_HEALTH_DEFAULT_OVERLAP_MS;
  if (lastSyncedAt) return new Date(lastSyncedAt.getTime() - overlap);
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
}

/**
 * One mapped reading destined for a `Measurement` row, with the per-point anchor
 * already resolved into a full `externalId`. The per-resource syncs build these
 * from the client mappers (`<anchor>:<fieldTag>`).
 */
export interface GoogleHealthMeasurementUpsert {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  externalId: string;
  /**
   * Per-stage sleep rows carry the `SleepStage` axis so the (up to six) stage
   * rows for one night stay distinct under the dedup key; every other row omits
   * it (null). Sleep is the only producer.
   */
  sleepStage?: "IN_BED" | "AWAKE" | "ASLEEP" | "REM" | "CORE" | "DEEP" | null;
}

/**
 * Keep one reading per natural key — `(type, measuredAt, sleepStage)`, the
 * second unique index on measurements — out of a batch.
 *
 * Google reports overlapping sleep segments: two sessions for one night, or
 * two segments of one session with the same stage and the same end. Both
 * readings carry their own externalId, but only one row can hold their
 * natural key. Writing both was never possible; what happened instead
 * depended on the order of the batch. A fresh pair lost one reading to
 * `skipDuplicates` without a trace, and a re-score that moved one row onto
 * the other's slot threw P2002 and failed the whole sync (#1195).
 *
 * The rule picks the same reading every time Google sends the same pair, so
 * the row that holds the slot does not change hands from one sync to the
 * next: the longer one (for a sleep segment, the span that covers the
 * shorter one ending at the same instant), then the smaller externalId.
 * Readings that share an externalId as well are the same reading fetched
 * twice, and collapse the same way.
 */
export function collapseNaturalKeyTwins<
  T extends GoogleHealthMeasurementUpsert,
>(readings: readonly T[]): { kept: T[]; dropped: number } {
  const byKey = new Map<string, T>();
  for (const r of readings) {
    const key = `${r.type}|${r.measuredAt.getTime()}|${r.sleepStage ?? ""}`;
    const held = byKey.get(key);
    if (
      !held ||
      r.value > held.value ||
      (r.value === held.value && r.externalId < held.externalId)
    ) {
      byKey.set(key, r);
    }
  }
  return {
    kept: readings.filter(
      (r) =>
        byKey.get(
          `${r.type}|${r.measuredAt.getTime()}|${r.sleepStage ?? ""}`,
        ) === r,
    ),
    dropped: readings.length - byKey.size,
  };
}

/** Chunk size for the batched `createMany` insert of fresh readings. */
const GOOGLE_HEALTH_CREATE_CHUNK = 500;

/** One just-fetched sleep session's window + the ids that must survive it. */
export interface GoogleHealthSleepReplaceWindow {
  /** Earliest segment start (UTC). Null → nothing to clean for this session. */
  windowStart: Date | null;
  /** Latest segment end (UTC). */
  windowEnd: Date | null;
  /**
   * The fresh externalIds that must survive — every session's of the fetch,
   * since sessions can overlap (see `replaceStaleGoogleHealthSleep`).
   */
  keepIds: string[];
}

/**
 * Replace-by-window cleanup for re-scored Google sleep sessions.
 *
 * Google re-scores a night after the fact. Before the stable-anchor fix a
 * re-fetch minted fresh externalIds and left the prior night's rows LIVE, so the
 * night-total silently double-counted (a 7h35 night read as 10h+). For each
 * just-fetched session this soft-deletes any LIVE `GOOGLE_HEALTH`
 * `SLEEP_DURATION` row whose `measuredAt` falls inside the session's
 * `[windowStart, windowEnd]` but was NOT re-produced by this fetch. Sessions
 * CAN overlap in time (Google reports two sessions over one stretch of a night
 * from two sources), so the caller passes every fresh externalId of the fetch
 * in `keepIds`, not only this session's: a window then never clears a row
 * another session just re-produced, and any leftover (old volatile key, or a
 * segment Google dropped) is cleared. Rows OUTSIDE every returned
 * window are never touched, so a night Google did not re-report this tick stays
 * intact — no data loss, only stale duplicates and re-score orphans go. This is
 * also the repair path: a full backfill re-fetches history and cleans each night
 * as it goes. Best-effort — a cleanup failure never fails the user's sync.
 */
export async function replaceStaleGoogleHealthSleep(
  userId: string,
  sessions: GoogleHealthSleepReplaceWindow[],
): Promise<number> {
  let removed = 0;
  for (const s of sessions) {
    if (!s.windowStart || !s.windowEnd || s.keepIds.length === 0) continue;
    try {
      const res = await prisma.measurement.updateMany({
        where: {
          userId,
          source: "GOOGLE_HEALTH",
          type: "SLEEP_DURATION",
          deletedAt: null,
          measuredAt: { gte: s.windowStart, lte: s.windowEnd },
          externalId: { notIn: s.keepIds },
        },
        data: { deletedAt: new Date() },
      });
      removed += res.count;
    } catch (err) {
      getEvent()?.addWarning(
        `google-health: sleep replace-by-window failed: ${err}`,
      );
    }
  }
  return removed;
}

/**
 * Write a batch of mapped Google Health readings for one user and (unless
 * deferred) fold the rollup tier + invalidate status-insight caches once at the
 * end (mirrors the WHOOP / Withings sync tail). Returns the count of rows
 * written plus the distinct `(type, day)` keys the write touched.
 *
 * TOMBSTONES RESURRECT: the measurements unique index on
 * `(userId, type, source, externalId)` is FULL — it covers soft-deleted rows
 * too, so exactly ONE row can ever exist per key, live or tombstoned. An
 * earlier revision assumed a partial (live-only) index and skipped tombstoned
 * rows in the probe, expecting a fresh insert; in reality `createMany` with
 * `skipDuplicates` then hit the tombstoned row's key and dropped the insert
 * SILENTLY — once a Google row was soft-deleted, that key could never import
 * again (live: a self-hoster's step days were stuck this way). The probe now
 * matches tombstoned rows as well and the update branch clears `deletedAt`:
 * Google remains the source of truth for its own rows, so a re-import
 * deliberately revives a deleted one. An operator who wants Google data gone
 * permanently disconnects the integration rather than deleting rows.
 *
 * OVERWRITE CONTRACT preserved: a re-fetched daily summary (`stats:`-keyed and
 * every other stable per-point anchor) maps to the SAME live `externalId`, so
 * the probe finds the existing row and takes the in-place update branch.
 *
 * BATCHING: the existence probe is a single `findMany` over the batch's
 * externalIds; fresh rows go through chunked `createMany`, and only the
 * already-existing rows take a per-row `update` for their differing values.
 *
 * Best-effort on the rollup fold + insight invalidate — a populator hiccup never
 * fails the user's sync.
 */
export async function upsertGoogleHealthMeasurements(
  userId: string,
  incoming: GoogleHealthMeasurementUpsert[],
  opts: { deferRollup?: boolean } = {},
): Promise<{
  imported: number;
  touched: Array<{ type: MeasurementType; measuredAt: Date }>;
  inserted: Array<{
    id: string;
    type: MeasurementType;
    measuredAt: Date;
  }>;
}> {
  noteGoogleHealthMapped(incoming.length);
  // Every resource leg funnels through here, so this is the one place the
  // provider's numbers have to clear the app's declared plausibility band
  // before they can become rows. A refused reading is dropped and tallied on
  // the ambient event, never clamped and never written for a later reader to
  // discover.
  const { kept: collapsed, dropped: naturalKeyTwins } = collapseNaturalKeyTwins(
    dropImplausibleMeasurements("googleHealth", incoming, (r) => ({
      type: r.type,
      value: r.value,
    })),
  );
  if (naturalKeyTwins > 0) {
    annotate({ meta: { "googleHealth.naturalKeyTwins": naturalKeyTwins } });
  }
  // A sample of an hour the dense fold already took is not written again.
  const { kept: readings } = await withoutFoldedSamples(
    prisma,
    userId,
    "GOOGLE_HEALTH",
    collapsed,
  );
  if (readings.length === 0) return { imported: 0, touched: [], inserted: [] };

  // Probe EVERY existing row (live AND tombstoned) for the batch's externalIds
  // in one query: a tombstoned match must take the UPDATE branch, or the
  // insert is silently dropped against its key (see TOMBSTONES RESURRECT).
  const externalIds = readings.map((r) => r.externalId);
  interface ProbedRow {
    id: string;
    value: number;
    unit: string;
    measuredAt: Date;
    sleepStage: GoogleHealthMeasurementUpsert["sleepStage"];
    deletedAt: Date | null;
  }
  let rowByKey = new Map<string, ProbedRow>();
  try {
    const existing = await prisma.measurement.findMany({
      where: {
        userId,
        source: "GOOGLE_HEALTH",
        externalId: { in: externalIds },
      },
      // The payload rides along so the update branch can skip a no-op
      // overwrite (the hourly 24 h overlap would bump `syncVersion` for nothing).
      select: {
        id: true,
        type: true,
        externalId: true,
        value: true,
        unit: true,
        measuredAt: true,
        sleepStage: true,
        deletedAt: true,
      },
    });
    rowByKey = new Map(
      existing
        .filter((e) => e.externalId !== null)
        .map((e) => [
          `${e.type} ${e.externalId}`,
          {
            id: e.id,
            value: e.value,
            unit: e.unit,
            measuredAt: e.measuredAt,
            sleepStage: e.sleepStage,
            deletedAt: e.deletedAt,
          },
        ]),
    );
  } catch (err) {
    // A probe failure must not strand the batch: every row is treated as
    // fresh, and `skipDuplicates` absorbs the collisions until the next tick.
    getEvent()?.addWarning(`google-health: row probe failed: ${err}`);
  }

  const toCreate: Array<{
    type: MeasurementType;
    value: number;
    unit: string;
    measuredAt: Date;
    externalId: string;
    sleepStage: GoogleHealthMeasurementUpsert["sleepStage"];
  }> = [];
  const toUpdate: Array<{
    id: string;
    r: GoogleHealthMeasurementUpsert;
    /** Set when a key-format migration re-keys the row in place (see below). */
    reKeyTo?: string;
    /** The row's instant before this write, when the write moves it. */
    movedFrom?: Date;
  }> = [];
  const touched: Array<{ type: MeasurementType; measuredAt: Date }> = [];

  // A batch can carry the same (type, externalId) twice (an overlap re-fetch);
  // collapse to last-write-wins so we never emit two creates for one live key.
  const plannedCreateKeys = new Set<string>();
  for (const r of readings) {
    const type = r.type as MeasurementType;
    const key = `${type} ${r.externalId}`;
    const existingRow = rowByKey.get(key);
    if (existingRow) {
      // Skip the no-op overwrite of a LIVE row whose payload matches exactly
      // (it would churn `syncVersion` and every iOS delta pull). A TOMBSTONED
      // row always updates: the write is what resurrects it.
      const unchanged =
        existingRow.deletedAt === null &&
        existingRow.value === r.value &&
        existingRow.unit === r.unit &&
        existingRow.measuredAt.getTime() === r.measuredAt.getTime() &&
        (existingRow.sleepStage ?? null) === (r.sleepStage ?? null);
      if (!unchanged) {
        toUpdate.push({
          id: existingRow.id,
          r,
          movedFrom:
            existingRow.measuredAt.getTime() !== r.measuredAt.getTime()
              ? existingRow.measuredAt
              : undefined,
        });
      }
    } else if (!plannedCreateKeys.has(key)) {
      plannedCreateKeys.add(key);
      toCreate.push({
        type,
        value: r.value,
        unit: r.unit,
        measuredAt: r.measuredAt,
        externalId: r.externalId,
        sleepStage: r.sleepStage ?? null,
      });
    } else {
      // A duplicate fresh key inside the same batch — overwrite the planned
      // create's payload so last-write-wins, matching the prior upsert loop.
      const idx = toCreate.findIndex(
        (c) => `${c.type} ${c.externalId}` === key,
      );
      if (idx >= 0) {
        toCreate[idx] = {
          type,
          value: r.value,
          unit: r.unit,
          measuredAt: r.measuredAt,
          externalId: r.externalId,
          sleepStage: r.sleepStage ?? null,
        };
      }
    }
  }

  // ── KEY-FORMAT MIGRATION RESCUE ──────────────────────────────────────────
  // measurements carries a SECOND full unique index — the natural key
  // `(user_id, type, measured_at, source, sleep_stage)` NULLS NOT DISTINCT
  // (migration 0055) — and it covers tombstoned rows too. When an externalId
  // FORMAT changes (the v1.28.18 sleep-anchor fix re-keyed every segment), a
  // re-fetched night's fresh rows carry NEW externalIds but the SAME natural
  // key as the rows the replace-by-window sweep just tombstoned: the
  // externalId probe finds nothing, the insert collides with the tombstone on
  // the natural index, and `skipDuplicates` drops it SILENTLY — old row gone,
  // new row never written (live incident: a full-history re-sync erased a
  // user's sleep). So every planned CREATE gets a second probe by natural
  // key; a match — live or tombstoned — is UPDATED in place instead: fresh
  // value, the NEW externalId (the migration itself), `deletedAt: null`.
  if (toCreate.length > 0) {
    try {
      // A row this batch already matched by externalId belongs to that
      // reading. When the reading moves it (a re-scored segment end), the
      // slot it leaves is free by the time the inserts run (updates go
      // first, below), so a fresh reading for that slot is an insert, not a
      // rescue: re-keying the moving row would hand it to two readings at
      // once and drop one of them.
      const claimedIds = new Set([...rowByKey.values()].map((row) => row.id));
      const rescued = new Set<number>();
      const naturalKeyOf = (
        type: string,
        measuredAt: Date,
        stage: GoogleHealthMeasurementUpsert["sleepStage"],
      ): string => `${type}|${measuredAt.getTime()}|${stage ?? ""}`;
      for (let i = 0; i < toCreate.length; i += GOOGLE_HEALTH_CREATE_CHUNK) {
        const chunk = toCreate.slice(i, i + GOOGLE_HEALTH_CREATE_CHUNK);
        const rows = await prisma.measurement.findMany({
          where: {
            userId,
            source: "GOOGLE_HEALTH",
            type: { in: [...new Set(chunk.map((c) => c.type))] },
            measuredAt: { in: chunk.map((c) => c.measuredAt) },
          },
          select: {
            id: true,
            type: true,
            measuredAt: true,
            sleepStage: true,
          },
        });
        const byNaturalKey = new Map(
          rows.map((row) => [
            naturalKeyOf(
              row.type,
              row.measuredAt,
              row.sleepStage as GoogleHealthMeasurementUpsert["sleepStage"],
            ),
            row.id,
          ]),
        );
        for (let j = 0; j < chunk.length; j++) {
          const c = chunk[j];
          const id = byNaturalKey.get(
            naturalKeyOf(c.type, c.measuredAt, c.sleepStage),
          );
          if (id && !claimedIds.has(id)) {
            rescued.add(i + j);
            toUpdate.push({
              id,
              r: {
                type: c.type,
                value: c.value,
                unit: c.unit,
                measuredAt: c.measuredAt,
                externalId: c.externalId,
                sleepStage: c.sleepStage,
              },
              reKeyTo: c.externalId,
            });
          }
        }
      }
      if (rescued.size > 0) {
        for (let i = toCreate.length - 1; i >= 0; i--) {
          if (rescued.has(i)) toCreate.splice(i, 1);
        }
      }
    } catch (err) {
      // Best-effort: an unresolved natural-key twin only means the insert is
      // dropped by `skipDuplicates` as before — hold the watermark so the
      // next tick retries the rescue rather than losing the rows for good.
      getEvent()?.addWarning(
        `google-health: natural-key rescue probe failed: ${err}`,
      );
      noteHardFailure("measurements:rescue");
    }
  }

  let imported = 0;
  const insertedRows: Array<{
    id: string;
    type: MeasurementType;
    measuredAt: Date;
  }> = [];

  // Existing-row overwrites first, inserts second: a re-scored segment that
  // moves its row frees the slot the row held, and a fresh reading for that
  // slot can only land once the move has happened.
  //
  // Per-row update (differing values) on the matched id, so the re-fetched
  // daily summary overwrites in place and bumps `syncVersion`.
  // `deletedAt: null` rides along unconditionally — a no-op on a live row, a
  // deliberate RESURRECTION on a tombstoned one (Google is the source of truth
  // for its own rows; see TOMBSTONES RESURRECT above).
  //
  // A move can still land on a slot another row holds: Google reports
  // overlapping sleep segments, and a re-score can put one segment's end on
  // the end another segment of the same stage already has. The natural-key
  // index refuses that write (P2002). It is not a failed sync: the row that
  // holds the slot is a stale copy of the same reading, so the move is handed
  // to `reconcileExternalMeasurement`, which retires the stale copy and lands
  // the reading, the same way every other provider settles the two
  // identities. Only a reconcile that itself fails holds the watermark.
  const conflicts: typeof toUpdate = [];
  for (const entry of toUpdate) {
    const { id, r, reKeyTo, movedFrom } = entry;
    try {
      await prisma.measurement.update({
        where: { id },
        data: {
          value: r.value,
          unit: r.unit,
          measuredAt: r.measuredAt,
          sleepStage: r.sleepStage ?? null,
          deletedAt: null,
          // Key-format migration: adopt the fresh externalId in place.
          ...(reKeyTo ? { externalId: reKeyTo } : {}),
          // Surface the server-side mutation to the iOS LWW reconciler.
          syncVersion: { increment: 1 },
        },
      });
      touched.push({
        type: r.type as MeasurementType,
        measuredAt: r.measuredAt,
      });
      // A row that moved (a daily anchor re-cut on the user's local noon)
      // leaves its old day too; that day's rollup needs the refold.
      if (movedFrom) {
        touched.push({
          type: r.type as MeasurementType,
          measuredAt: movedFrom,
        });
      }
      imported++;
    } catch (err) {
      if (isP2002(err)) {
        conflicts.push(entry);
        continue;
      }
      getEvent()?.addWarning(
        `google-health: failed to update measurement: ${err}`,
      );
      // Same rule as the create catch: hold the watermark so the overwrite is
      // retried next tick rather than silently dropped.
      noteHardFailure("measurements:update");
    }
  }

  if (conflicts.length > 0) {
    let resolved = 0;
    for (const { r, movedFrom } of conflicts) {
      const verdict = await prisma
        .$transaction((tx) =>
          reconcileExternalMeasurement(tx, {
            userId,
            type: r.type as MeasurementType,
            source: "GOOGLE_HEALTH",
            value: r.value,
            unit: r.unit,
            measuredAt: r.measuredAt,
            externalId: r.externalId,
            sleepStage: r.sleepStage ?? null,
          }),
        )
        .catch((err): MeasurementReconciliationVerdict => ({
          status: "failed",
          error: { message: String(err) },
        }));
      if (verdict.status === "failed") {
        getEvent()?.addWarning(
          `google-health: failed to reconcile measurement: ${verdict.error.message}`,
        );
        noteHardFailure("measurements:update");
        continue;
      }
      if (verdict.status === "rejected_range") continue;
      resolved++;
      imported++;
      touched.push({
        type: r.type as MeasurementType,
        measuredAt: r.measuredAt,
      });
      if (movedFrom) {
        touched.push({
          type: r.type as MeasurementType,
          measuredAt: movedFrom,
        });
      }
      for (const dirty of verdict.dirtyIdentities ?? []) {
        touched.push({ type: dirty.type, measuredAt: dirty.measuredAt });
      }
    }
    annotate({
      meta: {
        "googleHealth.naturalKeyConflicts": conflicts.length,
        "googleHealth.naturalKeyConflictsResolved": resolved,
      },
    });
  }

  // Fresh inserts: chunked `createMany` (server-owned rows, field-by-field).
  // `skipDuplicates` guards the partial-unique index in the rare race where a
  // concurrent run inserted the same live key between the probe and the write.
  for (let i = 0; i < toCreate.length; i += GOOGLE_HEALTH_CREATE_CHUNK) {
    const chunk = toCreate.slice(i, i + GOOGLE_HEALTH_CREATE_CHUNK);
    try {
      const inserted = await prisma.measurement.createManyAndReturn({
        data: chunk.map((c) => ({
          userId,
          type: c.type,
          source: "GOOGLE_HEALTH" as const,
          value: c.value,
          unit: c.unit,
          measuredAt: c.measuredAt,
          externalId: c.externalId,
          sleepStage: c.sleepStage,
        })),
        skipDuplicates: true,
        select: { id: true, type: true, measuredAt: true },
      });
      imported += inserted.length;
      insertedRows.push(...inserted);
      void emitInsertedMeasurementArrivals(
        userId,
        inserted,
        "google_health",
      ).catch(() => {});
      for (const c of chunk) {
        touched.push({ type: c.type, measuredAt: c.measuredAt });
      }
    } catch (err) {
      getEvent()?.addWarning(
        `google-health: failed to create measurements: ${err}`,
      );
      // Fetched-but-unwritten rows are lost for good once they age out of the
      // 24 h overlap — fail the cycle's verdict so the watermark holds and the
      // next tick re-fetches them. No rethrow: sibling chunks and resources
      // must keep writing.
      noteHardFailure("measurements:create");
    }
  }

  // On a `fullSync` backfill the caller defers the rollup fold: it collapses
  // every resource's touched type-days into a SINGLE range-recompute at the end
  // of the cycle. The incremental path keeps the inline per-day hook here.
  if (opts.deferRollup) {
    const tracker = rollupDeferStorage.getStore();
    // Collapsed to type-days on the way in: `touched` carries ONE entry PER
    // READING, and the tracker lives for the whole cycle, so keeping the raw
    // entries made the ledger grow with the stream (a million-reading
    // heart-rate backfill held a million of them to describe a few hundred
    // days).
    if (tracker) {
      for (const k of collapseToTypeDayKeys(touched)) {
        tracker.keys.set(`${k.type}|${k.measuredAt.getTime()}`, k);
      }
    }
    noteGoogleHealthWritten(imported);
    return { imported, touched, inserted: insertedRows };
  }

  // The arrivals went out per chunk above; the shared tail folds, marks the
  // caches and re-warms the status cards. A failed fold fails the verdict.
  const { rollupFailed } = await afterProviderWrite({
    userId,
    provider: "google-health",
    touched,
  });
  if (rollupFailed) noteHardFailure("rollup");

  noteGoogleHealthWritten(imported);
  return { imported, touched, inserted: insertedRows };
}

/**
 * Stamp `lastSyncedAt`. Called ONCE per cycle by `syncUserGoogleHealth` after
 * a non-degenerate run — never per resource, so the watermark can't move
 * mid-cycle and shrink a later resource's fetch window. The orchestrator
 * passes the instant the cycle STARTED: a sample written to Google while the
 * cycle was still walking is newer than what the walk read, and stamping the
 * end would put the watermark past it. That gap is seconds for an hourly run
 * and hours for a full-history backfill.
 */
export async function markSynced(
  userId: string,
  at: Date = new Date(),
): Promise<void> {
  await prisma.googleHealthConnection.update({
    where: { userId },
    data: { lastSyncedAt: at },
  });
}

/**
 * Map a Google Health response classification onto a `FailureKind` and record
 * it. Shared by the token-refresh path and every per-resource catch block.
 */
export async function recordGoogleHealthSyncFailure(
  userId: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await recordSyncFailure({
    userId,
    integration: GOOGLE_HEALTH_INTEGRATION_KEY,
    kind: classificationToFailureKind(classifyGoogleHealthError(err)),
    message,
    errorCode:
      err instanceof GoogleHealthApiError
        ? err.httpStatus?.toString()
        : undefined,
  });
}

export function classificationToFailureKind(
  classification: GoogleHealthClassification,
): FailureKind {
  switch (classification) {
    case "reauth_required":
      return "reauth_required";
    case "persistent":
      return "persistent";
    case "transient":
      return "transient";
    case "success":
      // A caller asking for the FailureKind of a success is a contract bug;
      // surface it as transient so the audit log still records the anomaly.
      return "transient";
  }
}
