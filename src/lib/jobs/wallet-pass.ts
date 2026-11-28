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
 * - void push: every withdrawn or expired pass whose devices have not heard
 *   of it, rebuilt in its ended version and pushed without throttle.
 *
 * A pass that fails is counted and the run carries on; a run that cannot
 * read the table fails and the next tick is the retry. The refresh of one
 * pass fails when its rebuild threw or Apple refused a push for a reason
 * that is not the token's, so the queue's backoff retries it and the worker
 * report shows it; the retry is idempotent, what is owed is read again.
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
  type WalletReadyPushPayload,
} from "@/lib/emergency-card/wallet-pass/queues";
import {
  runWalletReadyPushPass,
  sendWalletReadyPush,
} from "@/lib/emergency-card/wallet-pass/ready-push";
import {
  refreshWalletPass,
  voidWalletPassById,
} from "@/lib/emergency-card/wallet-pass/service";
import {
  livePassWhere,
  walletPassState,
} from "@/lib/emergency-card/wallet-pass/void";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import { guardianMintRefusal } from "@/lib/sharing/guardian-minted";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Withdrawn passes stay this long, then go with their registrations. */
export const WALLET_VOIDED_RETENTION_DAYS = 365;
/** How far back the void push looks for devices still to tell. */
export const WALLET_VOID_PUSH_WINDOW_DAYS = 30;
/** Passes one void-push run takes on, and one page of the sweep. */
const PASSES_PER_RUN = 2000;

interface Tally {
  refreshed: number;
  changed: number;
  accepted: number;
  dropped: number;
  unreadable: number;
  rejected: number;
  deferred: number;
  failed: number;
}

const emptyTally = (): Tally => ({
  refreshed: 0,
  changed: 0,
  accepted: 0,
  dropped: 0,
  unreadable: 0,
  rejected: 0,
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
    tally.unreadable += pushed.unreadable;
    tally.rejected += pushed.rejected;
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
        select: {
          voidedAt: true,
          link: { select: { revokedAt: true, expiresAt: true } },
        },
      });
      if (!pass) continue;
      // An ended pass is the void push's; nothing to throttle there.
      await refreshAndPush(id, walletPassState(pass) === "live", tally);
    }
    evt.addMeta("wallet_passes_refreshed", tally.refreshed);
    const did = {
      wallet_passes_refreshed: tally.refreshed,
      wallet_passes_changed: tally.changed,
      wallet_pushes_accepted: tally.accepted,
      wallet_registrations_dropped: tally.dropped,
      wallet_registrations_unreadable: tally.unreadable,
      wallet_pushes_rejected: tally.rejected,
      wallet_passes_deferred: tally.deferred,
      items_failed: tally.failed,
    };
    if (tally.failed > 0 || tally.rejected > 0 || tally.unreadable > 0) {
      return jobFailed(
        tally.rejected > 0
          ? "wallet pass push refused by Apple"
          : tally.unreadable > 0
            ? "wallet pass push token unreadable (check ENCRYPTION_KEYS)"
            : "wallet pass refresh failed",
        undefined,
        did,
      );
    }
    return jobDone(did);
  });
}

export async function handleWalletPassSweep(
  jobs: Job<unknown>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.wallet_pass_sweep", async (evt) => {
    const now = new Date();
    try {
      const tally = emptyTally();
      let voided = 0;
      // Every live pass, a page at a time by id: ordering by a column the
      // sweep never moves would hand back the same oldest page every run.
      let cursor: string | null = null;
      for (;;) {
        const live: Array<{ id: string; userId: string; createdById: string }> =
          // account-deletion: a deletion request withdraws the account's passes, so a live pass has an active owner.
          await prisma.walletPass.findMany({
            where: livePassWhere(now),
            select: { id: true, userId: true, createdById: true },
            orderBy: { id: "asc" },
            take: PASSES_PER_RUN,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          });
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
        if (live.length < PASSES_PER_RUN) break;
        cursor = live[live.length - 1].id;
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
      // The ready push for passes no trigger announced.
      const ready = await runWalletReadyPushPass(now);
      evt.addMeta("wallet_passes_refreshed", tally.refreshed);
      return jobDone({
        wallet_passes_refreshed: tally.refreshed,
        wallet_passes_changed: tally.changed,
        wallet_pushes_accepted: tally.accepted,
        wallet_registrations_dropped: tally.dropped,
        wallet_registrations_unreadable: tally.unreadable,
        wallet_pushes_rejected: tally.rejected,
        wallet_passes_deferred: tally.deferred,
        wallet_ready_pushes_sent: ready.sent,
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
    const now = new Date();
    const since = new Date(
      now.getTime() - WALLET_VOID_PUSH_WINDOW_DAYS * DAY_MS,
    );
    try {
      // account-deletion: a pending account's withdrawn pass is exactly what its devices must hear of.
      const voided = await prisma.walletPass.findMany({
        where: {
          registrations: { some: {} },
          OR: [
            { voidedAt: { gte: since } },
            { link: { revokedAt: { gte: since } } },
            { link: { expiresAt: { gte: since, lte: now } } },
          ],
        },
        select: {
          id: true,
          contentChangedAt: true,
          voidedAt: true,
          link: { select: { revokedAt: true, expiresAt: true } },
          registrations: { select: { createdAt: true, lastPushAt: true } },
        },
        take: PASSES_PER_RUN,
      });
      const tally = emptyTally();
      for (const pass of voided) {
        // Most runs find every device told already: skip without a rebuild.
        const owed = owedRegistrations(
          walletPassChangedAt(pass, now),
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
        wallet_registrations_unreadable: tally.unreadable,
        wallet_pushes_rejected: tally.rejected,
        wallet_passes_deferred: tally.deferred,
        items_failed: tally.failed,
      });
    } catch (err) {
      evt.addWarning(`wallet void push failed: ${err}`);
      return jobFailed("wallet void push failed", err);
    }
  });
}

/** The ready push: one person, or every live pass not yet announced. */
export async function handleWalletReadyPush(
  jobs: Job<WalletReadyPushPayload>[],
): Promise<JobOutcome> {
  return withBackgroundEvent("job.wallet_ready_push", async (evt) => {
    let sent = 0;
    let failed = 0;
    try {
      for (const job of jobs) {
        const userId = job.data?.userId;
        if (typeof userId === "string" && userId.length > 0) {
          try {
            const out = await sendWalletReadyPush(userId);
            if (out.result === "sent") sent += 1;
          } catch {
            failed += 1;
          }
        } else {
          const tally = await runWalletReadyPushPass();
          sent += tally.sent;
          failed += tally.failed;
        }
      }
      evt.addMeta("wallet_ready_pushes_sent", sent);
      return jobDone({ wallet_ready_pushes_sent: sent, items_failed: failed });
    } catch (err) {
      evt.addWarning(`wallet ready push failed: ${err}`);
      return jobFailed("wallet ready push failed", err);
    }
  });
}
