/**
 * Silent wakes: sealed background pushes that ask the app to do something
 * on its own, beside the medication sync. Two kinds exist:
 *
 * - `DATA_CHANGED` (`data-changed.ts`): a server-side sync stored new
 *   readings; the app reloads its stores, widgets and the Watch.
 * - `HEALTHKIT_CATCH_UP` (`healthkit-catch-up.ts`): the device's Apple
 *   Health upload fell behind; the app runs its normal incremental pass.
 *
 * Both go only to devices with a push key, sealed, over this server's own
 * APNs key or over the relay (`route-device.ts`). A device without a push key
 * runs an app that does not know these types; a wake would spend its silent
 * budget for nothing.
 *
 * Budget. Apple throttles background pushes it considers too frequent, and
 * the relay allows six silent pushes per device and hour. Every wake is
 * recorded in `push_wakes`; a device gets at most
 * {@link WAKES_PER_DEVICE_HOUR} wakes an hour, and a relay device is also
 * skipped while its relay silent budget (`silentBudgetLeft`, which counts the
 * medication sync too) is spent. A skipped device loses nothing that
 * matters: the app reloads everything the next time it opens.
 */
import { prisma } from "@/lib/db";
import { pendingDeletionOf } from "@/lib/account-deletion/pending";
import type { EnvelopeMessage } from "@/lib/push-relay/envelope";
import { silentBudgetLeft } from "@/lib/push-relay/medication-pushes";
import {
  loadPushContext,
  ROUTABLE_DEVICE_SELECT,
  routeOf,
  sendSealed,
  type PushContext,
  type RoutableDevice,
  type SealedSendResult,
} from "@/lib/push-relay/route-device";

export type WakeKind = "DATA_CHANGED" | "HEALTHKIT_CATCH_UP";

/** Silent wakes per device and hour, all kinds together. */
export const WAKES_PER_DEVICE_HOUR = 4;

const WAKE_LIFETIME_S = 3600;
const HOUR_MS = 3600_000;
/** Wake ledger rows are kept two days: the longest window any limit reads. */
export const WAKE_RETENTION_MS = 2 * 24 * HOUR_MS;

/** The sealed silent message of one wake. */
export function wakeMessage(
  kind: WakeKind,
  data: Record<string, unknown>,
): EnvelopeMessage {
  return {
    pushClass: "silent",
    type: kind,
    lifetimeSeconds: WAKE_LIFETIME_S,
    data,
  };
}

export interface WakeDevice extends RoutableDevice {
  token: string;
}

/**
 * The account's devices a wake can reach: a push key, an APNs token, and
 * the account's APNs channel switched on. None for an account pending
 * deletion.
 */
export async function wakeableDevices(userId: string): Promise<WakeDevice[]> {
  if (await pendingDeletionOf(userId)) return [];
  const channel = await prisma.notificationChannel.findUnique({
    where: { userId_type: { userId, type: "APNS" } },
    select: { enabled: true },
  });
  if (!channel?.enabled) return [];
  return prisma.device.findMany({
    where: {
      userId,
      apnsToken: { not: null },
      pushKeyPublic: { not: null },
    },
    select: { ...ROUTABLE_DEVICE_SELECT, token: true },
    orderBy: { id: "asc" },
  });
}

/** Whether `device` may take one more wake now. */
export async function wakeBudgetLeft(
  device: RoutableDevice,
  ctx: PushContext,
  now: Date,
): Promise<boolean> {
  const recent = await prisma.pushWake.count({
    where: {
      deviceId: device.id,
      createdAt: { gte: new Date(now.getTime() - HOUR_MS) },
    },
  });
  if (recent >= WAKES_PER_DEVICE_HOUR) return false;
  if (routeOf(device, ctx) === "relay") {
    return silentBudgetLeft(device.id, now);
  }
  return true;
}

export interface WakeSendResult {
  /** Devices the wake went to (or waits at the relay for). */
  sent: string[];
  /** Devices left out because their budget was spent. */
  overBudget: string[];
  sealed: SealedSendResult | null;
}

/**
 * Seal and send one wake to each of `devices` that has a route and budget,
 * and record it for every device it went to.
 */
export async function sendWake(
  kind: WakeKind,
  devices: readonly RoutableDevice[],
  data: Record<string, unknown>,
  options: { now?: Date; ctx?: PushContext; collapseKey?: string } = {},
): Promise<WakeSendResult> {
  const now = options.now ?? new Date();
  if (devices.length === 0) return { sent: [], overBudget: [], sealed: null };
  const ctx = options.ctx ?? (await loadPushContext());
  const message = wakeMessage(kind, data);
  const targets = [];
  const overBudget: string[] = [];
  for (const device of devices) {
    const route = routeOf(device, ctx);
    if (route !== "relay" && route !== "direct") continue;
    if (!(await wakeBudgetLeft(device, ctx, now))) {
      overBudget.push(device.id);
      continue;
    }
    targets.push({ device, message, collapseKey: options.collapseKey });
  }
  if (targets.length === 0) return { sent: [], overBudget, sealed: null };
  const sealed = await sendSealed(targets, ctx);
  if (sealed.handled.length > 0) {
    await prisma.pushWake.createMany({
      data: sealed.handled.map((deviceId) => ({
        deviceId,
        kind,
        createdAt: now,
      })),
    });
  }
  return { sent: sealed.handled, overBudget, sealed };
}

/** Drop wake ledger rows past every window a limit reads. */
export async function pruneWakes(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.pushWake.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - WAKE_RETENTION_MS) } },
  });
  return count;
}
