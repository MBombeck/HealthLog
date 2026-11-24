/**
 * Telling the devices that hold a pass that it changed (v1.50).
 *
 * A device registered with Apple's web service (`web-service.ts`) is owed a
 * push when the pass changed after the device last heard from us: after its
 * registration and after its last push, the pass's content moved on
 * (`contentChangedAt`) or the pass was withdrawn. The push itself carries
 * nothing; Wallet then asks which passes changed and fetches them.
 *
 * The push goes out the way the pass is signed: over the relay's notify
 * endpoint for a pass the project signs, directly to Apple with the
 * operator's own certificate for a pass signed here. A pass whose signer is
 * no longer the one configured cannot be pushed at all (its Pass Type ID is
 * the push topic); its pushes stay owed and are dropped with the pass.
 *
 * A content change is throttled per pass: at most one push in 15 minutes and
 * 24 a day; what the throttle holds back is deferred, not lost. A withdrawal
 * is never throttled.
 */
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { decrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import {
  notifyWalletPasses,
  WALLET_NOTIFY_MAX,
  type WalletNotifyItem,
  type WalletNotifyResult,
} from "@/lib/push-relay/wallet";
import { checkRateLimit } from "@/lib/rate-limit";

import { sendLocalPassPushes } from "./push-local";
import { walletSigningMode, type WalletSigningMode } from "./sign";

/** The shortest gap between two content pushes of one pass. */
export const WALLET_PUSH_MIN_GAP_MS = 15 * 60 * 1000;
/** Content pushes of one pass per day. */
export const WALLET_PUSH_PER_DAY = 24;
const DAY_MS = 24 * 60 * 60 * 1000;

const PUSH_TOKEN = /^(?:[0-9a-fA-F]{2}){32,100}$/;

export interface WalletPushOutcome {
  /** Registrations that were owed a push. */
  owed: number;
  accepted: number;
  /** Registrations dropped: the device is gone or the token is bad. */
  dropped: number;
  /** Set when the throttle held a content push back: try again then. */
  deferredUntil: Date | null;
  /** Why nothing could be sent at all, when nothing was. */
  skipped: "none_owed" | "api_disabled" | "signer_changed" | null;
}

interface PushablePass {
  id: string;
  signer: "RELAY" | "LOCAL";
  passTypeIdentifier: string;
  teamIdentifier: string;
  contentChangedAt: Date;
  voidedAt: Date | null;
  link: { revokedAt: Date | null };
  registrations: Array<{
    id: string;
    pushTokenEncrypted: string;
    createdAt: Date;
    lastPushAt: Date | null;
  }>;
}

const later = (a: Date, b: Date | null) => (b && b > a ? b : a);

/** When the pass last changed for its devices. */
export function walletPassChangedAt(pass: {
  contentChangedAt: Date;
  voidedAt: Date | null;
  link: { revokedAt: Date | null };
}): Date {
  return later(
    later(pass.contentChangedAt, pass.voidedAt),
    pass.link.revokedAt,
  );
}

/** The registrations that have not heard of the pass's last change. */
export function owedRegistrations<
  R extends { createdAt: Date; lastPushAt: Date | null },
>(changedAt: Date, registrations: readonly R[]): R[] {
  return registrations.filter(
    (r) => later(r.createdAt, r.lastPushAt).getTime() < changedAt.getTime(),
  );
}

function canPushWith(pass: PushablePass, mode: WalletSigningMode): boolean {
  if (pass.signer === "RELAY") return mode.kind === "relay";
  return (
    mode.kind === "local" &&
    mode.identity.passTypeIdentifier === pass.passTypeIdentifier &&
    mode.identity.teamIdentifier === pass.teamIdentifier
  );
}

async function send(
  mode: WalletSigningMode,
  items: WalletNotifyItem[],
): Promise<Map<string, WalletNotifyResult>> {
  if (mode.kind === "local") return sendLocalPassPushes(mode.identity, items);
  const out = new Map<string, WalletNotifyResult>();
  for (let i = 0; i < items.length; i += WALLET_NOTIFY_MAX) {
    const chunk = await notifyWalletPasses(
      items.slice(i, i + WALLET_NOTIFY_MAX),
    );
    for (const [ref, result] of chunk) out.set(ref, result);
  }
  return out;
}

const PUSHABLE_SELECT = {
  id: true,
  signer: true,
  passTypeIdentifier: true,
  teamIdentifier: true,
  contentChangedAt: true,
  voidedAt: true,
  link: { select: { revokedAt: true } },
  registrations: {
    select: {
      id: true,
      pushTokenEncrypted: true,
      createdAt: true,
      lastPushAt: true,
    },
  },
} as const;

/**
 * Push every registration of `walletPassId` that is owed one. `throttle`
 * for a content change; off for a withdrawal.
 */
export async function pushOwedWalletUpdates(
  walletPassId: string,
  options: { throttle: boolean; now?: Date },
): Promise<WalletPushOutcome> {
  const now = options.now ?? new Date();
  const outcome: WalletPushOutcome = {
    owed: 0,
    accepted: 0,
    dropped: 0,
    deferredUntil: null,
    skipped: null,
  };
  const pass = await prisma.walletPass.findUnique({
    where: { id: walletPassId },
    select: PUSHABLE_SELECT,
  });
  if (!pass) return { ...outcome, skipped: "none_owed" };
  const owed = owedRegistrations(walletPassChangedAt(pass), pass.registrations);
  outcome.owed = owed.length;
  if (owed.length === 0) return { ...outcome, skipped: "none_owed" };
  // With the operator's external-access switch off, Wallet's fetch would be
  // refused; the pushes wait until it is back on.
  if (!(await isApiGloballyEnabled())) {
    return { ...outcome, skipped: "api_disabled" };
  }
  const mode = walletSigningMode();
  if (!canPushWith(pass, mode)) {
    return { ...outcome, skipped: "signer_changed" };
  }

  if (options.throttle) {
    const last = pass.registrations.reduce<Date | null>(
      (acc, r) =>
        r.lastPushAt && (!acc || r.lastPushAt > acc) ? r.lastPushAt : acc,
      null,
    );
    if (last && now.getTime() - last.getTime() < WALLET_PUSH_MIN_GAP_MS) {
      outcome.deferredUntil = new Date(last.getTime() + WALLET_PUSH_MIN_GAP_MS);
      return outcome;
    }
    const day = await checkRateLimit(
      `wallet-push:${pass.id}`,
      WALLET_PUSH_PER_DAY,
      DAY_MS,
    );
    if (!day.allowed) {
      outcome.deferredUntil = new Date(day.resetAt);
      return outcome;
    }
  }

  const items: WalletNotifyItem[] = [];
  const unreadable: string[] = [];
  for (const reg of owed) {
    let token: string | null = null;
    try {
      token = decrypt(reg.pushTokenEncrypted);
    } catch {
      token = null;
    }
    if (token && PUSH_TOKEN.test(token)) items.push({ ref: reg.id, token });
    else unreadable.push(reg.id);
  }

  const results = await send(mode, items);
  const accepted: string[] = [];
  const gone: string[] = [...unreadable];
  for (const [ref, result] of results) {
    if (result === "accepted") accepted.push(ref);
    else if (result === "unregistered" || result === "rejected") gone.push(ref);
  }
  if (accepted.length > 0) {
    await prisma.walletPassRegistration.updateMany({
      where: { id: { in: accepted } },
      data: { lastPushAt: now },
    });
  }
  if (gone.length > 0) {
    await prisma.walletPassRegistration.deleteMany({
      where: { id: { in: gone } },
    });
  }
  outcome.accepted = accepted.length;
  outcome.dropped = gone.length;
  annotate({
    meta: {
      wallet_push_owed: outcome.owed,
      wallet_push_accepted: outcome.accepted,
      wallet_push_dropped: outcome.dropped,
    },
  });
  return outcome;
}
