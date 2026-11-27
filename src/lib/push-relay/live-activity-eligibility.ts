/**
 * What the relay may do to a device's Live Activities now: start, update,
 * end ({@link laVerdict}). The one place the operator's switch and the
 * device's Live Activity consent decide anything; the pass
 * (`live-activity.ts`) and every relay end read it. Kept apart from the
 * sender so reading it sends nothing.
 *
 * An end needs only the relay's reach. Withdrawing the consent or turning the
 * switch off stops starts and updates, never the end of what already runs:
 * an Activity nobody updates any more would stay on the lock screen.
 *
 * The answer never depends on the way the device's ordinary pushes take
 * (`routeFor`): a server with its own APNs key and a relay registration sends
 * a bound device's alerts and syncs over its key, and its relay Activities
 * over the relay.
 */
import type { Prisma } from "@/generated/prisma/client";
import { liveActivityRelayEnabled } from "@/lib/push-relay/config";
import { fromBase64Url } from "@/lib/push-relay/encoding";
import { laStartTokenUsable } from "@/lib/push-relay/live-activity-start-token";
import {
  relayReachable,
  type PushContext,
  type RoutableDevice,
} from "@/lib/push-relay/route-device";

type LaEligibleDevice = RoutableDevice & {
  liveActivityConsentAt: Date | null;
  relayBindingKey: string | null;
};

/**
 * What keeps `device` from a relay start or update now, or null when nothing
 * does, in the order an operator and a person can fix it:
 *
 * - `switch_off`: the operator's `PUSH_RELAY_LIVE_ACTIVITY` is off;
 * - `not_bound`: the relay does not reach the device ({@link relayReachable}:
 *   this server is not registered, or the device is not bound with its relay
 *   consent and binding key);
 * - `no_consent`: the device has not given its Live Activity consent.
 *
 * Which way the device's ordinary pushes take plays no part: a server with
 * its own APNs key still starts its Activities over the relay.
 */
export type LaRelayBlock = "switch_off" | "not_bound" | "no_consent";

export function laRelayBlock(
  device: LaEligibleDevice,
  ctx: Pick<PushContext, "registration" | "keys">,
): LaRelayBlock | null {
  if (!liveActivityRelayEnabled()) return "switch_off";
  if (!laRelayCanEnd(device, ctx)) return "not_bound";
  if (device.liveActivityConsentAt === null) return "no_consent";
  return null;
}

/**
 * Whether the relay can end an Activity on `device`: it reaches the device
 * ({@link relayReachable}) and holds its binding key. Neither the switch nor
 * the Live Activity consent plays a part.
 */
export function laRelayCanEnd(
  device: RoutableDevice & { relayBindingKey: string | null },
  ctx: Pick<PushContext, "registration" | "keys">,
): boolean {
  return (
    relayReachable(device, ctx) &&
    fromBase64Url(device.relayBindingKey ?? "", 32) !== null
  );
}

/**
 * Whether the relay can start an Activity on `device` now, as the pass logs
 * it: `ready`, the first {@link LaRelayBlock}, or
 * `no_start_token` when the device holds no push-to-start token the relay
 * still takes. The start reads the same two checks.
 */
export type LiveActivityStartState = "ready" | LaRelayBlock | "no_start_token";

export function liveActivityStartState(
  device: Parameters<typeof laRelayBlock>[0] &
    Parameters<typeof laStartTokenUsable>[0],
  ctx: Pick<PushContext, "registration" | "keys">,
  now: Date,
): LiveActivityStartState {
  const block = laRelayBlock(device, ctx);
  if (block) return block;
  return laStartTokenUsable(device, now) ? "ready" : "no_start_token";
}

/** What the relay may do to `device`'s Live Activities now. */
export interface LaVerdict {
  start: boolean;
  update: boolean;
  end: boolean;
}

export function laVerdict(
  device: Parameters<typeof liveActivityStartState>[0],
  ctx: Pick<PushContext, "registration" | "keys">,
  now: Date,
): LaVerdict {
  const state = liveActivityStartState(device, ctx, now);
  return {
    start: state === "ready",
    update: state === "ready" || state === "no_start_token",
    end: laRelayCanEnd(device, ctx),
  };
}

/**
 * The devices the pass visits: every one the relay may reach that has a
 * Live Activity consent or a registered Activity. One without the consent,
 * or on a server whose switch is off, is visited only to end what runs.
 */
export const LA_PASS_DEVICE_WHERE: Prisma.DeviceWhereInput = {
  relayState: "bound",
  relayConsentAt: { not: null },
  apnsToken: { not: null },
  pushKeyPublic: { not: null },
  OR: [
    { liveActivityConsentAt: { not: null } },
    { liveActivities: { some: {} } },
  ],
};
