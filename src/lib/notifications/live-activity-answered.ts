/**
 * Ending the Live Activity of a dose that is answered.
 *
 * A dose taken or skipped anywhere must not stay on a lock screen as due.
 * The Activity that shows it ends on two paths:
 *
 * - at once, in the intake sync flush that follows the write
 *   (`medication-intake-sync.ts`, through {@link endAnsweredActivities}), on
 *   every device of the record's account except the one that recorded the
 *   dose. That one is running the app, which ends its own Activity; a push
 *   to it would tell the relay and Apple the moment of every dose recorded
 *   on the phone itself, which the relay's consent text rules out.
 * - again by the five-minute pass ({@link retryLostActivityEnds}), for an
 *   end the relay did not take: the relay was down past the end's deadline,
 *   the device's binding was not usable at that moment, or the relay's own
 *   count refused it. Only an end the flush had already decided to send is
 *   sent again, so the pass tells the relay nothing the flush would not
 *   have. It goes on until the relay or Apple took the end, the Activity is
 *   reported gone or unregistered, or its statement is too old to end it
 *   with.
 *
 * A relay device's Activities end over the relay, with the statement the
 * device signed at their start; every other device's with this server's own
 * APNs key. The device stores one token and no medication for an Activity of
 * an older app build, so that token ends only when no dose it could show is
 * open ({@link liveActivityEndState}).
 */
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { getEvent } from "@/lib/logging/context";
import { sendLiveActivityEnd } from "@/lib/notifications/live-activity-end";
import {
  endedMedicationContentState,
  type MedicationLiveActivityContentState,
} from "@/lib/notifications/live-activity-content-state";
import { activitySlotWindow } from "@/lib/push-relay/activity-slot";
import { openActivityDoses } from "@/lib/push-relay/live-activity";
import { endActivitiesOverRelay } from "@/lib/push-relay/medication-pushes";
import {
  loadPushContext,
  relayReachable,
  ROUTABLE_DEVICE_SELECT,
  routeOf,
  type PushContext,
} from "@/lib/push-relay/route-device";

/** The dose a Live Activity shows, as far as the server knows it. */
export interface ActivityDose {
  medicationId: string | null;
  slotInstant: Date | null;
}

export type ActivityEndState = (
  dose: ActivityDose,
) => Promise<MedicationLiveActivityContentState | null>;

/** What the end of a device's Activities reads of the device row. */
export const ACTIVITY_DEVICE_SELECT = {
  ...ROUTABLE_DEVICE_SELECT,
  userId: true,
  relayBindingKey: true,
  liveActivityPushToken: true,
  liveActivities: {
    select: {
      id: true,
      pushToken: true,
      medicationId: true,
      slotInstant: true,
      activityStatement: true,
      activitySignature: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.DeviceSelect;

export type ActivityDevice = Prisma.DeviceGetPayload<{
  select: typeof ACTIVITY_DEVICE_SELECT;
}>;

/**
 * The content-state to end an Activity showing `dose` with, or null while
 * that dose is still open. With a slot: once that slot's live row is taken
 * or skipped; the slot the app registered is matched within
 * `activitySlotWindow`, because it comes from the device's own schedule and
 * need not equal the stored instant to the millisecond. With a medication
 * only: once none of its tracked doses the app could show is open
 * (`openActivityDoses`: up to two hours ahead, and not yet missed by the
 * medication's own bands). With neither (a device-level token): once no
 * tracked dose of the account is.
 */
export async function liveActivityEndState(
  userId: string,
  dose: ActivityDose,
): Promise<MedicationLiveActivityContentState | null> {
  const now = Date.now();
  if (dose.medicationId !== null && dose.slotInstant !== null) {
    const answered = await prisma.medicationIntakeEvent.count({
      where: {
        userId,
        medicationId: dose.medicationId,
        scheduledFor: activitySlotWindow(dose.slotInstant),
        deletedAt: null,
        OR: [{ takenAt: { not: null } }, { skipped: true }],
      },
    });
    if (answered === 0) return null;
  } else {
    // Open by the resolver's bands, the same doses a relay pass would show.
    const open = await openActivityDoses(
      userId,
      new Date(now),
      dose.medicationId ?? undefined,
    );
    if (open.length > 0) return null;
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timeFormat: true },
  });
  return endedMedicationContentState({
    resolvedAt: new Date(now),
    timeFormat: user?.timeFormat,
  });
}

/** `liveActivityEndState` of one account, asked once per dose. */
export function memoEndState(userId: string): ActivityEndState {
  const memo = new Map<
    string,
    Promise<MedicationLiveActivityContentState | null>
  >();
  return (dose: ActivityDose) => {
    const key = `${dose.medicationId ?? ""}|${dose.slotInstant?.getTime() ?? ""}`;
    let state = memo.get(key);
    if (!state) {
      state = liveActivityEndState(userId, dose);
      memo.set(key, state);
    }
    return state;
  };
}

export interface EndedActivities {
  /** Activity rows whose end went out, or whose Activity is gone. */
  activityIds: string[];
  /** The device-level token pushed its end, or Apple reports it dead. */
  deviceToken: boolean;
}

/** The transports an end can take. */
export interface ActivityEndRoutes {
  /**
   * The push context, needed for a device with a push key only; null when
   * the caller has none of those.
   */
  ctx: PushContext | null;
  /** This server's own APNs topic, or null when it has no APNs key. */
  bundleId: string | null;
}

/**
 * End every Activity of `device` whose dose is answered, over the route the
 * device has. Returns what is spent; {@link forgetEndedActivities} drops it.
 */
export async function endAnsweredActivities(
  device: ActivityDevice,
  routes: ActivityEndRoutes,
  endState: ActivityEndState,
): Promise<EndedActivities> {
  const ended: EndedActivities = { activityIds: [], deviceToken: false };
  if (!device.apnsToken) return ended;
  const activities = device.liveActivities;
  if (activities.length === 0 && !device.liveActivityPushToken) return ended;
  const { ctx } = routes;
  // A device without a push key takes this server's own key or nothing.
  const route = device.pushKeyPublic && ctx ? routeOf(device, ctx) : "legacy";
  if (route === "relay" && ctx) {
    const due = [];
    for (const activity of activities) {
      if (await endState(activity)) due.push(activity);
    }
    ended.activityIds.push(...(await endActivitiesOverRelay(device, due, ctx)));
    return ended;
  }
  const bundleId = routes.bundleId;
  if (!bundleId || route === "none") return ended;
  const environment: "sandbox" | "production" =
    device.apnsEnvironment === "production" ? "production" : "sandbox";
  // Each registered Activity ends once the dose it shows is answered; the
  // device-level token of a client that registers no list ends only when no
  // dose it could show is open.
  for (const activity of activities) {
    const contentState = await endState(activity);
    if (!contentState) continue;
    const spent = await sendLiveActivityEnd({
      token: activity.pushToken,
      environment,
      bundleId,
      contentState,
    });
    if (spent) ended.activityIds.push(activity.id);
  }
  const contentState = device.liveActivityPushToken
    ? await endState({ medicationId: null, slotInstant: null })
    : null;
  if (device.liveActivityPushToken && contentState) {
    ended.deviceToken = await sendLiveActivityEnd({
      token: device.liveActivityPushToken,
      environment,
      bundleId,
      contentState,
    });
  }
  return ended;
}

/**
 * Forget what is spent: an ended Activity's token, or one Apple reports
 * dead, addresses nothing; the app registers a fresh one with its next
 * Activity. Best effort.
 */
export async function forgetEndedActivities(
  activityIds: readonly string[],
  deviceIds: readonly string[],
): Promise<void> {
  if (activityIds.length > 0) {
    await prisma.liveActivityToken
      .deleteMany({ where: { id: { in: [...activityIds] } } })
      .catch(() => {
        /* best-effort cleanup */
      });
  }
  if (deviceIds.length > 0) {
    await prisma.device
      .updateMany({
        where: { id: { in: [...deviceIds] } },
        data: { liveActivityPushToken: null },
      })
      .catch(() => {
        /* best-effort cleanup */
      });
  }
}

/** Lost ends one pass looks at. */
const RETRY_LIMIT = 500;
/** An end's statement is good for 12 hours; older rows cannot be retried. */
const RETRY_WINDOW_MS = 12 * 3600_000;
/**
 * A refused end is tried again at most this often. A dropped one (the relay
 * was down past the deadline) goes with the next pass.
 */
const REFUSED_RETRY_MS = 30 * 60_000;
/** Refusals that pass: a binding not usable yet, or still provisional. */
const RETRYABLE_REFUSALS = ["not_bound", "activity_refused"];
const END_EVENT = "LIVE_ACTIVITY_END";
const END_REF_PREFIX = "end-";

export interface LostEndFacts {
  /** Lost ends whose Activity is still registered and whose dose is answered. */
  retried: number;
  /** Of those, how many the relay took now (or reported gone). */
  ended: number;
  failed: number;
}

/**
 * The five-minute pass: send again every Live Activity end the relay did not
 * take (see the module doc). The outbox retries an end that still waits by
 * itself; this is for the ones it has given up on.
 */
export async function retryLostActivityEnds(
  now: Date = new Date(),
): Promise<LostEndFacts> {
  const facts: LostEndFacts = { retried: 0, ended: 0, failed: 0 };
  const lost = await prisma.pushRelayDelivery.findMany({
    where: {
      eventType: END_EVENT,
      createdAt: { gte: new Date(now.getTime() - RETRY_WINDOW_MS) },
      OR: [
        { status: "dropped" },
        {
          status: "failed",
          reason: { in: RETRYABLE_REFUSALS },
          createdAt: {
            gte: new Date(now.getTime() - RETRY_WINDOW_MS),
            lte: new Date(now.getTime() - REFUSED_RETRY_MS),
          },
        },
      ],
    },
    select: { ref: true },
    orderBy: { createdAt: "asc" },
    take: RETRY_LIMIT,
  });
  const activityIds = lost
    .filter((row) => row.ref.startsWith(END_REF_PREFIX))
    .map((row) => row.ref.slice(END_REF_PREFIX.length));
  if (activityIds.length === 0) return facts;
  // An Activity the app has unregistered since is gone; its row stays out.
  const devices = await prisma.device.findMany({
    where: {
      apnsToken: { not: null },
      liveActivities: { some: { id: { in: activityIds } } },
    },
    select: {
      ...ACTIVITY_DEVICE_SELECT,
      liveActivities: {
        ...ACTIVITY_DEVICE_SELECT.liveActivities,
        where: { id: { in: activityIds } },
      },
    },
    orderBy: { id: "asc" },
  });
  if (devices.length === 0) return facts;
  const ctx = await loadPushContext();
  const endStates = new Map<string, ActivityEndState>();
  const spent: string[] = [];
  for (const device of devices) {
    // Only the relay keeps a record of an end it did not take, and the relay
    // may carry a device's Activity ends while its other pushes take this
    // server's own key (`laRelayBlock`).
    if (!relayReachable(device, ctx)) continue;
    let endState = endStates.get(device.userId);
    if (!endState) {
      endState = memoEndState(device.userId);
      endStates.set(device.userId, endState);
    }
    try {
      const due = [];
      for (const activity of device.liveActivities) {
        if (await endState(activity)) due.push(activity);
      }
      facts.retried += due.length;
      const ended = await endActivitiesOverRelay(device, due, ctx);
      spent.push(...ended);
      facts.ended += ended.length;
    } catch (err) {
      facts.failed += 1;
      getEvent()?.addWarning(
        `live_activity_end_retry_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  await forgetEndedActivities(spent, []);
  return facts;
}
