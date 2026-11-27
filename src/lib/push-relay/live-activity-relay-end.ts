/**
 * Ending a device's Live Activities over the relay outside the pass: when an
 * app-started Activity makes a relay one redundant, and when the device
 * withdraws its Live Activity or relay consent. The pass
 * (`live-activity.ts`) ends through {@link endAndForget} too.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  relayActivityKind,
  supersededRelayActivities,
} from "@/lib/push-relay/live-activity-owner";
import { endActivitiesOverRelay } from "@/lib/push-relay/medication-pushes";
import {
  loadPushContext,
  ROUTABLE_DEVICE_SELECT,
  type PushContext,
} from "@/lib/push-relay/route-device";

/** What the server reads of a registered Activity. */
export const LA_ACTIVITY_SELECT = {
  id: true,
  pushToken: true,
  medicationId: true,
  slotInstant: true,
  activityStatement: true,
  activitySignature: true,
  lastRelayState: true,
  relayStarted: true,
} as const satisfies Prisma.LiveActivityTokenSelect;

type LaActivity = Prisma.LiveActivityTokenGetPayload<{
  select: typeof LA_ACTIVITY_SELECT;
}>;

/**
 * End these Activities of `device` over the relay and forget the tokens the
 * relay took the end of, or reported gone. Returns the ids forgotten.
 */
export async function endAndForget(
  device: Parameters<typeof endActivitiesOverRelay>[0],
  activities: LaActivity[],
  ctx: PushContext,
): Promise<Set<string>> {
  if (activities.length === 0) return new Set();
  const spent = new Set(await endActivitiesOverRelay(device, activities, ctx));
  if (spent.size > 0) {
    await prisma.liveActivityToken.deleteMany({
      where: { id: { in: [...spent] } },
    });
  }
  return spent;
}

/**
 * End the Activities of a device that `pick` names, now, over the relay;
 * the pass ends one whose end the relay did not take. Returns how many
 * ended. Nothing is sent when `pick` names none, so a repeat is a no-op.
 */
async function endDeviceRelayActivities(
  deviceId: string,
  pick: (activities: LaActivity[]) => LaActivity[],
): Promise<number> {
  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: {
      ...ROUTABLE_DEVICE_SELECT,
      relayBindingKey: true,
      liveActivities: { select: LA_ACTIVITY_SELECT },
    },
  });
  if (!device) return 0;
  const picked = pick(device.liveActivities);
  if (picked.length === 0) return 0;
  return (await endAndForget(device, picked, await loadPushContext())).size;
}

/**
 * End the relay-started Activities an app-started one of the same dose made
 * redundant ({@link supersededRelayActivities}). Run when the device
 * registers its Activities, so the second one goes at once.
 */
export function endSupersededRelayActivities(deviceId: string) {
  return endDeviceRelayActivities(deviceId, supersededRelayActivities);
}

/**
 * End every Activity the relay started on the device. Run when the device
 * withdraws its Live Activity or relay consent, before the relay forgets
 * the consent or the binding: nothing would update or end them after that.
 * The app's own Activities are the app's, and stay.
 */
export function endRelayStartedActivities(deviceId: string) {
  return endDeviceRelayActivities(deviceId, relayStartedOf);
}

export function relayStartedOf<T extends { relayStarted: boolean }>(
  activities: readonly T[],
): T[] {
  return activities.filter((a) => relayActivityKind(a) === "relay_started");
}
