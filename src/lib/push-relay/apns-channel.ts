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
 * cycle reminders, and the medication reminder unless the device asked for
 * server delivery (`medicationDelivery: "server"`). A Guardian delivery about
 * another person's record does not use the relay either.
 *
 * A relay that is down, paused or still holding the push is not a failure of
 * the channel: the outcome says `relayTransport`, which the channel state
 * leaves out of its failure count (`channel-state.ts`).
 */
import { prisma } from "@/lib/db";
import type { SendOutcome } from "@/lib/notifications/retry-policy";
import { sendViaApns } from "@/lib/notifications/senders/apns";
import { iosMetadataFor } from "@/lib/notifications/senders/ios-metadata";
import { isManagedGuardianDelivery } from "@/lib/notifications/managed-delivery";
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
type ApnsChannelOptions = Parameters<typeof sendViaApns>[2];

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

/** Whether this alert may travel over the relay to this device. */
export function relayCarries(
  payload: ApnsChannelPayload,
  device: { medicationDelivery: string | null },
): boolean {
  if (LOCALLY_PLANNED.has(payload.eventType)) return false;
  if (isManagedGuardianDelivery(payload)) return false;
  if (payload.eventType === "MEDICATION_REMINDER") {
    return device.medicationDelivery === "server";
  }
  return true;
}

/** The dispatcher's APNs send: sealed where it can, plaintext elsewhere. */
export async function sendApnsChannel(
  userId: string,
  payload: ApnsChannelPayload,
  options?: ApnsChannelOptions,
): Promise<SendOutcome> {
  const only = options?.onlyDeviceIds;
  const all = await prisma.device.findMany({
    where: {
      userId,
      apnsToken: { not: null },
      ...(only && { id: { in: [...only] } }),
    },
    select: { ...ROUTABLE_DEVICE_SELECT, medicationDelivery: true },
  });
  const devices = all.filter((d) => d.pushKeyPublic !== null);
  if (devices.length === 0) return sendViaApns(userId, payload, options);

  const ctx = await loadPushContext();
  const message = alertMessage(payload);
  const slotTag =
    typeof payload.metadata?.webPushTag === "string"
      ? payload.metadata.webPushTag
      : undefined;
  const targets: SealedTarget[] = devices
    .filter((d) => routeOf(d, ctx) !== "relay" || relayCarries(payload, d))
    .map((device) => ({ device, message, collapseKey: slotTag }));
  const sealed = await sendSealed(targets, ctx);
  const legacy =
    all.length > devices.length
      ? await sendViaApns(userId, payload, {
          ...options,
          excludeDeviceIds: devices.map((d) => d.id),
        })
      : null;
  if (sealed.handled.length === 0) {
    // Nothing sealed went anywhere: answer as the plaintext sender does for
    // a user without a reachable device (a rest, not a failure).
    return (
      legacy ??
      sendViaApns(userId, payload, {
        ...options,
        excludeDeviceIds: devices.map((d) => d.id),
      })
    );
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
    ? "relay_waiting"
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
