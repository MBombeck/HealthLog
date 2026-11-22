/**
 * The device's relay binding: checked here, forwarded to the relay unchanged.
 *
 * The app signs `hl-bind-v1` (relay host, instance id, token tag, `device`,
 * a monotonic `seq`, `iat`) with its Ed25519 binding key. The relay binds a
 * token only with such a statement, so an instance that merely knows a token
 * cannot take it over. This server verifies the statement before forwarding
 * (the instance id is its own, the tag is the device's token, the signature
 * holds), forwards it with the consent record, and keeps it so the binding
 * can be resubmitted.
 *
 * The relay's answer maps onto `Device.relayState`, which the app reads on
 * `/api/auth/me`: `bound`, `conflict` (the relay sent the device a challenge
 * push to answer directly), `rebind_needed` (a fresh statement is needed),
 * `none`. Nothing the relay answers here deletes the device row.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { relayConfig, type RelayConfig } from "@/lib/push-relay/config";
import { tokenTagHex } from "@/lib/push-relay/encoding";
import { bindText, verifyEncoded } from "@/lib/push-relay/statements";
import {
  loadRegistration,
  relayCall,
  type RegistrationRow,
} from "@/lib/push-relay/registration";
import {
  drainRelayUnbinds,
  queueRelayUnbind,
} from "@/lib/push-relay/unbind-queue";

export interface BindingStatement {
  instanceId: string;
  tokenTag: string;
  kind: "device";
  seq: number;
  iat: number;
}

export interface RelayBinding {
  bindingKey: string;
  statement: BindingStatement;
  signature: string;
}

export type RelayState = "none" | "bound" | "rebind_needed" | "conflict";

/** Why a binding was refused before it reached the relay. */
export type BindingRefusal =
  | "relay_not_offered"
  | "instance_mismatch"
  | "token_mismatch"
  | "bad_signature";

/** Check a statement against this instance and the device's token. */
export function checkBindingStatement(
  binding: RelayBinding,
  apnsToken: string,
  registration: Pick<RegistrationRow, "instanceId"> | null,
  config: Pick<RelayConfig, "host">,
): BindingRefusal | null {
  if (!registration?.instanceId) return "relay_not_offered";
  if (binding.statement.instanceId !== registration.instanceId) {
    return "instance_mismatch";
  }
  if (binding.statement.tokenTag !== tokenTagHex(apnsToken)) {
    return "token_mismatch";
  }
  const text = bindText({ host: config.host, ...binding.statement });
  if (!verifyEncoded(binding.bindingKey, text, binding.signature)) {
    return "bad_signature";
  }
  return null;
}

/**
 * The consent day the relay stores. The relay counts every day in UTC
 * (`spec/protocol.md`, "State"), so this is the UTC day, not the person's.
 */
function utcDay(date: Date): string {
  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: the relay protocol keeps consent days in UTC
  return date.toISOString().slice(0, 10);
}

/** The state an answer to `POST /v1/bindings` leaves the device in. */
export function stateAfterBind(
  status: number | null,
  error: unknown,
): RelayState {
  if (status === 200 || status === 201) return "bound";
  if (status === 409 && error === "binding_conflict") return "conflict";
  // A stale statement, or the relay unreachable: the app sends a fresh one.
  if (status === null || (status === 401 && error === "stale_timestamp")) {
    return "rebind_needed";
  }
  return "none";
}

/**
 * Forward the stored binding of one device. Returns the new relay state; the
 * device row is updated, never deleted.
 */
export async function forwardBinding(
  deviceId: string,
  config: RelayConfig = relayConfig(),
): Promise<RelayState> {
  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: {
      apnsToken: true,
      apnsEnvironment: true,
      relayBindingKey: true,
      relayBindingStatement: true,
      relayBindingSignature: true,
      relayConsentAt: true,
      relayConsentVersion: true,
    },
  });
  const registration = await loadRegistration(config);
  if (
    !device?.apnsToken ||
    !device.relayBindingKey ||
    !device.relayBindingSignature ||
    !device.relayBindingStatement ||
    !device.relayConsentAt ||
    !device.relayConsentVersion ||
    !registration
  ) {
    return "none";
  }
  const token = device.apnsToken.toLowerCase();
  // An unbind still owed for this token (the account that held the device
  // before, `signed-out-push.ts`) goes out first: the relay refuses a second
  // binding key for a token another binding still holds.
  await drainRelayUnbinds(new Date(), config, [token]);
  const result = await relayCall(
    registration,
    "POST",
    "/v1/bindings",
    {
      token,
      env: device.apnsEnvironment === "sandbox" ? "sandbox" : "production",
      bindingKey: device.relayBindingKey,
      statement: device.relayBindingStatement,
      signature: device.relayBindingSignature,
      consent: {
        textVersion: device.relayConsentVersion,
        day: utcDay(device.relayConsentAt),
      },
    },
    config,
  );
  const state =
    result.kind === "transport"
      ? stateAfterBind(null, null)
      : stateAfterBind(result.status, result.body?.error);
  getEvent()?.addMeta(
    "push_relay_bind_status",
    result.kind === "transport" ? 0 : result.status,
  );
  getEvent()?.addMeta("push_relay_bind_state", state);
  await prisma.device.update({
    where: { id: deviceId },
    data: {
      relayState: state,
      relayBoundAt: state === "bound" ? new Date() : null,
    },
  });
  // The token is bound to this device now: an unbind still queued for it
  // would remove the binding just made.
  if (state === "bound") {
    await prisma.pushRelayUnbind.deleteMany({ where: { token } });
  }
  return state;
}

/**
 * Remove the relay binding of a device's token (`DELETE /v1/bindings`),
 * through the unbind queue: tried at once, retried by the minute pass while
 * the relay is not reachable (`unbind-queue.ts`). The relay answers `204`
 * whether or not the token was bound, so this reveals nothing.
 */
export async function unbindToken(
  apnsToken: string | null,
  config: RelayConfig = relayConfig(),
): Promise<void> {
  await queueRelayUnbind(apnsToken, config);
}

/** Clear everything relay-related on a device; the row itself stays. */
export function clearedRelayFields(options: { pushKey: boolean }) {
  return {
    relayState: "none",
    relayBoundAt: null,
    relayBindingKey: null,
    relayBindingStatement: Prisma.DbNull,
    relayBindingSignature: null,
    relayConsentAt: null,
    relayConsentVersion: null,
    // The Live Activity consent rides on the relay consent; it goes with it.
    liveActivityConsentAt: null,
    liveActivityConsentVersion: null,
    laStartToken: null,
    laStartStatement: Prisma.DbNull,
    laStartSignature: null,
    ...(options.pushKey ? { pushKeyPublic: null, pushKeySuites: [] } : {}),
  };
}
