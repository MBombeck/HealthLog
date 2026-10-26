/**
 * The sync checkpoint and the HealthKit stamps a batch sets on the account.
 *
 * This batch route is the native ingestion boundary, so it is also where the
 * SyncMode checkpoint (`User.lastSyncedAt`, the same column
 * `markSyncCheckpoint` writes) is established — `GET /api/sync/state` only
 * reports it. The checkpoint covers MANUAL pushes too: the client synced
 * whatever it was holding. A batch carrying a hard failure leaves the
 * checkpoint where it was, so the undelivered window stays inside whatever
 * the client asks for next.
 *
 * The HealthKit fields ride the same update and keep their narrower
 * condition. Stamp only after every attempted write has reached a durable,
 * non-failed verdict; MANUAL-only and skipped-only batches are not
 * HealthKit syncs.
 *
 * The trigger the client declared is stamped alongside, and a background- or
 * push-triggered batch additionally dates `healthKitLastBackgroundSyncAt`.
 * Without that second timestamp there is no way to tell a phone that delivers
 * on its own from one that only ever delivers while the app is open — both
 * look like a moving `healthKitLastSyncedAt`. A batch that declares no
 * trigger writes null over the previous value rather than leaving a stale one
 * standing: the field describes THIS sync, and an older build's silence is
 * not evidence about it.
 *
 * None of that is true of a scoped credential, which is why it is excluded
 * from the whole block rather than only from the HealthKit half. The
 * checkpoint's meaning is "the client synced what it was holding", and a
 * third-party bridge is not the client and holds nothing on its behalf.
 * `lastSyncedAt` is what `GET /api/sync/state` reports and what the phone
 * uses to size its undelivered window, so letting a scale advance it can make
 * the phone skip a window of its own samples — a silent data loss whose cause
 * would be nowhere near the code that caused it.
 *
 * A `backfill` batch (ios #77) is a catch-up, not a sync. It records its
 * types under `lastBackfillAt` only and moves none of the live stamps:
 * thirty days of history must not read as thirty healthy daily syncs.
 */
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import {
  BACKFILL_SYNC_TRIGGER,
  recordHealthKitTypeArrivals,
  tallyHealthKitArrivals,
  type HealthKitRequestSyncTrigger,
} from "@/lib/integrations/healthkit-type-sync";
import type { HourBucketWrite } from "@/lib/measurements/intraday-hour-buckets";

import type { EntryResult, PreparedEntry } from "./entries";

export async function stampSyncCheckpoint(args: {
  userId: string;
  scoped: boolean;
  syncTrigger: HealthKitRequestSyncTrigger | undefined;
  prepared: PreparedEntry[];
  results: EntryResult[];
  failedCount: number;
  unchangedStatsRows: Set<PreparedEntry>;
  hourLanded: HourBucketWrite[];
  hourChanged: Set<HourBucketWrite>;
}): Promise<void> {
  const {
    userId,
    scoped,
    syncTrigger,
    prepared,
    results,
    failedCount,
    unchangedStatsRows,
    hourLanded,
    hourChanged,
  } = args;

  const healthKitSyncSucceeded =
    failedCount === 0 &&
    (hourLanded.length > 0 ||
      prepared.some((p) => {
        if ((p.entry.source ?? "APPLE_HEALTH") !== "APPLE_HEALTH") return false;
        const status = results[p.index]?.status;
        return (
          status === "inserted" ||
          status === "updated" ||
          status === "duplicate"
        );
      }));

  const backfill = syncTrigger === BACKFILL_SYNC_TRIGGER;
  if (failedCount === 0 && !scoped) {
    const syncedAt = new Date();
    const deliveredWithoutTheApp =
      syncTrigger === "background" || syncTrigger === "push";
    // Per-type arrivals for the Apple Health card (#1173), Apple Health rows
    // and hours only, under the checkpoint's conditions. Since #1259 only a
    // new or changed one brings something (`brought`).
    const arrivals = tallyHealthKitArrivals([
      ...prepared.flatMap((p) => {
        const status = results[p.index]?.status;
        if (p.row.source !== "APPLE_HEALTH" || !status) return [];
        if (status === "skipped" || status === "failed") return [];
        const unchanged = unchangedStatsRows.has(p);
        const brought = status !== "duplicate" && !unchanged;
        return [{ type: p.row.type as MeasurementType, brought }];
      }),
      ...hourLanded.map((w) => ({ type: w.type, brought: hourChanged.has(w) })),
    ]);
    if (arrivals.size > 0) {
      await recordHealthKitTypeArrivals(prisma, {
        userId,
        counts: arrivals,
        trigger: syncTrigger ?? null,
        at: syncedAt,
      });
    }
    if (!backfill) {
      await prisma.user.update({
        where: { id: userId },
        data: {
          lastSyncedAt: syncedAt,
          ...(healthKitSyncSucceeded
            ? {
                healthKitLastSyncedAt: syncedAt,
                healthKitLastSyncTrigger: syncTrigger ?? null,
                ...(deliveredWithoutTheApp
                  ? { healthKitLastBackgroundSyncAt: syncedAt }
                  : {}),
              }
            : {}),
        },
      });
    }
  }
}
