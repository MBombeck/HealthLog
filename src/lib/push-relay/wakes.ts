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
 * Budget. One budget for every silent push a sealed device gets, read from
 * one ledger (`push_wakes`), in one function ({@link silentBudgetLeft}):
 * the wakes and the medication intake sync (`MEDICATION_INTAKE_SYNC`) each
 * leave a row there when they go out, and only when they go out.
 *
 * - A relay device takes at most {@link SILENT_PER_DEVICE_HOUR} silent
 *   pushes an hour, every kind together: the relay's own limit. The last
 *   {@link SYNC_RESERVE} of them are kept for the intake sync, which a dose
 *   decision on the device waits on, so the wakes stop earlier.
 * - Any device takes at most {@link WAKES_PER_DEVICE_HOUR} wakes an hour,
 *   and of those at most {@link DATA_CHANGED_PER_HOUR} `DATA_CHANGED`.
 *
 * A wake over budget waits (`DATA_CHANGED` keeps its domains pending); an
 * intake sync over budget is owed and sent by the minute pass once the
 * budget frees up (`medication-pushes.ts`). Nothing is dropped unrecorded.
 */
import { prisma } from "@/lib/db";
import { pendingDeletionOf } from "@/lib/account-deletion/pending";
import type { EnvelopeMessage } from "@/lib/push-relay/envelope";
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

/** Every kind of silent push the budget counts. */
export type SilentKind = WakeKind | "MEDICATION_INTAKE_SYNC";

/** Silent pushes per relay device and hour, every kind: the relay's limit. */
export const SILENT_PER_DEVICE_HOUR = 6;
/** Of those, how many only the intake sync may take. */
export const SYNC_RESERVE = 2;
/** Silent wakes per device and hour, both wake kinds together. */
export const WAKES_PER_DEVICE_HOUR = 4;
/** `DATA_CHANGED` wakes per device and hour. */
export const DATA_CHANGED_PER_HOUR = 3;

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

/**
 * Whether `device` may take one more silent push of `kind` now: the one
 * budget every silent push asks (see the module doc).
 */
export async function silentBudgetLeft(
  device: RoutableDevice,
  kind: SilentKind,
  ctx: PushContext,
  now: Date,
): Promise<boolean> {
  const rows = await prisma.pushWake.groupBy({
    by: ["kind"],
    where: {
      deviceId: device.id,
      createdAt: { gte: new Date(now.getTime() - HOUR_MS) },
    },
    _count: { _all: true },
  });
  const sent = (k: SilentKind) =>
    rows.find((r) => r.kind === k)?._count._all ?? 0;
  const total = rows.reduce((sum, r) => sum + r._count._all, 0);
  const isSync = kind === "MEDICATION_INTAKE_SYNC";
  if (routeOf(device, ctx) === "relay") {
    const cap = isSync
      ? SILENT_PER_DEVICE_HOUR
      : SILENT_PER_DEVICE_HOUR - SYNC_RESERVE;
    if (total >= cap) return false;
  }
  if (isSync) return true;
  if (
    sent("DATA_CHANGED") + sent("HEALTHKIT_CATCH_UP") >=
    WAKES_PER_DEVICE_HOUR
  )
    return false;
  if (kind === "DATA_CHANGED" && sent("DATA_CHANGED") >= DATA_CHANGED_PER_HOUR)
    return false;
  return true;
}

/** Record the silent pushes that went out, for the budget. */
export async function recordSilentPushes(
  kind: SilentKind,
  deviceIds: readonly string[],
  now: Date,
): Promise<void> {
  if (deviceIds.length === 0) return;
  await prisma.pushWake.createMany({
    data: deviceIds.map((deviceId) => ({ deviceId, kind, createdAt: now })),
  });
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
    if (!(await silentBudgetLeft(device, kind, ctx, now))) {
      overBudget.push(device.id);
      continue;
    }
    targets.push({ device, message, collapseKey: options.collapseKey });
  }
  if (targets.length === 0) return { sent: [], overBudget, sealed: null };
  const sealed = await sendSealed(targets, ctx);
  await recordSilentPushes(kind, sealed.handled, now);
  return { sent: sealed.handled, overBudget, sealed };
}

/** Drop wake ledger rows past every window a limit reads. */
export async function pruneWakes(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.pushWake.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - WAKE_RETENTION_MS) } },
  });
  return count;
}
