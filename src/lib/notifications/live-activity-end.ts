/**
 * The ActivityKit `end` push, and ending every running Activity of a device
 * that leaves an account.
 *
 * A device leaves an account when its sign-in ends (sign-out, revoke, an
 * expired family) or when another account's registration takes the install
 * over. Its Live Activity tokens are dropped then, and an Activity whose
 * token is gone can no longer be ended by anyone: it would stay on the lock
 * screen, showing a dose of an account the phone has left, until
 * ActivityKit's own limit. {@link endDeviceLiveActivities} ends them first,
 * each the way its starter can end it ({@link leaveEndWays}), while the
 * relay binding that carries a relay end still exists.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import {
  endedMedicationContentState,
  type MedicationLiveActivityContentState,
} from "@/lib/notifications/live-activity-content-state";
import { sendApnsRawPush } from "@/lib/notifications/senders/apns";
import { endActivitiesOverRelay } from "@/lib/push-relay/medication-pushes";
import { relayActivityKind } from "@/lib/push-relay/live-activity-owner";
import {
  loadPushContext,
  ROUTABLE_DEVICE_SELECT,
  routeOf,
  type DeviceRoute,
} from "@/lib/push-relay/route-device";

/**
 * Push an ActivityKit `end` event to a running Live Activity. The Activity
 * push topic is the app bundle id suffixed with `.push-type.liveactivity`;
 * the body carries the ActivityKit envelope (`event: "end"`, a timestamp,
 * the full final content-state the app decodes) and nothing else — the push
 * token itself addresses the Activity, so no health data rides along.
 * Best-effort: a failure is annotated, never thrown. Returns whether the
 * token is spent: the end went out, or APNs reported the token dead.
 */
export async function sendLiveActivityEnd(args: {
  token: string;
  environment: "sandbox" | "production";
  bundleId: string;
  contentState: MedicationLiveActivityContentState;
}): Promise<boolean> {
  try {
    const nowS = Math.floor(Date.now() / 1000);
    const result = await sendApnsRawPush({
      deviceToken: args.token,
      environment: args.environment,
      pushType: "liveactivity",
      topic: `${args.bundleId}.push-type.liveactivity`,
      priority: 10,
      payload: {
        aps: {
          timestamp: nowS,
          event: "end",
          "content-state": args.contentState,
          // Dismiss the ended Activity from the lock screen promptly.
          "dismissal-date": nowS,
        },
      },
    });
    if (!result.ok) {
      getEvent()?.addMeta(
        "medication_intake_sync_liveactivity_failed",
        result.reason ?? "unknown",
      );
    }
    return result.ok || result.shouldDisable === true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getEvent()?.addWarning(
      `medication_intake_sync_liveactivity_threw: ${message}`,
    );
    return false;
  }
}

const LEAVING_DEVICE_SELECT = {
  ...ROUTABLE_DEVICE_SELECT,
  relayBindingKey: true,
  liveActivityPushToken: true,
  user: { select: { timeFormat: true } },
  liveActivities: {
    select: {
      id: true,
      pushToken: true,
      activityStatement: true,
      activitySignature: true,
      relayStarted: true,
    },
  },
} satisfies Prisma.DeviceSelect;

/**
 * How each running Activity of a leaving device ends: the way its starter
 * can end it. A relay-started one only over the relay, whatever way the
 * device's ordinary pushes take (this server's key would send it the app's
 * content state, which its attributes type does not read); an app-started
 * one, and the app's own update token, over the device's route (this
 * server's key for `direct` and `legacy`).
 */
export function leaveEndWays<
  A extends { pushToken: string; relayStarted: boolean },
>(
  device: { liveActivities: A[]; liveActivityPushToken: string | null },
  route: DeviceRoute,
): { overRelay: A[]; ownKey: string[] } {
  if (route === "relay") {
    return { overRelay: device.liveActivities, ownKey: [] };
  }
  const relayStarted = device.liveActivities.filter(
    (a) => relayActivityKind(a) === "relay_started",
  );
  if (route === "none") return { overRelay: relayStarted, ownKey: [] };
  return {
    overRelay: relayStarted,
    ownKey: [
      ...device.liveActivities
        .filter((a) => relayActivityKind(a) === "app_started")
        .map((a) => a.pushToken),
      ...(device.liveActivityPushToken ? [device.liveActivityPushToken] : []),
    ],
  };
}

/**
 * End every running Live Activity of these devices ({@link leaveEndWays}). Call it
 * before the rows lose their tokens or go. Returns how many Activities
 * ended. Best effort, never throws: the sign-out or takeover it precedes
 * goes on either way.
 */
export async function endDeviceLiveActivities(
  deviceIds: readonly string[],
): Promise<number> {
  if (deviceIds.length === 0) return 0;
  try {
    const devices = await prisma.device.findMany({
      where: {
        id: { in: [...deviceIds] },
        OR: [
          { liveActivities: { some: {} } },
          { liveActivityPushToken: { not: null } },
        ],
      },
      select: LEAVING_DEVICE_SELECT,
    });
    if (devices.length === 0) return 0;
    const ctx = await loadPushContext();
    let ended = 0;
    for (const device of devices) {
      const { overRelay, ownKey } = leaveEndWays(device, routeOf(device, ctx));
      if (overRelay.length > 0) {
        ended += (await endActivitiesOverRelay(device, overRelay, ctx)).length;
      }
      if (ownKey.length === 0 || !device.apnsToken || !ctx.bundleId) continue;
      const contentState = endedMedicationContentState({
        resolvedAt: new Date(),
        timeFormat: device.user.timeFormat,
      });
      for (const token of ownKey) {
        const spent = await sendLiveActivityEnd({
          token,
          environment:
            device.apnsEnvironment === "production" ? "production" : "sandbox",
          bundleId: ctx.bundleId,
          contentState,
        });
        if (spent) ended += 1;
      }
    }
    if (ended > 0) getEvent()?.addMeta("live_activities_ended_on_leave", ended);
    return ended;
  } catch (err) {
    getEvent()?.addWarning(
      `live_activity_end_on_leave_failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}
