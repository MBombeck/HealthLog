/**
 * The medication pushes a sealed device gets: the visible confirmation of a
 * dose recorded elsewhere (`MEDICATION_INTAKE_RECORDED`, alert), the silent
 * intake sync (`MEDICATION_INTAKE_SYNC`, silent) and, over the relay, the
 * Live Activity end.
 *
 * The confirmation carries the same flat fields as the plaintext push
 * (`medicationId`, `intakeId`, `slotInstant`, `outcome`, `takenAt`,
 * `takenVia`) in `d`, the neutral localised text in `n`, and a passive level
 * in `ui`; no medication name. Its deadline is two hours over this server's
 * own APNs key: a confirmation that arrives later than that no longer
 * withdraws anything useful. Over the relay it lives as long as every other
 * alert (`RELAY_CLASS_LIFETIME_S`), so its lifetime does not single it out.
 *
 * The Live Activity end travels without an envelope: the relay sends its own
 * fixed content state. Its token and the device's signed activity statement
 * reach the relay only inside the end push, so the relay never learns when an
 * Activity starts. An Activity without a statement (an app build older than
 * the relay contract) is not ended over the relay.
 */
import { prisma } from "@/lib/db";
import { recordPushAttempt } from "@/lib/notifications/senders/push-attempt-record";
import { EVENT_DEFAULT_ENABLED } from "@/lib/notifications/types";
import { fromBase64Url } from "@/lib/push-relay/encoding";
import type { EnvelopeMessage } from "@/lib/push-relay/envelope";
import {
  loadPushContext,
  routeOf,
  sendSealed,
  type PushContext,
  type RoutableDevice,
  type SealedSendResult,
} from "@/lib/push-relay/route-device";
import {
  recordSilentPushes,
  silentBudgetLeft,
  wakeableDevices,
} from "@/lib/push-relay/wakes";
import { sendRelayItems } from "@/lib/push-relay/relay-send";

const RECORDED_LIFETIME_S = 2 * 3600;
const SYNC_LIFETIME_S = 3600;
const ACTIVITY_LIFETIME_S = 4 * 3600;
/** The relay accepts an activity statement at most 12 hours old. */
const ACTIVITY_STATEMENT_MAX_AGE_S = 12 * 3600 - 300;
const SYNC_EVENT = "MEDICATION_INTAKE_SYNC";

export interface RecordedFields {
  medicationId: string;
  intakeId: string;
  slotInstant: Date;
  outcome: "taken" | "skipped";
  takenAt: Date | null;
  /** Null on a skip. */
  takenVia: string | null;
}

/** The sealed confirmation of one recorded dose. */
export function intakeRecordedMessage(
  event: RecordedFields,
  text: { title: string; body: string },
): EnvelopeMessage {
  return {
    pushClass: "alert",
    type: "MEDICATION_INTAKE_RECORDED",
    lifetimeSeconds: RECORDED_LIFETIME_S,
    data: {
      medicationId: event.medicationId,
      intakeId: event.intakeId,
      slotInstant: event.slotInstant.toISOString(),
      outcome: event.outcome,
      takenAt: event.takenAt?.toISOString() ?? null,
      takenVia: event.takenVia,
    },
    text,
    ui: { thread: `medication-${event.medicationId}`, level: "passive" },
  };
}

/** The sealed silent sync trigger; like the plaintext one, no health data. */
export function intakeSyncMessage(syncedAt: Date): EnvelopeMessage {
  return {
    pushClass: "silent",
    type: SYNC_EVENT,
    lifetimeSeconds: SYNC_LIFETIME_S,
    data: { syncedAt: syncedAt.toISOString() },
  };
}

/** Send the confirmation sealed to every routable device. */
export function sendSealedIntakeRecorded(
  devices: RoutableDevice[],
  event: RecordedFields,
  text: { title: string; body: string },
  ctx: PushContext,
): Promise<SealedSendResult> {
  const message = intakeRecordedMessage(event, text);
  const collapseKey = `intake-${event.medicationId}-${event.slotInstant.getTime()}`;
  return sendSealed(
    devices.map((device) => ({ device, message, collapseKey })),
    ctx,
  );
}

export interface IntakeSyncSendResult extends SealedSendResult {
  /** Devices the silent budget held back: owed, sent by the minute pass. */
  deferred: string[];
  /**
   * Relay devices skipped on purpose: the recorded confirmation in the same
   * flush stands in for their silent sync. Not a failure.
   */
  covered: string[];
}

/**
 * Send the silent sync sealed. A relay device is skipped when the flush also
 * sends it the recorded confirmation (that alert triggers the sync in the
 * extension); `confirmationFor` names those devices, and is empty when the
 * confirmation is off for the account: it is opt-in, and the sync must not
 * depend on it. A device whose silent budget (`wakes.ts`) is spent is not
 * skipped but owed the sync: the minute pass sends it once the budget frees
 * up, one for however many changes arrived meanwhile.
 */
export async function sendSealedIntakeSync(
  devices: RoutableDevice[],
  ctx: PushContext,
  options: { confirmationFor: ReadonlySet<string> },
  now: Date = new Date(),
): Promise<IntakeSyncSendResult> {
  const message = intakeSyncMessage(now);
  const targets = [];
  const deferred: string[] = [];
  const covered: string[] = [];
  for (const device of devices) {
    const route = routeOf(device, ctx);
    if (route !== "relay" && route !== "direct") continue;
    if (route === "relay" && options.confirmationFor.has(device.id)) {
      covered.push(device.id);
      continue;
    }
    if (!(await silentBudgetLeft(device, SYNC_EVENT, ctx, now))) {
      deferred.push(device.id);
      continue;
    }
    targets.push({ device, message, collapseKey: "intake-sync" });
  }
  if (deferred.length > 0) await oweIntakeSync(deferred, now);
  const sealed = await sendSealed(targets, ctx);
  await recordSilentPushes(SYNC_EVENT, sealed.handled, now);
  return { ...sealed, deferred, covered };
}

/** Mark the sync owed to these devices (the first time it is owed stays). */
async function oweIntakeSync(deviceIds: string[], now: Date): Promise<void> {
  for (const deviceId of deviceIds) {
    await prisma.$executeRaw`
      INSERT INTO "push_data_changes" ("device_id", "intake_sync_owed_at", "updated_at")
      VALUES (${deviceId}, ${now.toISOString()}::timestamp(3), ${now.toISOString()}::timestamp(3))
      ON CONFLICT ("device_id") DO UPDATE SET
        "intake_sync_owed_at" = COALESCE("push_data_changes"."intake_sync_owed_at", EXCLUDED."intake_sync_owed_at")`;
  }
}

/**
 * Whether the account takes the intake sync at all. There is no user-facing
 * toggle (this is coherence plumbing), but an explicit per-channel
 * preference (APNS / MEDICATION_INTAKE_SYNC / disabled) is honoured so an
 * operator can switch the fan-out off; so is the APNs channel itself.
 */
export async function intakeSyncEnabled(userId: string): Promise<boolean> {
  const channel = await prisma.notificationChannel.findUnique({
    where: { userId_type: { userId, type: "APNS" } },
    select: {
      enabled: true,
      preferences: {
        where: { eventType: SYNC_EVENT },
        select: { enabled: true },
      },
    },
  });
  if (!channel || !channel.enabled) return false;
  const pref = channel.preferences[0];
  if (pref) return pref.enabled;
  return EVENT_DEFAULT_ENABLED.MEDICATION_INTAKE_SYNC;
}

/**
 * The minute pass: send every owed intake sync whose device has silent
 * budget again, and clear what is settled. A device whose account no longer
 * takes the sync (pending deletion, APNs channel or the sync switched off)
 * or that lost its route is owed nothing any more. Returns how many went out.
 */
export async function flushOwedIntakeSyncs(
  now: Date = new Date(),
): Promise<number> {
  const owed = await prisma.pushDataChange.findMany({
    where: { intakeSyncOwedAt: { not: null } },
    select: { deviceId: true, device: { select: { userId: true } } },
    orderBy: { intakeSyncOwedAt: "asc" },
    take: 500,
  });
  if (owed.length === 0) return 0;
  const ctx = await loadPushContext();
  let sent = 0;
  for (const row of owed) {
    const userId = row.device.userId;
    const device = (await intakeSyncEnabled(userId))
      ? (await wakeableDevices(userId)).find((d) => d.id === row.deviceId)
      : undefined;
    const route = device ? routeOf(device, ctx) : "none";
    if (!device || (route !== "relay" && route !== "direct")) {
      await clearOwed(row.deviceId);
      continue;
    }
    if (!(await silentBudgetLeft(device, SYNC_EVENT, ctx, now))) continue;
    const result = await sendSealed(
      [{ device, message: intakeSyncMessage(now), collapseKey: "intake-sync" }],
      ctx,
    );
    await recordSilentPushes(SYNC_EVENT, result.handled, now);
    if (result.handled.length > 0) {
      await clearOwed(row.deviceId);
      recordPushAttempt({
        userId,
        channel: "APNS",
        eventType: SYNC_EVENT,
        result: result.anyAccepted || result.waiting ? "ok" : "error",
        reason:
          result.anyAccepted || result.waiting
            ? "intake_sync_owed_sent"
            : (result.lastFailure ?? "intake_sync_nothing_sent"),
      });
      sent += 1;
    }
  }
  return sent;
}

async function clearOwed(deviceId: string): Promise<void> {
  await prisma.pushDataChange.updateMany({
    where: { deviceId },
    data: { intakeSyncOwedAt: null },
  });
}

export interface RelayActivityRow {
  id: string;
  pushToken: string;
  activityStatement: unknown;
  activitySignature: string | null;
}

/**
 * End these Activities of one relay-bound device over the relay. Returns the
 * ids of the Activity rows that are spent: the relay accepted the end, or
 * reported the Activity gone.
 */
export async function endActivitiesOverRelay(
  device: RoutableDevice & { relayBindingKey: string | null },
  activities: RelayActivityRow[],
  ctx: PushContext,
): Promise<string[]> {
  if (routeOf(device, ctx) !== "relay" || !device.relayBindingKey) return [];
  if (!fromBase64Url(device.relayBindingKey, 32)) return [];
  const nowS = Math.floor(Date.now() / 1000);
  const items = activities.flatMap((activity) => {
    const statement = activity.activityStatement as { iat?: unknown } | null;
    if (
      !statement ||
      typeof statement.iat !== "number" ||
      !activity.activitySignature ||
      nowS - statement.iat > ACTIVITY_STATEMENT_MAX_AGE_S
    ) {
      return [];
    }
    return [
      {
        deviceId: device.id,
        ref: `end-${activity.id}`,
        pushClass: "liveactivity" as const,
        eventType: "LIVE_ACTIVITY_END",
        activity: {
          token: activity.pushToken.toLowerCase(),
          bindingKey: device.relayBindingKey as string,
          statement: statement as Record<string, unknown>,
          signature: activity.activitySignature,
        },
        expiresAt: new Date((nowS + ACTIVITY_LIFETIME_S) * 1000),
      },
    ];
  });
  if (items.length === 0) return [];
  // The ref is fixed per Activity, so one end is in flight at a time. An end
  // that already failed or was dropped (a relay outage past its deadline)
  // would make the outbox skip the new one as a duplicate and the Activity
  // would never end: its final row goes, and this flush sends afresh.
  await prisma.pushRelayDelivery.deleteMany({
    where: {
      deviceId: device.id,
      ref: { in: items.map((i) => i.ref) },
      status: { in: ["failed", "dropped"] },
    },
  });
  const summary = await sendRelayItems(items, ctx.config);
  const settled = await prisma.pushRelayDelivery.findMany({
    where: {
      deviceId: device.id,
      ref: { in: items.map((i) => i.ref) },
      OR: [{ status: "accepted" }, { reason: "activity_gone" }],
    },
    select: { ref: true },
  });
  const spentRefs = new Set([
    ...settled.map((s) => s.ref),
    ...summary.activityGone,
  ]);
  return activities
    .filter((a) => spentRefs.has(`end-${a.id}`))
    .map((a) => a.id);
}
