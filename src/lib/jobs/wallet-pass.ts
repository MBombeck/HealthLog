/**
 * The worker side of the Apple Wallet pass queues (v1.50); the names, crons
 * and sends live in `emergency-card/wallet-pass/queues.ts`.
 *
 * - refresh: rebuild one pass, unsigned, and push its devices when the
 *   content moved on. A push the throttle holds back is sent again for the
 *   moment the throttle opens.
 * - sweep: the same for every live pass, the guardian check of the passes a
 *   guardian made, and the retention of withdrawn passes (a year, so a
 *   device that was away can still fetch the withdrawn version).
 * - void push: every withdrawn pass whose devices have not heard of it,
 *   rebuilt in its withdrawn version and pushed without throttle.
 *
 * A pass that fails is counted and the run carries on; a run that cannot
 * read the table fails and the next tick is the retry.
 */
import { type Job } from "pg-boss";

import { prisma } from "@/lib/db";
import {
  owedRegistrations,
  pushOwedWalletUpdates,
  walletPassChangedAt,
} from "@/lib/emergency-card/wallet-pass/push";
import {
  enqueueWalletPassRefresh,
  type WalletPassRefreshPayload,
} from "@/lib/emergency-card/wallet-pass/queues";
import {
  refreshWalletPass,
  voidWalletPassById,
} from "@/lib/emergency-card/wallet-pass/service";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import { guardianMintRefusal } from "@/lib/sharing/guardian-minted";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Withdrawn passes stay this long, then go with their registrations. */
export const WALLET_VOIDED_RETENTION_DAYS = 365;
/** How far back the void push looks for devices still to tell. */
export const WALLET_VOID_PUSH_WINDOW_DAYS = 30;
/** Passes one sweep or void-push run takes on. */
const PASSES_PER_RUN = 2000;

interface Tally {
  refreshed: number;
  changed: number;
  accepted: number;
  dropped: number;
  deferred: number;
  failed: number;
}

const emptyTally = (): Tally => ({
  refreshed: 0,
  changed: 0,
  accepted: 0,
  dropped: 0,
  deferred: 0,
  failed: 0,
});

/** Rebuild one pass and push what is owed; a throttled push comes back. */
async function refreshAndPush(
  walletPassId: string,
  throttle: boolean,
  tally: Tally,
): Promise<void> {
  try {
    const refreshed = await refreshWalletPass(walletPassId);
    if (!refreshed) return;
    tally.refreshed += 1;
    if (refreshed.changed) tally.changed += 1;
    const pushed = await pushOwedWalletUpdates(walletPassId, { throttle });
    tally.accepted += pushed.accepted;
    tally.dropped += pushed.dropped;
    if (pushed.deferredUntil) {
      tally.deferred += 1;
      await enqueueWalletPassRefresh(
        walletPassId,
        (pushed.deferredUntil.getTime() - Date.now()) / 1000 + 1,
      );
    }
  } catch {
    tally.failed += 1;
  }
}

export async function handleWalletPassRefresh(
  jobs: Job<WalletPassRefreshPayload>[],
): Promise<JobOutcome> {
  return withBackgroundEvent("job.wallet_pass_refresh", async (evt) => {
    const tally = emptyTally();
    for (const job of jobs) {
      const id = job.data?.walletPassId;
      if (typeof id !== "string" || id.length === 0) continue;
      const pass = await prisma.walletPass.findUnique({
        where: { id },
        select: { voidedAt: true, link: { select: { revokedAt: true } } },
      });
      if (!pass) continue;
      // A withdrawn pass is the void push's; nothing to throttle there.
      const live = pass.voidedAt === null && pass.link.revokedAt === null;
      await refreshAndPush(id, live, tally);
    }
    evt.addMeta("wallet_passes_refreshed", tally.refreshed);
    return jobDone({
      wallet_passes_refreshed: tally.refreshed,
      wallet_passes_changed: tally.changed,
      wallet_pushes_accepted: tally.accepted,
      wallet_registrations_dropped: tally.dropped,
      wallet_passes_deferred: tally.deferred,
      items_failed: tally.failed,
    });
  });
}

export async function handleWalletPassSweep(
  jobs: Job<unknown>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.wallet_pass_sweep", async (evt) => {
    const now = new Date();
    try {
      // account-deletion: a deletion request withdraws the account's passes, so a live pass has an active owner.
      const live = await prisma.walletPass.findMany({
        where: { voidedAt: null, link: { revokedAt: null } },
        select: { id: true, userId: true, createdById: true },
        orderBy: { contentChangedAt: "asc" },
        take: PASSES_PER_RUN,
      });
      const tally = emptyTally();
      let voided = 0;
      for (const pass of live) {
        // A guardian's pass rests on the grant and the profile's marker,
        // the rule the QR link checks on every scan.
        if (pass.createdById !== pass.userId) {
          try {
            if (await guardianMintRefusal(pass)) {
              if (await voidWalletPassById(pass.id, "GUARDIAN_LOST", now)) {
                voided += 1;
              }
              continue;
            }
          } catch {
            tally.failed += 1;
            continue;
          }
        }
        await refreshAndPush(pass.id, true, tally);
      }
      const cutoff = new Date(
        now.getTime() - WALLET_VOIDED_RETENTION_DAYS * DAY_MS,
      );
      // account-deletion: retention of withdrawn passes, whatever their account's state.
      const deleted = await prisma.walletPass.deleteMany({
        where: {
          OR: [
            { voidedAt: { lt: cutoff } },
            { voidedAt: null, link: { revokedAt: { lt: cutoff } } },
          ],
        },
      });
      evt.addMeta("wallet_passes_refreshed", tally.refreshed);
      return jobDone({
        wallet_passes_refreshed: tally.refreshed,
        wallet_passes_changed: tally.changed,
        wallet_pushes_accepted: tally.accepted,
        wallet_registrations_dropped: tally.dropped,
        wallet_passes_deferred: tally.deferred,
        wallet_passes_voided: voided,
        wallet_passes_deleted: deleted.count,
        items_failed: tally.failed,
      });
    } catch (err) {
      evt.addWarning(`wallet pass sweep failed: ${err}`);
      return jobFailed("wallet pass sweep failed", err);
    }
  });
}

export async function handleWalletPassVoidPush(
  jobs: Job<unknown>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.wallet_pass_void_push", async (evt) => {
    const since = new Date(Date.now() - WALLET_VOID_PUSH_WINDOW_DAYS * DAY_MS);
    try {
      // account-deletion: a pending account's withdrawn pass is exactly what its devices must hear of.
      const voided = await prisma.walletPass.findMany({
        where: {
          registrations: { some: {} },
          OR: [
            { voidedAt: { gte: since } },
            { link: { revokedAt: { gte: since } } },
          ],
        },
        select: {
          id: true,
          contentChangedAt: true,
          voidedAt: true,
          link: { select: { revokedAt: true } },
          registrations: { select: { createdAt: true, lastPushAt: true } },
        },
        take: PASSES_PER_RUN,
      });
      const tally = emptyTally();
      for (const pass of voided) {
        // Most runs find every device told already: skip without a rebuild.
        const owed = owedRegistrations(
          walletPassChangedAt(pass),
          pass.registrations,
        );
        if (owed.length > 0) await refreshAndPush(pass.id, false, tally);
      }
      evt.addMeta("wallet_pushes_accepted", tally.accepted);
      return jobDone({
        wallet_passes_refreshed: tally.refreshed,
        wallet_passes_changed: tally.changed,
        wallet_pushes_accepted: tally.accepted,
        wallet_registrations_dropped: tally.dropped,
        wallet_passes_deferred: tally.deferred,
        items_failed: tally.failed,
      });
    } catch (err) {
      evt.addWarning(`wallet void push failed: ${err}`);
      return jobFailed("wallet void push failed", err);
    }
  });
}
