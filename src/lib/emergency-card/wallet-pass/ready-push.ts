/**
 * "Your emergency card is ready for Wallet": one push to the owner's iPhone
 * (`EMERGENCY_CARD_WALLET_READY`, v1.50).
 *
 * A pass is made on the web. When the browser it was made in is not the
 * iPhone the person carries, the pass sits on the server and never reaches
 * Wallet. Apple lets nothing add a pass without the person's tap, so the
 * closest the server gets is one notification whose tap opens the app's add
 * sheet.
 *
 * Sent once per pass, at most {@link WALLET_READY_MAX_SENDS} times per person
 * (the first pass, and once more after one was withdrawn and made again), and
 * only while all of these hold:
 *
 *   1. the card shows something with the items the pass carries;
 *   2. the resolved Wallet state (`resolveEmergencyWalletApple`, the one
 *      `/api/auth/me` publishes) is `available` and its pass is `live`, so
 *      the pass downloads and counts;
 *   3. no device has registered the pass with the pass web service: a
 *      registration means it is in Wallet already;
 *   4. the person has not said no (`walletReadyPushDismissed`, per person,
 *      reported by the app's dismiss action; one no silences it everywhere);
 *   5. the person has an iPhone that takes pushes.
 *
 * A managed profile is never sent one: nobody signs in to it, and its
 * guardian's own iPhone is not the ward's.
 *
 * The claim is the pass row's `readyPushSentAt`, set by a conditional update
 * (`… WHERE ready_push_sent_at IS NULL`), so two workers racing the same pass
 * send once. A send that failed on every channel hands the claim back for
 * the next run; one that no channel wanted keeps it.
 */
import { activeAccount } from "@/lib/account-deletion/active-account";
import { prisma } from "@/lib/db";
import {
  emergencyCardHasContent,
  loadEmergencyCard,
} from "@/lib/emergency-card/card-data";
import type { Locale } from "@/lib/i18n/config";
import { resolveJobLocale } from "@/lib/i18n/job-locale";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { annotate } from "@/lib/logging/context";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";

import { resolveEmergencyWalletApple } from "./availability";
import { latestWalletPass } from "./service";
import { livePassWhere } from "./void";

export const WALLET_READY_EVENT = "EMERGENCY_CARD_WALLET_READY";
/** The first pass, and one more after a withdrawn pass was made again. */
export const WALLET_READY_MAX_SENDS = 2;

export type WalletReadySkip =
  | "no_account"
  | "managed"
  | "dismissed"
  | "no_pass"
  | "already_sent"
  | "limit"
  | "not_available"
  | "registered"
  | "empty_card"
  | "no_ios_device"
  | "claimed";

export type WalletReadyResult =
  | { result: "sent" }
  | { result: "undelivered" }
  | { result: "unwanted" }
  | { result: "skipped"; reason: WalletReadySkip };

function renderReady(locale: Locale) {
  const { t } = getServerTranslator(locale);
  return {
    title: t("emergencyCard.appleWallet.readyPush.title"),
    message: t("emergencyCard.appleWallet.readyPush.body"),
  };
}

/** Send the push to `userId` if every condition holds. Never throws on a skip. */
export async function sendWalletReadyPush(
  userId: string,
  now: Date = new Date(),
): Promise<WalletReadyResult> {
  const skip = (reason: WalletReadySkip): WalletReadyResult => ({
    result: "skipped",
    reason,
  });
  const user = await prisma.user.findFirst({
    where: activeAccount({ id: userId }),
    select: {
      id: true,
      locale: true,
      timezone: true,
      managedProfileAt: true,
      walletReadyPushDismissed: true,
    },
  });
  if (!user) return skip("no_account");
  if (user.managedProfileAt) return skip("managed");
  if (user.walletReadyPushDismissed) return skip("dismissed");

  const pass = await latestWalletPass(userId);
  if (!pass) return skip("no_pass");
  // The state `/api/auth/me` publishes for this record, from the pass read
  // above. The origin is the one the pass was made on: it downloads there.
  const apple = await resolveEmergencyWalletApple({
    recordUserId: userId,
    allowed: true,
    origin: pass.webServiceOrigin,
    authMethod: "bearer",
    callerIsAdmin: false,
    relayHintDismissed: false,
    pass,
    now,
  });
  if (apple.pass?.state !== "live") return skip("no_pass");
  const [claim, sends] = await Promise.all([
    prisma.walletPass.findUnique({
      where: { id: pass.id },
      select: { readyPushSentAt: true },
    }),
    prisma.walletPass.count({
      where: { userId, readyPushSentAt: { not: null } },
    }),
  ]);
  if (claim?.readyPushSentAt) return skip("already_sent");
  if (sends >= WALLET_READY_MAX_SENDS) return skip("limit");
  if (apple.state !== "available") return skip("not_available");

  const [registrations, devices, card] = await Promise.all([
    prisma.walletPassRegistration.count({ where: { walletPassId: pass.id } }),
    prisma.device.count({
      where: { userId, platform: "ios", apnsToken: { not: null } },
    }),
    loadEmergencyCard(
      userId,
      userDayKey(now, user.timezone || DEFAULT_TIMEZONE),
      pass.link.fields,
    ),
  ]);
  if (registrations > 0) return skip("registered");
  if (!emergencyCardHasContent(card)) return skip("empty_card");
  if (devices === 0) return skip("no_ios_device");

  // The one claim: a second worker on the same pass updates nothing.
  const claimed = await prisma.walletPass.updateMany({
    where: { id: pass.id, readyPushSentAt: null },
    data: { readyPushSentAt: now },
  });
  if (claimed.count !== 1) return skip("claimed");
  const release = () =>
    prisma.walletPass.updateMany({
      where: { id: pass.id, readyPushSentAt: now },
      data: { readyPushSentAt: null },
    });

  let outcome: Awaited<ReturnType<typeof dispatchNotification>>;
  try {
    const text = renderReady(await resolveJobLocale(user.locale));
    outcome = await dispatchNotification({
      eventType: WALLET_READY_EVENT,
      userId,
      title: text.title,
      message: text.message,
      renderForRecipient: renderReady,
    });
  } catch (err) {
    await release();
    throw err;
  }
  if (outcome.dispatched) {
    annotate({ action: { name: "emergency-card.wallet.ready_push.sent" } });
    return { result: "sent" };
  }
  if (outcome.channelsAttempted > 0) {
    // Every channel failed: the next run tries again.
    await release();
    return { result: "undelivered" };
  }
  // No channel wanted it: settled, not asked again.
  return { result: "unwanted" };
}

/**
 * Every live pass not yet announced, for the sweep and for the moment the
 * relay starts signing. Per pass, never more than one run's worth.
 */
export async function runWalletReadyPushPass(
  now: Date = new Date(),
  limit = 500,
): Promise<{ sent: number; skipped: number; failed: number }> {
  const candidates = await prisma.walletPass.findMany({
    where: {
      readyPushSentAt: null,
      ...livePassWhere(now),
      user: activeAccount({
        managedProfileAt: null,
        walletReadyPushDismissed: false,
      }),
    },
    select: { userId: true },
    distinct: ["userId"],
    take: limit,
  });
  const tally = { sent: 0, skipped: 0, failed: 0 };
  for (const { userId } of candidates) {
    try {
      const out = await sendWalletReadyPush(userId, now);
      if (out.result === "sent") tally.sent += 1;
      else tally.skipped += 1;
    } catch {
      tally.failed += 1;
    }
  }
  return tally;
}
