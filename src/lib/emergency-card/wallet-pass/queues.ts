/**
 * The three queues that keep an installed Apple Wallet pass current (v1.50),
 * and the sends the writers use. A light module: the worker's registry reads
 * the names and crons from here without loading the work.
 *
 * - `wallet-pass-refresh`: one pass, after a write to something the card
 *   shows. Sent a minute late and joined per pass (`singletonKey`), so a
 *   burst of edits is one rebuild and at most one push.
 * - `wallet-pass-sweep`: every six hours over every live pass. Catches what
 *   no write announces (a new day moves the medication list or the week of
 *   a pregnancy), any writer that forgot to send, a guardian who lost the
 *   right to keep a pass, and the retention of withdrawn passes.
 * - `wallet-pass-void-push`: the devices of withdrawn passes, at once and
 *   unthrottled. Sent by every withdrawal this process can see, and on a
 *   five-minute cron for the ones stamped inside another transaction
 *   (password change, handover, deletion request).
 *
 * - `wallet-ready-push`: "your emergency card is ready for Wallet", for one
 *   person ten minutes after a pass is made (the browser that made it may be
 *   the iPhone, which registers it by then), or for everyone with a pass
 *   once the relay starts signing. The sweep catches the rest.
 *
 * Every send is best effort: no worker attached (tests, scripts) or a failed
 * send changes nothing the next cron would not fix.
 */
import { prisma } from "@/lib/db";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";

export const WALLET_PASS_REFRESH_QUEUE = "wallet-pass-refresh";
export const WALLET_PASS_SWEEP_QUEUE = "wallet-pass-sweep";
export const WALLET_PASS_SWEEP_CRON = "41 */6 * * *";
export const WALLET_PASS_VOID_PUSH_QUEUE = "wallet-pass-void-push";
export const WALLET_PASS_VOID_PUSH_CRON = "3-59/5 * * * *";

/** How long a refresh waits, so a burst of edits is one rebuild. */
export const WALLET_REFRESH_DEBOUNCE_SECONDS = 60;

export interface WalletPassRefreshPayload {
  walletPassId: string;
}

/** Send one pass's refresh, `delaySeconds` from now. */
export async function enqueueWalletPassRefresh(
  walletPassId: string,
  delaySeconds: number = WALLET_REFRESH_DEBOUNCE_SECONDS,
): Promise<void> {
  const boss = getGlobalBoss();
  if (!boss) return;
  const payload: WalletPassRefreshPayload = { walletPassId };
  await boss.send(WALLET_PASS_REFRESH_QUEUE, payload, {
    singletonKey: `wallet-pass-refresh|${walletPassId}`,
    startAfter: Math.max(1, Math.ceil(delaySeconds)),
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
  });
}

/**
 * Something the emergency card shows changed for `userId`: refresh its live
 * pass, if it has one. One indexed read when it has none. Never throws: a
 * card write is never refused because the pass could not be told.
 */
export async function enqueueWalletRefresh(userId: string): Promise<void> {
  try {
    if (!getGlobalBoss()) return;
    const passes = await prisma.walletPass.findMany({
      where: { userId, voidedAt: null, link: { revokedAt: null } },
      select: { id: true },
    });
    for (const pass of passes) await enqueueWalletPassRefresh(pass.id);
  } catch (err) {
    annotate({ meta: { wallet_refresh_enqueue: "failed" } });
    void err;
  }
}

/** Tell the devices of every withdrawn pass that has not been told yet. */
export async function enqueueWalletVoidPush(): Promise<void> {
  try {
    const boss = getGlobalBoss();
    if (!boss) return;
    await boss.send(
      WALLET_PASS_VOID_PUSH_QUEUE,
      {},
      { singletonKey: "wallet-pass-void-push", retryLimit: 2, retryDelay: 30 },
    );
  } catch (err) {
    annotate({ meta: { wallet_void_push_enqueue: "failed" } });
    void err;
  }
}

export const WALLET_READY_PUSH_QUEUE = "wallet-ready-push";
/** How long after a pass is made its ready push waits. */
export const WALLET_READY_PUSH_DELAY_SECONDS = 10 * 60;

export interface WalletReadyPushPayload {
  /** One person; absent, every live pass not yet announced. */
  userId?: string;
}

/** Queue the ready push for `userId`, or for everyone when omitted. */
export async function enqueueWalletReadyPush(
  userId?: string,
  delaySeconds: number = WALLET_READY_PUSH_DELAY_SECONDS,
): Promise<void> {
  try {
    const boss = getGlobalBoss();
    if (!boss) return;
    const payload: WalletReadyPushPayload = userId ? { userId } : {};
    await boss.send(WALLET_READY_PUSH_QUEUE, payload, {
      singletonKey: `wallet-ready-push|${userId ?? "all"}`,
      startAfter: Math.max(1, Math.ceil(delaySeconds)),
      retryLimit: 2,
      retryDelay: 60,
    });
  } catch (err) {
    annotate({ meta: { wallet_ready_push_enqueue: "failed" } });
    void err;
  }
}
