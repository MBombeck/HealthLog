/**
 * How the dense fold (`dense-intraday-retention.ts`) removes the raw samples
 * of a day it folded, and how the change feed learns of it.
 *
 * Apple Health and Health Connect samples are deleted outright (v1.42), like
 * the cumulative drain's rows, where they used to be tombstoned for the
 * 75-day retention. They come from the person's own health store and no
 * client reads them from `/api/sync/changes`, so the tombstone told nobody
 * anything; it only held the re-upload of a folded sample off, and the
 * `folded_window` ingest guard (`folded-window.ts`) does that now from the
 * live hourly row. The tombstones made up most of the table and its indexes.
 *
 * A server-pulled source (`SERVER_PULLED_FOLD_SOURCES`: Google Health, Oura)
 * is different. The feed served its samples, and a client mirroring the feed
 * keeps them until the feed says they are gone. So:
 *   - the nightly increment, a day at most {@link FOLD_FEED_TOMBSTONE_DAYS}
 *     past the retention boundary, is tombstoned. The feed reports every
 *     sample, and the 75-day tombstone cleanup purges them later. The
 *     classifier of compaction tombstones leaves these sources out, so the
 *     feed, the backlog purge and the restore treat them like any deletion.
 *   - an older day is backlog: an account's first fold, an old range a
 *     backfill brought in, nights the fold did not run. Tombstoning that
 *     would put millions of rows back into the table (#1297), so its samples
 *     are deleted outright and the account's delta cursors expire instead
 *     (`stampSyncReset`). A client that pulled them re-initialises rather
 *     than keep them beside the hourly means.
 * The tombstones share one deletion instant and keep their `syncVersion`, so
 * the re-fold reads them as fold leftovers (`fold-constituents.ts`), exactly
 * like the Apple Health tombstones of the releases before v1.42.
 */
import type { MeasurementSource, Prisma } from "@/generated/prisma/client";
import { stampSyncReset } from "@/lib/sync/reset";

import { SERVER_PULLED_FOLD_SOURCES } from "./dense-intraday-sources";
import { absorbIntoFold } from "./fold-constituents";

/** Days past the retention boundary that still count as the nightly fold. */
const FOLD_FEED_TOMBSTONE_DAYS = 7;

const DAY_MS = 86_400_000;

export type FoldRemoval = "delete" | "tombstone" | "delete-and-reset";

/** How a fold removes the samples of one local day. Pure. */
export function foldRemovalFor(
  source: MeasurementSource,
  dayStart: Date,
  retentionDays: number,
  now: Date = new Date(),
): FoldRemoval {
  if (!SERVER_PULLED_FOLD_SOURCES.has(source)) return "delete";
  const nightly =
    now.getTime() - (retentionDays + FOLD_FEED_TOMBSTONE_DAYS) * DAY_MS;
  return dayStart.getTime() >= nightly ? "tombstone" : "delete-and-reset";
}

/**
 * Remove the folded samples `ids`, never one of `keep` (the hourly rows the
 * fold just adopted), inside the fold's transaction. Returns how many went
 * and whether the account's delta cursors were expired. The caller stamps
 * the reset once more after the commit, so a cursor issued while the
 * transaction ran expires too; the stamp in here survives a crash after it.
 */
export async function removeFoldedSamples(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    removal: FoldRemoval;
    ids: readonly string[];
    keep: readonly string[];
  },
): Promise<{ removed: number; resetFeed: boolean }> {
  if (input.removal === "tombstone") {
    const removed = await absorbIntoFold(
      tx,
      input.ids.filter((id) => !input.keep.includes(id)),
    );
    return { removed, resetFeed: false };
  }
  const del = await tx.measurement.deleteMany({
    where: {
      id: { in: [...input.ids], notIn: [...input.keep] },
      deletedAt: null,
    },
  });
  const resetFeed = input.removal === "delete-and-reset" && del.count > 0;
  if (resetFeed) await stampSyncReset(tx, input.userId);
  return { removed: del.count, resetFeed };
}
