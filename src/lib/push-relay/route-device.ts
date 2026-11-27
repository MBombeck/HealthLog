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
import { deleteDeviceRows } from "@/lib/devices/delete-devices";
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
import { relayRoutes } from "@/lib/push-relay/relay-state";
import {
  overRelay,
  sendRelayItems,
  type RelayItemInput,
  type RelayItemOutcome,
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
  return routeFor(device, {
    apnsConfigured: ctx.apnsConfigured,
    registration: ctx.registration,
    canSeal: ctx.keys !== null,
  });
}

/**
 * The one routing rule: the send (`routeOf`) and what `/api/auth/me` says
 * about the device (`push.device.transport`) both read it, so the app is
 * never shown a way the push does not take.
 */
export function routeFor(
  device: RoutableDevice,
  ctx: {
    apnsConfigured: boolean;
    registration: Pick<RegistrationRow, "instanceId" | "state"> | null;
    /** The sender keys are there to seal with. */
    canSeal: boolean;
  },
): DeviceRoute {
  if (!device.apnsToken) return "none";
  if (!device.pushKeyPublic) return ctx.apnsConfigured ? "legacy" : "none";
  if (!ctx.canSeal) return "none";
  if (ctx.apnsConfigured) return "direct";
  if (
    relayRoutes(ctx.registration) &&
    device.relayConsentAt &&
    device.relayState === "bound"
  ) {
    return "relay";
  }
  return "none";
}

/**
 * Whether the relay reaches `device`, whichever way its ordinary pushes take:
 * the relay route {@link routeFor} would pick if this server had no APNs key
 * of its own. A Live Activity start or update goes only over the relay, so
 * its eligibility reads this and never {@link routeOf}: on a server with its
 * own key and a relay registration, a bound device takes its alerts and
 * syncs over the key and its relay Activities over the relay.
 */
export function relayReachable(
  device: RoutableDevice,
  ctx: Pick<PushContext, "registration" | "keys">,
): boolean {
  return (
    routeFor(device, {
      apnsConfigured: false,
      registration: ctx.registration,
      canSeal: ctx.keys !== null,
    }) === "relay"
  );
}

export interface SealedTarget {
  device: RoutableDevice;
  message: EnvelopeMessage;
  /** What a newer push replaces: the dose for a dose, else the push itself. */
  collapseKey?: string;
  /** `DATA_CHANGED`: the domains the wake announces (`RelayItemInput`). */
  domains?: readonly string[];
}

/** What became of the push to one device, and the code that says why. */
export interface SealedDeviceResult {
  outcome: RelayItemOutcome;
  /** The relay's or Apple's code; null when accepted. */
  code: string | null;
  via: "relay" | "direct";
}

export interface SealedSendResult {
  /** Devices a sealed push was handed to, by id: sealed and sent or queued. */
  handled: string[];
  /**
   * The outcome per handled device: over the relay its item's outcome
   * (`relay-send.ts`), over this server's own key `accepted` or `failed`.
   * Whether a send succeeded is read here, never from a batch answer.
   */
  devices: Record<string, SealedDeviceResult>;
  anyAccepted: boolean;
  /** Something waits for the relay or Apple to come back. */
  waiting: boolean;
  /**
   * The ledger reason of a send that is only waiting: `relay_bad_signature`
   * while the relay refuses this server's signature (it waits for a fix on
   * this side, not for the relay), `relay_waiting` otherwise.
   */
  waitReason: "relay_waiting" | "relay_bad_signature";
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
    devices: {},
    anyAccepted: false,
    waiting: false,
    waitReason: "relay_waiting",
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
        // Over the relay every push of a class lives equally long, so the
        // clear `ttlSeconds` names the class and not the kind.
        message: route === "relay" ? overRelay(target.message) : target.message,
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
        ...(target.domains ? { domains: target.domains } : {}),
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
      result.devices[target.device.id] = {
        outcome: "accepted",
        code: null,
        via: "direct",
      };
    } else {
      result.lastFailure = direct.reason ?? "apns_send_failed";
      result.devices[target.device.id] = {
        outcome: "failed",
        code: result.lastFailure,
        via: "direct",
      };
      result.directFailures += 1;
      // Only Apple's `Unregistered` is final for a sealed push.
      if (direct.reason === "Unregistered") {
        await deleteDeviceRows({ id: target.device.id });
      }
    }
  }
  if (relayItems.length > 0) {
    const summary = await sendRelayItems(relayItems, ctx.config);
    result.relay = summary;
    for (const item of relayItems) {
      // An item the attempt did not reach (never the case today) is failed,
      // not assumed sent.
      const outcome = summary.byRef[item.ref] ?? "failed";
      const answer = summary.answers.find((a) => a.ref === item.ref);
      result.devices[item.deviceId] = {
        outcome,
        code:
          outcome === "accepted"
            ? null
            : (answer?.code ?? (outcome === "failed" ? "failed" : "deadline")),
        via: "relay",
      };
    }
    if (summary.accepted > 0) result.anyAccepted = true;
    if (summary.waiting > 0) result.waiting = true;
    if (summary.outcomes.bad_signature) {
      result.waitReason = "relay_bad_signature";
    }
    if (summary.failed > 0 && summary.accepted === 0) {
      // Name what the relay (or the outbox) answered, never a bare failure.
      const code = Object.keys(summary.outcomes).find((c) => c !== "accepted");
      result.lastFailure ??= code
        ? `relay_item_failed:${code}`
        : "relay_item_failed";
    }
  }
  if (result.lastFailure) {
    getEvent()?.addMeta("push_sealed_last_failure", result.lastFailure);
  }
  return result;
}

/**
 * What a sealed send came to, by the one rule every send path records with:
 * `ok` only when the push to every handled device was accepted. Otherwise
 * `error` when one failed for good, else `deferred` when the rest waits for
 * a retry or is owed; both name their reason. A send that handed nothing is
 * `error` too: the caller decides first whether that is a rest.
 */
export type SealedOutcome =
  | { result: "ok"; reason: null }
  | { result: "deferred" | "error"; reason: string };

export function sealedOutcome(
  sealed: Pick<SealedSendResult, "devices" | "lastFailure" | "waitReason">,
): SealedOutcome {
  const results = Object.values(sealed.devices);
  const failed = results.find((r) => r.outcome === "failed");
  if (failed) {
    return {
      result: "error",
      // Apple's reason stands as it is; a relay item's is named the relay's.
      reason:
        failed.via === "relay"
          ? `relay_item_failed:${failed.code ?? "failed"}`
          : (failed.code ?? "apns_send_failed"),
    };
  }
  const owed = results.find((r) => r.outcome === "owed");
  if (owed) return { result: "deferred", reason: owedReason(owed.code) };
  if (results.some((r) => r.outcome === "waiting")) {
    return { result: "deferred", reason: sealed.waitReason };
  }
  if (results.length === 0) {
    return {
      result: "error",
      reason: sealed.lastFailure ?? "sealed_nothing_sent",
    };
  }
  return { result: "ok", reason: null };
}

/** The reason of a push owed after the relay refused or dropped it. */
export function owedReason(code: string | null): string {
  return `relay_owed:${code ?? "deadline"}`;
}

/**
 * The `push_attempts` result of an outcome: that ledger knows `ok`, `skipped`
 * and `error`, and a deferred push is not sent yet, so it is `skipped` with
 * the reason it waits on.
 */
export function attemptResultOf(outcome: {
  result: "ok" | "deferred" | "skipped" | "error";
}): "ok" | "skipped" | "error" {
  if (outcome.result === "deferred") return "skipped";
  return outcome.result;
}
