/**
 * v1.17.1 — one-shot sleep-timeline backfill for WHOOP + Withings.
 *
 * Two ingest-side stamp/shape fixes changed the stored sleep rows:
 *
 *  - WHOOP: the old mapper stamped all five per-stage DURATION totals on the
 *    one sleep-END instant (WHOOP v2 exposes no onset timestamps), so the
 *    hypnogram reconstructed every stage as a span touching the night's right
 *    edge — stacked, no clock times. The fix reconstructs an ordered,
 *    contiguous per-segment timeline with distinct `measuredAt` per segment and
 *    NEW indexed externalIds (`<sleep_id>:seg:<tag>:<i>`).
 *  - Withings: each segment was stamped with its START while every reader
 *    treats `measuredAt` as the END, shifting each night one segment-length
 *    earlier. The fix stamps the END.
 *
 * Both change the row's `measuredAt` (and, for WHOOP, the externalId), and the
 * unique index `(userId, type, measuredAt, source, sleepStage)` makes an
 * in-place UPDATE collision-prone. So the per-connection pass DELETES the
 * affected `SLEEP_DURATION` rows for that source, RE-SYNCS with the corrected
 * mapper (which re-folds the rollup tier in its tail), and stamps
 * `sleepTimelineBackfillAt` so the discovery query drops the connection.
 *
 * Idempotent across reboots: the discovery predicate is
 * `sleep_timeline_backfill_at IS NULL`, and a completed pass stamps the marker.
 * A reboot mid-pass re-runs delete + re-sync from scratch — the re-sync upserts
 * are key-stable, so the result converges.
 *
 * Modelled on `whoop-backfill.ts` / `fitbit-backfill.ts`. The queue name MUST
 * be registered in `allQueues` in `src/lib/jobs/reminder-worker.ts` or pg-boss
 * never provisions it and the boot enqueue silently never drains (the v1.4.37
 * dead-queue class).
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { integrationBackfillSourceOptions } from "@/lib/jobs/integration-backfill-admission";
import { syncUserWhoop } from "@/lib/whoop/sync";
import { syncUserSleep as syncWithingsSleep } from "@/lib/withings/sync-sleep";

export const SLEEP_TIMELINE_BACKFILL_QUEUE = "sleep-timeline-backfill";

/**
 * Serial concurrency — a pass deletes a source's sleep rows then walks a
 * re-sync that is rate-bounded by the upstream API cap. Concurrency-1 keeps it
 * from crowding the request pool, matching the other backfill queues.
 */
export const SLEEP_TIMELINE_BACKFILL_CONCURRENCY = 1;

export type SleepTimelineProvider = "WHOOP" | "WITHINGS";

export interface SleepTimelineBackfillPayload {
  userId: string;
  provider: SleepTimelineProvider;
  enqueuedAt: string;
}

/**
 * Delete the legacy `SLEEP_DURATION` rows for one source, then re-sync with the
 * corrected mapper. WHOOP runs a full-history sync (the segment externalIds are
 * new, so the deleted summary rows are not re-created); Withings re-syncs its
 * default trailing window with the corrected END stamp. The re-sync re-folds
 * the rollup tier in its own tail.
 */
export async function runSleepTimelineBackfillForUser(
  userId: string,
  provider: SleepTimelineProvider,
): Promise<{ deleted: number; imported: number }> {
  const { count: deleted } = await prisma.measurement.deleteMany({
    where: { userId, type: "SLEEP_DURATION", source: provider },
  });

  let imported = 0;
  if (provider === "WHOOP") {
    imported = await syncUserWhoop(userId, { fullSync: true });
    await prisma.whoopConnection.update({
      where: { userId },
      data: { sleepTimelineBackfillAt: new Date() },
    });
  } else {
    imported = await syncWithingsSleep(userId, { fullSync: true });
    await prisma.withingsConnection.update({
      where: { userId },
      data: { sleepTimelineBackfillAt: new Date() },
    });
  }

  annotate({
    action: {
      name: "sleep.timeline.backfill.complete",
      details: { provider, deleted, imported },
    },
  });
  return { deleted, imported };
}

/**
 * Boot-time discovery. Finds every WHOOP + Withings connection not yet
 * backfilled (`sleep_timeline_backfill_at IS NULL`) and enqueues one job per
 * (user, provider). Idempotent across reboots: a completed pass stamps the
 * marker, dropping the connection from the discovery set. pg-boss
 * `singletonKey` coalesces duplicate sends so a fast restart while a job is
 * queued doesn't double up.
 *
 * Best-effort: errors are returned through the result value so worker boot
 * never fails because of a backfill miss.
 */
export async function enqueueBootTimeSleepTimelineBackfill(
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
    const [whoop, withings] = await Promise.all([
      prisma.whoopConnection.findMany({
        where: { sleepTimelineBackfillAt: null },
        select: { userId: true },
      }),
      prisma.withingsConnection.findMany({
        where: { sleepTimelineBackfillAt: null },
        select: { userId: true },
      }),
    ]);

    const targets: Array<{ userId: string; provider: SleepTimelineProvider }> =
      [
        ...whoop.map((c) => ({ userId: c.userId, provider: "WHOOP" as const })),
        ...withings.map((c) => ({
          userId: c.userId,
          provider: "WITHINGS" as const,
        })),
      ];

    if (targets.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const { userId, provider } of targets) {
      const payload: SleepTimelineBackfillPayload = {
        userId,
        provider,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(
        SLEEP_TIMELINE_BACKFILL_QUEUE,
        payload,
        integrationBackfillSourceOptions(
          `sleep-timeline-backfill|${provider}|${userId}`,
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
