/**
 * What the relay's final answer to a Live Activity start or update leaves
 * on this server (`relay-send.ts` calls it once per push, when the push is
 * final).
 *
 * A start or update counts as done only once the relay answered `accepted`,
 * which it does once Apple took the push:
 *
 * - a start: the dose it was for is held on the device while it is in flight
 *   (`laStartedMedicationId`, `laStartedSlot`, `laStartRef`), so the next
 *   pass does not start it twice. `accepted` sets `laStartedAt`, and only
 *   then does `push.device.liveActivityStarted` name the dose. A start that
 *   failed for good (refused, or dropped at its deadline) clears the dose
 *   again, so a later pass starts it anew.
 * - an update: `accepted` stores its content state as the Activity's
 *   `lastRelayState`; a failed one leaves the state that is really showing,
 *   so the next pass sends the change again.
 *
 * Every write is keyed on the push itself (the start's ref, the update's
 * Activity token), so a late answer to an older push never overwrites a
 * newer one.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { textEquals } from "@/lib/db-like";

export const LA_START_EVENT = "LIVE_ACTIVITY_START";
export const LA_UPDATE_EVENT = "LIVE_ACTIVITY_UPDATE";

/**
 * How long a start or update the relay refused waits before the pass tries
 * that kind again for the device: a refusal rarely clears within minutes,
 * and the relay limits updates to 12 an hour per Activity.
 */
export const LA_REFUSED_COOLDOWN_MS = 30 * 60_000;

export interface SettledPush {
  deviceId: string;
  ref: string;
  eventType: string;
  /** The outbox item before it was cleared: carries the activity token and state. */
  item: unknown;
}

function activityOf(item: unknown): {
  token: string | null;
  state: Record<string, unknown> | null;
} {
  const activity = (item as { activity?: Record<string, unknown> } | null)
    ?.activity;
  const token = typeof activity?.token === "string" ? activity.token : null;
  const state =
    activity?.state && typeof activity.state === "object"
      ? (activity.state as Record<string, unknown>)
      : null;
  return { token, state };
}

/** Apply the final answer to one Live Activity start or update. */
export async function settleLiveActivityPush(
  push: SettledPush,
  status: "accepted" | "dropped" | "failed",
  now: Date = new Date(),
): Promise<void> {
  if (push.eventType === LA_START_EVENT) {
    await prisma.device.updateMany({
      where: { id: push.deviceId, laStartRef: push.ref },
      data:
        status === "accepted"
          ? { laStartedAt: now }
          : {
              laStartedMedicationId: null,
              laStartedSlot: null,
              laStartedAt: null,
              laStartRef: null,
            },
    });
    return;
  }
  if (push.eventType !== LA_UPDATE_EVENT || status !== "accepted") return;
  const { token, state } = activityOf(push.item);
  if (!token || !state) return;
  await prisma.liveActivityToken.updateMany({
    where: {
      deviceId: push.deviceId,
      // The outbox carries the token in lower case; the row keeps the
      // app's spelling.
      pushToken: textEquals(token),
    },
    data: { lastRelayState: { ...state } as Prisma.InputJsonObject },
  });
}

/**
 * Whether the relay refused the device's last push of `eventType` within the
 * cool-down: the pass leaves that kind alone for the device until it passed.
 */
export async function refusedRecently(
  deviceId: string,
  eventType: string,
  now: Date,
): Promise<boolean> {
  const last = await prisma.pushRelayDelivery.findFirst({
    where: {
      deviceId,
      eventType,
      createdAt: { gte: new Date(now.getTime() - LA_REFUSED_COOLDOWN_MS) },
    },
    orderBy: { createdAt: "desc" },
    select: { status: true },
  });
  return last?.status === "failed" || last?.status === "dropped";
}

/** Whether the start under `ref` is still in flight or already accepted. */
export async function startHeld(
  deviceId: string,
  ref: string | null,
): Promise<boolean> {
  if (!ref) return false;
  const row = await prisma.pushRelayDelivery.findUnique({
    where: { deviceId_ref: { deviceId, ref } },
    select: { status: true },
  });
  return row?.status === "pending" || row?.status === "accepted";
}

/** The Activity tokens an update is still in flight for, lower case. */
export async function updatesInFlight(deviceId: string): Promise<Set<string>> {
  const rows = await prisma.pushRelayDelivery.findMany({
    where: { deviceId, eventType: LA_UPDATE_EVENT, status: "pending" },
    select: { item: true },
  });
  return new Set(
    rows.flatMap((r) => {
      const { token } = activityOf(r.item);
      return token ? [token.toLowerCase()] : [];
    }),
  );
}
