/**
 * v1.28.x — pg-boss queue + boot-time self-converging backfill for newly
 * connected Strava accounts. Modelled on the WHOOP / Fitbit backfill: a
 * discovery query enqueues one job per connection that has NOT yet been
 * backfilled, and the pass is idempotent across reboots (the predicate
 * `strava_backfill_completed_at IS NULL` drops a connection once its backfill
 * finishes).
 *
 * Unlike WHOOP/Fitbit (which carry the marker on a dedicated connection table),
 * Strava rides `User` columns like Oura/Polar, so the marker is
 * `User.stravaBackfillCompletedAt`.
 *
 * The queue name MUST be registered in `allQueues` in
 * `register-integration-sync.ts` or pg-boss never provisions it and the boot
 * enqueue silently never drains (the v1.4.37 dead-queue class).
 */
import { ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  enqueueIntegrationBackfillAdmission,
  integrationBackfillSourceOptions,
} from "@/lib/jobs/integration-backfill-admission";
import { isReauthRequired } from "@/lib/integrations/status";
import {
  backfillVerdict,
  withPageWalkLedger,
} from "@/lib/integrations/page-walk";
import { syncStravaHistory } from "@/lib/strava/sync";
import { STRAVA_BACKFILL_QUEUE } from "./strava-backfill-queue";

export interface StravaBackfillPayload {
  userId: string;
  enqueuedAt: string;
}

/**
 * The pause before the next run of an unfinished backfill: Strava's
 * short-term rate window. One run spends up to forty page reads and 150
 * detail reads of the 200 the app may make in fifteen minutes, so the next
 * run waits for a fresh window rather than opening on a 429 or starving the
 * hourly syncs.
 */
export const STRAVA_BACKFILL_CONTINUATION_DELAY_SECONDS = 15 * 60;

/**
 * Per-user backfill handler. Runs one stretch of the full-history walk for
 * one account and stamps `stravaBackfillCompletedAt` only when the walk read
 * to the start of the history, so the discovery query drops it. Idempotent:
 * the `(userId, source, externalId)` workout upsert is key-stable, so a re-run
 * (e.g. a reboot mid-walk) overwrites rather than duplicating.
 *
 * Verdict-gated (`backfillVerdict`, `integrations/page-walk.ts`), like the
 * WHOOP and Fitbit backfills. A failed sync throws out of the walk (failure
 * recorded first) and pg-boss retries. A walk that reached its page ceiling
 * with history left is not complete: it records where it got to
 * (`stravaBackfillResumeBefore`, the start of the oldest activity it read)
 * and sends the next run for after the rate window, which asks for the
 * activities before that point. Without the note every run began again at
 * the newest page, read the same forty pages and never reached the rest. A
 * run that got no further than the last one records nothing and sends
 * nothing, and the next boot offers the account again. A connection parked
 * for re-authorisation returns without stamping and without a retry, since
 * every attempt would meet the same dead grant.
 */
export async function runStravaBackfillForUser(
  userId: string,
  slice: number = 0,
): Promise<{ imported: number; continued: boolean }> {
  if (await isReauthRequired(userId, "strava")) {
    annotate({
      action: {
        name: "strava.backfill.skipped_reauth",
        details: { imported: 0 },
      },
    });
    return { imported: 0, continued: false };
  }

  const stored = await prisma.user.findUnique({
    where: { id: userId },
    select: { stravaBackfillResumeBefore: true },
  });
  const before = stored?.stravaBackfillResumeBefore ?? undefined;
  const { result, truncated } = await withPageWalkLedger(() =>
    syncStravaHistory(userId, before),
  );
  const { imported, oldestStart, retryAfterSeconds } = result;
  // A failure has already thrown; what is left to decide is whether the walk
  // reached the beginning of the history.
  if (backfillVerdict({ failed: false, truncated }) === "incomplete") {
    // One second past the oldest start, so an activity that shares it is
    // read again rather than skipped; the upsert makes the overlap free.
    const resumeBefore = oldestStart
      ? new Date(oldestStart.getTime() + 1000)
      : null;
    const progressed =
      resumeBefore !== null &&
      (before === undefined || resumeBefore.getTime() < before.getTime());
    if (progressed) {
      await prisma.user.update({
        where: { id: userId },
        data: { stravaBackfillResumeBefore: resumeBefore },
      });
    }
    // A run Strava's rate limit ended goes on once the window it named has
    // reset, progress or not: the limit is the app's, and passes.
    const continued =
      (progressed || retryAfterSeconds !== undefined) &&
      (await sendNextRun(
        userId,
        slice,
        Math.max(
          STRAVA_BACKFILL_CONTINUATION_DELAY_SECONDS,
          retryAfterSeconds ?? 0,
        ),
      ));
    annotate({
      action: {
        name: "strava.backfill.truncated",
        details: {
          imported,
          collections: truncated.join(","),
          progressed,
          continued,
        },
      },
    });
    return { imported, continued };
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      stravaBackfillCompletedAt: new Date(),
      stravaBackfillResumeBefore: null,
    },
  });

  annotate({
    action: {
      name: "strava.backfill.complete",
      details: { imported },
    },
  });
  return { imported, continued: false };
}

async function sendNextRun(
  userId: string,
  slice: number,
  delaySeconds: number,
): Promise<boolean> {
  const boss = getGlobalBoss();
  if (!boss) return false;
  const sent = await enqueueIntegrationBackfillAdmission(
    boss,
    {
      kind: "strava-backfill",
      data: { userId, enqueuedAt: new Date().toISOString(), slice: slice + 1 },
    },
    delaySeconds,
  );
  return Boolean(sent);
}

/**
 * Boot-time discovery. Finds every Strava connection not yet backfilled
 * (a stored access token + `strava_backfill_completed_at IS NULL`) and enqueues
 * one backfill job per account.
 *
 * Idempotent across reboots: once a connection's backfill completes,
 * `stravaBackfillCompletedAt` is set and the predicate drops it. pg-boss
 * `singletonKey` coalesces duplicate sends so a fast restart while a job is
 * queued doesn't double up.
 *
 * Best-effort: errors come back through the result value so the worker boot
 * never fails because of a backfill miss.
 */
export async function enqueueBootTimeStravaBackfill(
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
    const connections = await prisma.user.findMany({
      where: {
        stravaAccessTokenEncrypted: { not: null },
        stravaBackfillCompletedAt: null,
        ...ACTIVE_ACCOUNT,
      },
      select: { id: true },
    });

    if (connections.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const { id: userId } of connections) {
      const payload: StravaBackfillPayload = {
        userId,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(
        STRAVA_BACKFILL_QUEUE,
        payload,
        integrationBackfillSourceOptions(
          `strava-backfill|${userId}`,
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
