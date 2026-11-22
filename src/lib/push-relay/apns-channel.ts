/**
 * The dispatcher's APNs channel with sealed envelopes in front of it.
 *
 * Devices with a push key get the alert sealed (`route-device.ts`), over this
 * server's own APNs key or over the relay; every other device gets the
 * plaintext alert of `sendViaApns` as before. No device with a push key ever
 * reaches the plaintext sender, whatever happens to its sealed push.
 *
 * Over the relay go only pushes a person's action or the server's own state
 * causes. Reminders the app plans itself stay off it: mood, measurement and
 * cycle reminders, and the medication reminder to a device that reminds
 * itself. Which devices get the server's medication reminder is decided once
 * per dispatch (`resolveApnsDeliveryTargets`, `client-managed-apns.ts`) and
 * handed in as `serverDeviceIds`; the relay reads that decision and no rule
 * of its own, so a device the server's own key would remind is reminded over
 * the relay too. A follow-up for a dose still open travels over the relay
 * only to those devices as well (#190, section 11). A Guardian delivery about
 * another person's record does not use the relay either.
 *
 * A relay that is down, paused or still holding the push is not a failure of
 * the channel: the outcome says `relayTransport`, which the channel state
 * leaves out of its failure count (`channel-state.ts`).
 *
 * When nothing went anywhere the outcome says why, in the channel's own
 * words, and never borrows the plaintext sender's "not configured":
 * - {@link APNS_EVENT_NOT_CARRIED}: every device is a relay device and the
 *   relay does not carry this event to it (the app plans it itself, or the
 *   device reminds itself). Nothing was due; the channel is left alone.
 * - {@link APNS_DEVICE_UNROUTED}: the devices have a push key but no route
 *   (the relay binding is missing, in conflict or has to be renewed). The
 *   channel rests until a device binds (`endApnsNoDeviceRest`).
 * On a server without its own APNs key both used to answer
 * `apns_not_configured`, which rests the channel for an hour: a mood
 * reminder the phone plans itself kept the next security alert from going
 * out over the relay.
 */
import { prisma } from "@/lib/db";
import {
  APNS_DEVICE_UNROUTED,
  APNS_EVENT_NOT_CARRIED,
} from "@/lib/notifications/apns-idle-reasons";
import type { SendOutcome } from "@/lib/notifications/retry-policy";
import { sendViaApns } from "@/lib/notifications/senders/apns";
import { iosMetadataFor } from "@/lib/notifications/senders/ios-metadata";
import { isManagedGuardianDelivery } from "@/lib/notifications/managed-delivery";
import { CLIENT_MANAGED_APNS_EVENTS } from "@/lib/notifications/client-managed-apns";
import { plainPushText } from "@/lib/notifications/strip-emoji";
import { stripHtml } from "@/lib/notifications/strip-html";
import { recordPushAttemptForPayload } from "@/lib/notifications/senders/push-attempt-record";
import type { EnvelopeMessage } from "@/lib/push-relay/envelope";
import {
  loadPushContext,
  ROUTABLE_DEVICE_SELECT,
  routeOf,
  sendSealed,
  type SealedTarget,
} from "@/lib/push-relay/route-device";

type ApnsChannelPayload = Parameters<typeof sendViaApns>[1];
type ApnsChannelOptions = NonNullable<Parameters<typeof sendViaApns>[2]> & {
  /**
   * The devices that get the server's reminder of an event with per-device
   * delivery (`ApnsDeliveryTargets.serverDeviceIds`). The relay carries such
   * an event to these devices alone; absent, to none.
   */
  serverDeviceIds?: readonly string[];
};

/** Reminders the app plans locally; never sent over the relay. */
const LOCALLY_PLANNED = new Set([
  "MOOD_REMINDER",
  "MEASUREMENT_REMINDER",
  "CYCLE_PERIOD_SOON",
  "CYCLE_FERTILE_SOON",
]);

/**
 * The types a receiver accepts `ui.level: time-sensitive` for
 * (`spec/envelope.md`, "Plaintext schema"); `REMINDER` is every alert in
 * discreet mode. A security alert is always time-sensitive, a system alert
 * when the producer marks it urgent; any other urgent type stays `active`,
 * because the receiver would drop the level anyway.
 */
const TIME_SENSITIVE_ALWAYS = new Set([
  "MEDICATION_REMINDER",
  "SECURITY_ALERT",
]);
const TIME_SENSITIVE_WHEN_URGENT = new Set(["SYSTEM_ALERT"]);

const REMINDER_LIFETIME_S = 15 * 60;
const ALERT_LIFETIME_S = 6 * 3600;

/** The sealed form of one dispatcher alert. */
export function alertMessage(payload: ApnsChannelPayload): EnvelopeMessage {
  const managed = isManagedGuardianDelivery(payload);
  const type = payload.discreet ? "REMINDER" : payload.eventType;
  const timeSensitive =
    TIME_SENSITIVE_ALWAYS.has(payload.eventType) ||
    (payload.urgent === true &&
      TIME_SENSITIVE_WHEN_URGENT.has(payload.eventType));
  // No URL rides an envelope: the app derives its target from `t` and `d`.
  const data = iosMetadataFor(payload, managed);
  delete data.url;
  return {
    pushClass: "alert",
    type,
    lifetimeSeconds:
      payload.eventType === "MEDICATION_REMINDER"
        ? REMINDER_LIFETIME_S
        : ALERT_LIFETIME_S,
    data,
    text: {
      title: plainPushText(payload.title, payload.eventType),
      body: plainPushText(stripHtml(payload.message), payload.eventType),
    },
    ui: {
      ...(managed || payload.suppressActions ? {} : { category: type }),
      thread: type,
      level: timeSensitive ? "time-sensitive" : "active",
      sound: "default",
    },
  };
}

/**
 * Whether this alert may travel over the relay to this device. An event with
 * per-device delivery goes only to a device the dispatch resolved as getting
 * the server's reminder (`serverDeviceIds`); without that decision, nowhere.
 */
export function relayCarries(
  payload: ApnsChannelPayload,
  device: { id: string },
  serverDeviceIds: ReadonlySet<string> | undefined,
): boolean {
  if (LOCALLY_PLANNED.has(payload.eventType)) return false;
  if (isManagedGuardianDelivery(payload)) return false;
  if (CLIENT_MANAGED_APNS_EVENTS[payload.eventType]?.perDevice) {
    return serverDeviceIds?.has(device.id) ?? false;
  }
  return true;
}

/** The dispatcher's APNs send: sealed where it can, plaintext elsewhere. */
export async function sendApnsChannel(
  userId: string,
  payload: ApnsChannelPayload,
  options?: ApnsChannelOptions,
): Promise<SendOutcome> {
  const { serverDeviceIds, ...apnsOptions } = options ?? {};
  const only = apnsOptions.onlyDeviceIds;
  const all = await prisma.device.findMany({
    where: {
      userId,
      apnsToken: { not: null },
      ...(only && { id: { in: [...only] } }),
    },
    select: ROUTABLE_DEVICE_SELECT,
  });
  const devices = all.filter((d) => d.pushKeyPublic !== null);
  if (devices.length === 0) return sendViaApns(userId, payload, apnsOptions);
  const serverReminded = serverDeviceIds && new Set(serverDeviceIds);

  const ctx = await loadPushContext();
  const message = alertMessage(payload);
  const slotTag =
    typeof payload.metadata?.webPushTag === "string"
      ? payload.metadata.webPushTag
      : undefined;
  const notCarried = devices.filter(
    (d) =>
      routeOf(d, ctx) === "relay" && !relayCarries(payload, d, serverReminded),
  );
  const targets: SealedTarget[] = devices
    .filter((d) => !notCarried.includes(d))
    .map((device) => ({ device, message, collapseKey: slotTag }));
  const sealed = await sendSealed(targets, ctx);
  const legacy =
    all.length > devices.length
      ? await sendViaApns(userId, payload, {
          ...apnsOptions,
          excludeDeviceIds: devices.map((d) => d.id),
        })
      : null;
  if (sealed.handled.length === 0) {
    // Nothing sealed went anywhere. A plaintext device answers for the
    // channel when there is one.
    if (legacy) return legacy;
    const idle = idleReason(devices, notCarried, sealed, ctx);
    if (idle) {
      recordPushAttemptForPayload(payload, userId, {
        userId,
        channel: "APNS",
        eventType: payload.eventType,
        result: "skipped",
        reason: idle,
      });
      return { ok: false, hardReject: false, reason: idle };
    }
    // Answer as the plaintext sender does for a user without a reachable
    // device (a rest, not a failure).
    return sendViaApns(userId, payload, {
      ...apnsOptions,
      excludeDeviceIds: devices.map((d) => d.id),
    });
  }
  if (sealed.anyAccepted || legacy?.ok) {
    recordPushAttemptForPayload(payload, userId, {
      userId,
      channel: "APNS",
      eventType: payload.eventType,
      result: "ok",
    });
    return { ok: true };
  }
  const reason = sealed.waiting
    ? sealed.waitReason
    : (sealed.lastFailure ?? "sealed_send_failed");
  recordPushAttemptForPayload(payload, userId, {
    userId,
    channel: "APNS",
    eventType: payload.eventType,
    result: "error",
    reason,
  });
  return {
    ok: false,
    hardReject: false,
    reason,
    // Only a relay failure is kept out of the channel's failure count; a
    // refusal from this server's own APNs key counts as it always has.
    relayTransport: sealed.directFailures === 0,
  };
}

/**
 * Why no sealed push went anywhere, when the reason is the relay's and not
 * a failed send: the event is none the relay carries to these devices, or
 * they have no route on a server that offers the relay and has no APNs key
 * of its own. Null for anything else (a seal that failed, no transport at
 * all), which keeps the answer it had.
 */
function idleReason(
  devices: readonly { id: string }[],
  notCarried: readonly { id: string }[],
  sealed: { lastFailure: string | null },
  ctx: { apnsConfigured: boolean; registration: unknown },
): string | null {
  if (sealed.lastFailure || devices.length === 0) return null;
  // A device with a route that this event is not for: the channel works,
  // it had nothing to carry. That holds beside a device without a route too.
  if (notCarried.length > 0) return APNS_EVENT_NOT_CARRIED;
  if (!ctx.apnsConfigured && ctx.registration !== null) {
    return APNS_DEVICE_UNROUTED;
  }
  return null;
}

/**
 * A test push the person asked for, on the same channel as a real alert:
 * sealed to every device with a push key (over the relay too, since the
 * person asked for it on all their devices), plaintext only to a device
 * without one. The test routes call this and never the plaintext sender
 * (`apns-plaintext-sender-guard.test.ts`).
 */
export async function sendApnsTestPush(
  userId: string,
  payload: ApnsChannelPayload,
): Promise<SendOutcome> {
  const devices = await prisma.device.findMany({
    where: { userId, apnsToken: { not: null } },
    select: { id: true },
  });
  return sendApnsChannel(userId, payload, {
    serverDeviceIds: devices.map((d) => d.id),
  });
}
