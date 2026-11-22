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
import { withBackgroundEvent } from "@/lib/logging/background";
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
import {
  clearOwedIntakeSync,
  oweIntakeSync,
} from "@/lib/push-relay/owed-intake-sync";
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
}

/**
 * Send the silent sync sealed, to every routable device. It goes out on
 * every dose change, also when the visible confirmation of the same change
 * goes to the device: no push stands in for another, so a confirmation that
 * does not arrive never leaves the device without its sync. A device whose
 * silent budget (`wakes.ts`) is spent is not skipped but owed the sync: the
 * minute pass sends it once the budget frees up, one for however many
 * changes arrived meanwhile. A sync the relay then drops at its deadline is
 * owed again (`relay-send.ts`).
 */
export async function sendSealedIntakeSync(
  devices: RoutableDevice[],
  ctx: PushContext,
  now: Date = new Date(),
): Promise<IntakeSyncSendResult> {
  const message = intakeSyncMessage(now);
  const targets = [];
  const deferred: string[] = [];
  for (const device of devices) {
    const route = routeOf(device, ctx);
    if (route !== "relay" && route !== "direct") continue;
    if (!(await silentBudgetLeft(device, SYNC_EVENT, ctx, now))) {
      deferred.push(device.id);
      continue;
    }
    targets.push({ device, message, collapseKey: "intake-sync" });
  }
  if (deferred.length > 0) await oweIntakeSync(deferred, now);
  const sealed = await sendSealed(targets, ctx);
  await recordSilentPushes(SYNC_EVENT, sealed.handled, now);
  return { ...sealed, deferred };
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
      await clearOwedIntakeSync(row.deviceId);
      continue;
    }
    if (!(await silentBudgetLeft(device, SYNC_EVENT, ctx, now))) continue;
    // Settled before the send, not after it: a sync the relay drops at once
    // is owed again by the outbox (`relay-send.ts`), and clearing afterwards
    // would wipe that.
    await clearOwedIntakeSync(row.deviceId);
    const result = await sendSealed(
      [{ device, message: intakeSyncMessage(now), collapseKey: "intake-sync" }],
      ctx,
    );
    await recordSilentPushes(SYNC_EVENT, result.handled, now);
    if (result.handled.length === 0) {
      // Nothing was handed over (the envelope could not be sealed): still owed.
      await oweIntakeSync([row.deviceId], now);
    } else {
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

/** The ledger reason of the sync that activates a binding. */
const BINDING_ACTIVATION_REASON = "relay_binding_activation";

/**
 * The first push to a device the relay has just bound: one silent intake
 * sync, at once.
 *
 * The relay holds a new binding as `provisional` and makes it `active` only
 * once Apple accepted a push for it. A binding still provisional more than
 * two days after it was made is removed, and so is an instance none of whose
 * pushes Apple ever accepted, with every binding it has (`spec/protocol.md`,
 * "Retention"). Neither tells this server: the next push answers
 * `404 binding_unknown` or `401 unknown_instance` and is lost, and the device
 * has to bind again, which starts the two days anew. A phone that plans its
 * own reminders, on an account nobody records for on the web, may get no push
 * for weeks; its binding was gone long before the first dose confirmation or
 * security alert was due. A provisional binding also gets no Live Activity
 * push at all (`403 activity_refused`).
 *
 * Apple's acceptance of this sync makes the binding active and marks the
 * instance as delivering. The app is in the foreground registering at that
 * moment; reading its doses once more costs it nothing, and the push carries
 * no data. It is a sync like any other: it counts against the device's
 * silent budget, and one the budget holds back or the relay drops is owed
 * and sent by the minute pass, so the activation is retried. What the relay
 * sees is a silent push at the moment it bound the device, which tells it
 * nothing it did not know.
 *
 * Never throws: the registration that bound the device has answered.
 */
export async function activateRelayBinding(
  userId: string,
  deviceId: string,
): Promise<void> {
  try {
    await withBackgroundEvent(
      "notification.relay_binding.activate",
      async (evt) => {
        // The account's own gates: no push for an account pending deletion
        // or with its APNs channel switched off.
        const device = (await wakeableDevices(userId)).find(
          (d) => d.id === deviceId,
        );
        const ctx = await loadPushContext();
        if (!device || routeOf(device, ctx) !== "relay") {
          evt.addMeta("relay_binding_activation", "no_route");
          return;
        }
        const sent = await sendSealedIntakeSync([device], ctx);
        const owed = sent.deferred.length > 0;
        const handed = sent.anyAccepted || sent.waiting;
        evt.addMeta(
          "relay_binding_activation",
          sent.anyAccepted
            ? "accepted"
            : sent.waiting
              ? "waiting"
              : owed
                ? "owed"
                : (sent.lastFailure ?? "not_sent"),
        );
        recordPushAttempt({
          userId,
          channel: "APNS",
          eventType: SYNC_EVENT,
          result: handed ? "ok" : owed ? "skipped" : "error",
          reason:
            handed || owed
              ? BINDING_ACTIVATION_REASON
              : (sent.lastFailure ?? "intake_sync_nothing_sent"),
        });
      },
    );
  } catch {
    // Best effort: the binding stands, and the next sync activates it.
  }
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
