/**
 * Which way a push takes to one device, and the sealed send itself.
 *
 * A device that registered a push key gets only sealed envelopes, over
 * whichever transport this server has: its own APNs key when one is
 * configured (the same envelope inside the same template as the relay's),
 * else the relay when the operator offers it and the device is bound with
 * consent. A device without a push key keeps the plaintext pushes it gets
 * today, and only over this server's own APNs key. There is no path that
 * sends plaintext to a device with a push key.
 */
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import {
  loadApnsConfig,
  sendApnsRawPush,
} from "@/lib/notifications/senders/apns";
import { relayConfig, type RelayConfig } from "@/lib/push-relay/config";
import { fromBase64Url } from "@/lib/push-relay/encoding";
import {
  sealForDevice,
  templateFor,
  type EnvelopeMessage,
} from "@/lib/push-relay/envelope";
import {
  collapseIdFor,
  ensureEnvelopeKeys,
  loadSenderKeyMaterial,
  type SenderKeyMaterial,
} from "@/lib/push-relay/sender-keys";
import {
  loadRegistration,
  type RegistrationRow,
} from "@/lib/push-relay/registration";
import {
  sendRelayItems,
  type RelayItemInput,
  type RelaySendSummary,
} from "@/lib/push-relay/relay-send";

export interface RoutableDevice {
  id: string;
  apnsToken: string | null;
  apnsEnvironment: string | null;
  pushKeyPublic: string | null;
  relayState: string;
  relayConsentAt: Date | null;
}

/** The selection a routable device is read with. */
export const ROUTABLE_DEVICE_SELECT = {
  id: true,
  apnsToken: true,
  apnsEnvironment: true,
  pushKeyPublic: true,
  relayState: true,
  relayConsentAt: true,
} as const;

export type DeviceRoute = "relay" | "direct" | "legacy" | "none";

export interface PushContext {
  config: RelayConfig;
  registration: RegistrationRow | null;
  apnsConfigured: boolean;
  bundleId: string | null;
  keys: SenderKeyMaterial | null;
}

/** What every push decision in one send needs, read once. */
export async function loadPushContext(): Promise<PushContext> {
  const config = relayConfig();
  const apns = loadApnsConfig();
  const registration = config.available ? await loadRegistration(config) : null;
  const sealing = apns !== null || registration !== null;
  if (sealing) await ensureEnvelopeKeys();
  return {
    config,
    registration,
    apnsConfigured: apns !== null,
    bundleId: apns?.bundleId ?? null,
    keys: sealing ? await loadSenderKeyMaterial() : null,
  };
}

/** The way a push reaches `device`. */
export function routeOf(device: RoutableDevice, ctx: PushContext): DeviceRoute {
  if (!device.apnsToken) return "none";
  if (!device.pushKeyPublic) return ctx.apnsConfigured ? "legacy" : "none";
  if (!ctx.keys) return "none";
  if (ctx.apnsConfigured) return "direct";
  if (
    ctx.registration?.instanceId &&
    device.relayConsentAt &&
    device.relayState === "bound"
  ) {
    return "relay";
  }
  return "none";
}

export interface SealedTarget {
  device: RoutableDevice;
  message: EnvelopeMessage;
  /** What a newer push replaces: the dose for a dose, else the push itself. */
  collapseKey?: string;
}

export interface SealedSendResult {
  /** Devices a sealed push went to (or waits for the relay), by id. */
  handled: string[];
  anyAccepted: boolean;
  /** Something waits for the relay or Apple to come back. */
  waiting: boolean;
  lastFailure: string | null;
  /** Sealed pushes this server's own APNs key could not deliver. */
  directFailures: number;
  relay: RelaySendSummary | null;
}

/** Seal and send one message per target over its route. */
export async function sendSealed(
  targets: SealedTarget[],
  ctx: PushContext,
): Promise<SealedSendResult> {
  const result: SealedSendResult = {
    handled: [],
    anyAccepted: false,
    waiting: false,
    lastFailure: null,
    directFailures: 0,
    relay: null,
  };
  const relayItems: RelayItemInput[] = [];
  for (const target of targets) {
    const route = routeOf(target.device, ctx);
    if ((route !== "relay" && route !== "direct") || !ctx.keys) continue;
    const pushKey = fromBase64Url(target.device.pushKeyPublic ?? "", 32);
    if (!pushKey) continue;
    const apnsToken = target.device.apnsToken as string;
    let sealed;
    try {
      sealed = sealForDevice({
        message: target.message,
        device: { apnsToken, pushKeyPublic: pushKey },
        senderPrivateKey: ctx.keys.senderPrivateKey,
      });
    } catch {
      result.lastFailure = "envelope_seal_failed";
      continue;
    }
    result.handled.push(target.device.id);
    const collapse = collapseIdFor(
      ctx.keys.collapseSecret,
      apnsToken,
      target.collapseKey ?? sealed.id,
    );
    if (route === "relay") {
      relayItems.push({
        deviceId: target.device.id,
        ref: sealed.id,
        pushClass: sealed.pushClass,
        eventType: target.message.type,
        envelope: sealed.envelope,
        collapse,
        expiresAt: new Date(sealed.exp * 1000),
      });
      continue;
    }
    const direct = await sendApnsRawPush({
      deviceToken: apnsToken,
      environment:
        target.device.apnsEnvironment === "production"
          ? "production"
          : "sandbox",
      pushType: sealed.pushClass === "alert" ? "alert" : "background",
      // A passive alert (the dose confirmation) goes at priority 5, like its
      // plaintext twin; the relay picks its own priority per class.
      priority:
        sealed.pushClass === "alert" && target.message.ui?.level !== "passive"
          ? 10
          : 5,
      payload: templateFor(sealed.pushClass, sealed.envelope),
      collapseId: collapse,
      expiry: sealed.exp,
    });
    if (direct.ok) {
      result.anyAccepted = true;
    } else {
      result.lastFailure = direct.reason ?? "apns_send_failed";
      result.directFailures += 1;
      // Only Apple's `Unregistered` is final for a sealed push.
      if (direct.reason === "Unregistered") {
        await prisma.device.deleteMany({ where: { id: target.device.id } });
      }
    }
  }
  if (relayItems.length > 0) {
    const summary = await sendRelayItems(relayItems, ctx.config);
    result.relay = summary;
    if (summary.accepted > 0) result.anyAccepted = true;
    if (summary.waiting > 0) result.waiting = true;
    if (summary.failed > 0 && summary.accepted === 0) {
      result.lastFailure ??= "relay_item_failed";
    }
  }
  if (result.lastFailure) {
    getEvent()?.addMeta("push_sealed_last_failure", result.lastFailure);
  }
  return result;
}
