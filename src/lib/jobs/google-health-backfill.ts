/**
 * v1.26.0 — pg-boss queue + boot-time self-converging backfill for newly
 * connected Google Health accounts. Modelled on the Fitbit / WHOOP backfill
 * (`src/lib/fitbit/jobs/backfill.ts`): a discovery query enqueues one job per
 * connection that has NOT yet been backfilled, and the pass is idempotent
 * across reboots (the predicate `backfill_completed_at IS NULL` drops a
 * connection once its backfill finishes).
 *
 * The queue name MUST be registered in `allQueues` in
 * `src/lib/jobs/reminder/register-integration-sync.ts` or pg-boss never
 * provisions it and the boot enqueue silently never drains (the v1.4.37
 * dead-queue class).
 */
import { OWNED_BY_ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  enqueueIntegrationBackfillAdmission,
  INTEGRATION_BACKFILL_ADMISSION_QUEUE,
  INTEGRATION_BACKFILL_CONTINUATION_DELAY_SECONDS,
  integrationBackfillAdmissionSendOptions,
  integrationBackfillIdentity,
  integrationBackfillSourceOptions,
  type IntegrationBackfillAdmissionPayload,
} from "@/lib/jobs/integration-backfill-admission";
import { runWithGoogleHealthBackfillResume } from "@/lib/google-health/sync-core";
import {
  googleHealthBackfillProgressAfterCompletion,
  googleHealthBackfillRetryPending,
  readGoogleHealthBackfillProgress,
} from "@/lib/google-health/backfill-progress";
import { googleHealthBackfillEndIsFinal } from "@/lib/google-health/backfill-bounds";
import {
  isGoogleHealthParked,
  syncUserGoogleHealth,
} from "@/lib/google-health/sync";
import { GOOGLE_HEALTH_SYNC_LOCK_WAIT_MS } from "@/lib/google-health/sync-lock";
import {
  googleHealthSliceBudget,
  type GoogleHealthSliceStopReason,
  runWithGoogleHealthStop,
} from "@/lib/google-health/budget";
import { reportJobProgress } from "@/lib/jobs/job-observer";
import { LANE_YIELD_DELAY_SECONDS, laneWanted } from "@/lib/jobs/heavy-lane";
import { GOOGLE_HEALTH_COLLECTION_KEYS } from "@/lib/google-health/collection-keys";
import { GOOGLE_HEALTH_BACKFILL_QUEUE } from "./google-health-backfill-queue";

/**
 * One slice of a backfill: how long it walks and how many pages it reads
 * before it lets go of the account and hands the rest to the next slice.
 *
 * Far inside the admission job's expiry (sixteen hours) on purpose. A slice
 * holds the account's sync lock while it walks, and the hourly sync of that
 * account waits for the lock (`GOOGLE_HEALTH_POLL_LOCK_WAIT_MS`), so a slice
 * has to be short enough for the hourly sync to get its turn: before slices,
 * one attempt held the lock for as long as the import ran and every hourly
 * sync of the account in that time was skipped. The page budget keeps a
 * slice on a fast link from spending a whole quota window in one go.
 */
export const GOOGLE_HEALTH_BACKFILL_SLICE_MS = 5 * 60 * 1000;
export const GOOGLE_HEALTH_BACKFILL_SLICE_PAGES = 500;

/**
 * The pause before the next slice when this one ended on a rate limit it
 * could not wait out: long enough for Google's per-minute window to refill
 * several times over, so the next slice does not open on the same 429.
 */
export const GOOGLE_HEALTH_BACKFILL_THROTTLED_DELAY_SECONDS = 5 * 60;

/**
 * How long a chain of slices may keep going, run back to back, before it is
 * taken for counting progress it does not make: sixty days.
 */
const GOOGLE_HEALTH_BACKFILL_MAX_CHAIN_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * The highest slice a backfill chain may reach: every collection once, the
 * slices sixty days of back-to-back slicing hold, and two of slack for the
 * first slice and the one that stamps the marker.
 *
 * A slice is continued only when it made progress that is on disk: it
 * finished a collection (or ended one short, at the horizon or on a walk
 * that stopped getting anywhere), it moved a resumable collection's edge
 * back after writing at least one page, or a walk without the edge bound
 * saved a place in the list further than any before it. Each of those moves
 * toward an end the backfill has (the edge cannot pass the horizon, and a
 * walk that repeats itself is stopped, see `backfill-bounds.ts`), so this
 * ceiling bounds nothing a working backfill reaches. It used to be derived
 * from a page count that a dense heart-rate history passes in under three
 * years (#1220); in time it stays meaningful however densely a device
 * records. In practice a chain is a handful of slices per year of dense
 * history. A slice past this fails rather than queueing another.
 */
export const GOOGLE_HEALTH_BACKFILL_MAX_SLICE =
  GOOGLE_HEALTH_COLLECTION_KEYS.length +
  Math.ceil(
    GOOGLE_HEALTH_BACKFILL_MAX_CHAIN_MS / GOOGLE_HEALTH_BACKFILL_SLICE_MS,
  ) +
  2;

/**
 * The singleton key of a slice that waits for a parked collection's retry:
 * the import's identity and the instant the retry is due. The instant comes
 * from the stored note, so every slice that reads the same note derives the
 * same key.
 */
export function googleHealthBackfillRetryKey(
  userId: string,
  dueAt: number,
): string {
  const identity = integrationBackfillIdentity({
    kind: "google-health-backfill",
    data: { userId, enqueuedAt: "" },
  });
  return `${identity}|retry-${new Date(dueAt).toISOString()}`;
}

/**
 * The pause before the next slice, by why this one stopped: longer after a
 * rate limit, and past the waiting job's return after giving way to it, so
 * that job takes the lane before this import does again.
 */
export function nextSliceDelaySeconds(
  stopReason: GoogleHealthSliceStopReason | null,
): number {
  if (stopReason === "rate_limited") {
    return GOOGLE_HEALTH_BACKFILL_THROTTLED_DELAY_SECONDS;
  }
  if (stopReason === "lane_wanted") return LANE_YIELD_DELAY_SECONDS;
  return INTEGRATION_BACKFILL_CONTINUATION_DELAY_SECONDS;
}

/** Test seam: a slice's budget, when not the production one. */
export interface GoogleHealthBackfillSliceOptions {
  sliceMs?: number;
  slicePages?: number;
}

export interface GoogleHealthBackfillPayload {
  userId: string;
  enqueuedAt: string;
}

/**
 * Per-user backfill handler. Runs one slice of a full-history sync for one
 * account and stamps `backfillCompletedAt` ONLY on a clean run, so the
 * discovery query drops it. Idempotent: the per-resource upserts are
 * key-stable, so a re-run (e.g. a reboot mid-walk) overwrites rather than
 * duplicating. Mirrors `runFitbitBackfillForUser`.
 *
 * Verdict-gated: a partial hard failure (one collection 400ing, a write
 * failing) is not complete, and stamping the marker over a partial walk would
 * freeze the gap in forever. A connection parked at `error_reauth` is NOT
 * clean either, but throwing against a dead grant would just burn the retry
 * budget on the same no-op: return WITHOUT stamping — the boot discovery
 * re-enqueues the account on the next boot, and the stamp lands once the user
 * reconnects and a clean walk completes.
 *
 * Resumable at two grains (`GoogleHealthBackfillCursor`): every collection the
 * walk finishes cleanly is noted in `backfillProgress.done` and skipped from
 * then on, and every spot-reading collection notes the edge it has written up
 * to after each page, so the next attempt starts there instead of at the
 * newest page. The note is cleared once the stamp lands, and on every
 * reconnect.
 *
 * Runs in slices. A slice walks until its own budget is spent
 * (`GOOGLE_HEALTH_BACKFILL_SLICE_MS` / `_PAGES`), Google throttles it past
 * what a wait covers, or the job's budget (`shouldStop`) runs out, and then
 * lets go of the account. A slice that made progress on disk (a collection
 * finished, an edge moved) is not a failure: it sends the next slice
 * (`slice + 1`) and returns `continued`, without the error line or the
 * queue's failure count. Only a slice that moved nothing throws, with what
 * each collection came to in the message, because that one is stuck: the
 * pg-boss retry and, after it, the next boot take it from there. The chain is
 * capped at `GOOGLE_HEALTH_BACKFILL_MAX_SLICE`.
 *
 * What the slice did is annotated on the run's event as
 * `googleHealth.backfill.slice` (see `docs/integrations/google-health.md`).
 *
 * Never beside another run of the same account: the sync takes the account's
 * lock, waiting a bounded time for an hourly or manual run to finish. If the
 * lock does not come free the attempt throws without doing anything, and the
 * retry tries again.
 */
export async function runGoogleHealthBackfillForUser(
  userId: string,
  shouldStop: () => boolean = () => false,
  slice: number = 0,
  sliceOptions: GoogleHealthBackfillSliceOptions = {},
): Promise<{ imported: number; continued?: boolean }> {
  if (slice > GOOGLE_HEALTH_BACKFILL_MAX_SLICE) {
    annotate({
      action: {
        name: "google_health.backfill.slice_ceiling",
        details: { slice, maxSlice: GOOGLE_HEALTH_BACKFILL_MAX_SLICE },
      },
    });
    throw new Error(
      `google-health backfill for user ${userId} reached slice ${slice}, past the ceiling of ${GOOGLE_HEALTH_BACKFILL_MAX_SLICE}`,
    );
  }
  if (await isGoogleHealthParked(userId)) {
    annotate({
      action: {
        name: "google_health.backfill.skipped_reauth",
        details: { imported: 0 },
      },
    });
    return { imported: 0 };
  }

  const connection = await prisma.googleHealthConnection.findUnique({
    where: { userId },
    select: { backfillProgress: true, backfillCompletedAt: true },
  });
  if (connection?.backfillCompletedAt) {
    // A slice queued behind the one that finished the import, or a boot
    // delivery that raced it: the history is in, nothing to walk again.
    annotate({
      action: {
        name: "google_health.backfill.already_complete",
        details: { slice },
      },
    });
    return { imported: 0 };
  }
  const {
    done,
    cursors,
    edgeFilterUnsupported,
    ended: endedBefore,
  } = readGoogleHealthBackfillProgress(connection?.backfillProgress);
  // A collection that ended short for good has read all it is going to, so
  // it counts as finished alongside the ones read to the end. One parked
  // after a first end without progress does not: it waits for another try.
  const finishedCount = (): number =>
    new Set([
      ...done,
      ...[...endedBefore]
        .filter(([, e]) => googleHealthBackfillEndIsFinal(e))
        .map(([key]) => key),
    ]).size;
  const doneBefore = finishedCount();
  const parkedBefore = new Set(
    googleHealthBackfillRetryPending(endedBefore)?.keys ?? [],
  );

  const budget = googleHealthSliceBudget(
    sliceOptions.sliceMs ?? GOOGLE_HEALTH_BACKFILL_SLICE_MS,
    sliceOptions.slicePages ?? GOOGLE_HEALTH_BACKFILL_SLICE_PAGES,
    Date.now,
    laneWanted,
  );
  const startedAt = Date.now();
  const {
    result: { imported, failed, busy },
    skipped,
    advanced,
    collections,
    ended,
  } = await runWithGoogleHealthBackfillResume(
    userId,
    done,
    () =>
      runWithGoogleHealthStop(
        shouldStop,
        () =>
          syncUserGoogleHealth(userId, {
            fullSync: true,
            waitForLockMs: GOOGLE_HEALTH_SYNC_LOCK_WAIT_MS,
          }),
        budget,
      ),
    cursors,
    edgeFilterUnsupported,
    endedBefore,
  );

  // `ended` is `endedBefore`, grown by this slice.
  const doneAfter = finishedCount();
  const finished = doneAfter - doneBefore;
  const sliceReport = {
    slice,
    elapsedMs: Date.now() - startedAt,
    pages: budget.pages,
    // Of those, the pages read only to pass over samples beyond an edge,
    // where Google refused the edge filter.
    skippedPages: budget.skippedPages,
    stopReason: budget.stopReason,
    imported,
    collectionsDone: doneAfter,
    collectionsTotal: GOOGLE_HEALTH_COLLECTION_KEYS.length,
    collectionsFinished: finished,
    resumedPast: skipped.length,
    collections,
    // Where each unfinished resumable collection has got to, after this slice.
    edges: Object.fromEntries([...cursors].map(([key, c]) => [key, c.at])),
    // Collections ended short of their history's start, and where.
    ...(ended.size > 0 ? { ended: Object.fromEntries(ended) } : {}),
  };
  annotate({ meta: { "googleHealth.backfill.slice": sliceReport } });
  reportJobProgress({
    google_health_backfill_slice: slice,
    google_health_backfill_pages: budget.pages,
    google_health_backfill_collections_done: doneAfter,
  });

  if (busy) {
    throw new Error(
      `google-health backfill for user ${userId} deferred: another sync of the account is running`,
    );
  }

  /**
   * Queue the next slice. A slice that waits for a parked collection's retry
   * goes under a key named after when the retry is due, instead of its slice
   * number: every slice that meets the same wait, a boot's included, names the
   * same job, and the queue keeps one. Under the slice number a boot during
   * the day-long wait started a second chain beside the waiting one.
   */
  const sendNextSlice = async (
    delaySeconds: number,
    retryDueAt?: number,
  ): Promise<boolean> => {
    if (slice + 1 > GOOGLE_HEALTH_BACKFILL_MAX_SLICE) return false;
    const boss = getGlobalBoss();
    if (!boss) return false;
    const payload: IntegrationBackfillAdmissionPayload = {
      kind: "google-health-backfill",
      data: {
        userId,
        enqueuedAt: new Date().toISOString(),
        slice: slice + 1,
      },
    };
    const sent =
      retryDueAt === undefined
        ? await enqueueIntegrationBackfillAdmission(boss, payload, delaySeconds)
        : await boss.send(INTEGRATION_BACKFILL_ADMISSION_QUEUE, payload, {
            ...integrationBackfillAdmissionSendOptions(payload),
            singletonKey: googleHealthBackfillRetryKey(userId, retryDueAt),
            startAfter: delaySeconds,
          });
    return Boolean(sent);
  };

  // Collections parked after a first end without progress
  // (`backfill-bounds.ts`). Once nothing else is left, the next slice waits
  // until the earliest of them is due; the marker is never stamped over one.
  const pending = googleHealthBackfillRetryPending(ended);
  const onlyRetriesLeft =
    pending !== null &&
    GOOGLE_HEALTH_COLLECTION_KEYS.every(
      (key) => done.has(key) || pending.keys.includes(key),
    );
  if (pending && (onlyRetriesLeft || !failed)) {
    const waitSeconds = Math.ceil((pending.dueAt - Date.now()) / 1000);
    const delaySeconds = Math.max(
      INTEGRATION_BACKFILL_CONTINUATION_DELAY_SECONDS,
      waitSeconds,
    );
    // A retry already due is an ordinary next slice; only a wait is keyed on
    // when it ends.
    const delayed =
      waitSeconds > INTEGRATION_BACKFILL_CONTINUATION_DELAY_SECONDS;
    if (
      await sendNextSlice(delaySeconds, delayed ? pending.dueAt : undefined)
    ) {
      annotate({
        action: {
          name: "google_health.backfill.retry_scheduled",
          details: { slice, collections: pending.keys, delaySeconds },
        },
      });
      return { imported, continued: true };
    }
    // Not queued: most often the same retry is already waiting, sent by the
    // slice that parked the collection, and this is a boot's slice meeting
    // the same wait. Nothing is lost either way: the marker is not stamped,
    // so the next boot offers the backfill again.
    annotate({
      action: {
        name: "google_health.backfill.retry_not_queued",
        details: { slice, collections: pending.keys },
      },
    });
    return { imported };
  }

  if (failed) {
    // Progress is what this slice put on disk: collections finished, edges
    // moved, or a collection parked for another attempt. Any is enough to go
    // on; none means stuck.
    const newlyParked = (pending?.keys ?? []).filter(
      (key) => !parkedBefore.has(key),
    ).length;
    const progressed = finished > 0 || advanced.size > 0 || newlyParked > 0;
    if (progressed) {
      const sent = await sendNextSlice(
        nextSliceDelaySeconds(budget.stopReason),
      );
      if (sent) {
        annotate({
          action: {
            name: "google_health.backfill.continued",
            details: {
              imported,
              slice,
              stopReason: budget.stopReason,
              collectionsFinished: finished,
              collectionsDone: doneAfter,
              edgesMoved: [...advanced.keys()],
            },
          },
        });
        return { imported, continued: true };
      }
      // No follow-up could be queued; fall through to the retry path so the
      // work is not dropped.
    }
    // Nothing moved in this slice: the backfill is stuck, not slow. Surface
    // through the pg-boss retry path (retryLimit 3, backoff) with what each
    // collection came to, so the log line says where it is stuck. If the
    // failure parked the connection at error_reauth meanwhile, the next
    // attempt takes the reauth return above instead of failing again.
    annotate({
      action: {
        name: "google_health.backfill.stuck",
        details: { slice, stopReason: budget.stopReason },
      },
    });
    const where = collections
      .filter((c) => c.status !== "done")
      .map((c) => `${c.key}:${c.status}`)
      .join(",");
    throw new Error(
      `google-health backfill incomplete for user ${userId} — marker not stamped (no progress in slice ${slice}${budget.stopReason ? `, stopped on ${budget.stopReason}` : ""}${where ? `; ${where}` : ""})`,
    );
  }

  // The note of how far it got goes with the stamp, except where a
  // collection ended short: that stays, so the card can say where its
  // history ends and why.
  const kept = googleHealthBackfillProgressAfterCompletion(ended);
  await prisma.googleHealthConnection.update({
    where: { userId },
    data: {
      backfillCompletedAt: new Date(),
      backfillProgress: kept ?? Prisma.DbNull,
    },
  });

  annotate({
    action: {
      name: "google_health.backfill.complete",
      details: { imported, slice },
    },
  });
  return { imported };
}

/**
 * Boot-time discovery. Finds every Google Health connection not yet backfilled
 * (`backfill_completed_at IS NULL`) and enqueues one backfill job per account.
 *
 * Idempotent across reboots: once a connection's backfill completes,
 * `backfillCompletedAt` is set and the predicate drops it from the discovery
 * set. pg-boss `singletonKey` coalesces duplicate sends so a fast restart while
 * a job is queued doesn't double up.
 *
 * Best-effort: errors are returned through the result value so the worker boot
 * never fails because of a backfill miss.
 */
export async function enqueueBootTimeGoogleHealthBackfill(
  startAfterSeconds: number = 0,
): Promise<{
  enqueued: number;
  skipped: number;
  error: string | null;
}> {
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    const connections = await prisma.googleHealthConnection.findMany({
      where: { backfillCompletedAt: null, ...OWNED_BY_ACTIVE_ACCOUNT },
      select: { userId: true },
    });

    if (connections.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const { userId } of connections) {
      const payload: GoogleHealthBackfillPayload = {
        userId,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(
        GOOGLE_HEALTH_BACKFILL_QUEUE,
        payload,
        integrationBackfillSourceOptions(
          `google-health-backfill|${userId}`,
          startAfterSeconds,
        ),
      );
      if (jobId) {
        enqueued += 1;
      } else {
        skipped += 1;
      }
    }
    return { enqueued, skipped, error: null };
  } catch (err) {
    return {
      enqueued: 0,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
