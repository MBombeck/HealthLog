/**
 * Whether the relay may start or update a Live Activity on a device, read by
 * the pass (`live-activity.ts`), which logs the first reason a start is held
 * back. Kept apart from the sender so reading it sends nothing.
 *
 * The answer never depends on the way the device's ordinary pushes take
 * (`routeFor`): a server with its own APNs key and a relay registration sends
 * a bound device's alerts and syncs over its key, and its relay Activities
 * over the relay.
 */
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
  if (
    !relayReachable(device, ctx) ||
    fromBase64Url(device.relayBindingKey ?? "", 32) === null
  ) {
    return "not_bound";
  }
  if (device.liveActivityConsentAt === null) return "no_consent";
  return null;
}

/** Whether `device` may get a relay start or update now. */
export function laRelayEligible(
  device: LaEligibleDevice,
  ctx: Pick<PushContext, "registration" | "keys">,
): boolean {
  return laRelayBlock(device, ctx) === null;
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
