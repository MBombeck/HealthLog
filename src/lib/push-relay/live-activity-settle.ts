/**
 * What the relay's final answer to a Live Activity start or update leaves
 * on this server (`relay-send.ts` calls it once per push, when the push is
 * final).
 *
 * A start or update counts as done only once the relay answered `accepted`,
 * which it does once Apple took the push:
 *
 * - a start: its outbox row is the start's whole record. It keeps the dose
 *   it was for (`medicationId`, `slotInstant`), so no later pass starts that
 *   dose twice ({@link doseStartHeld}); its `ref` is the start id the relay
 *   writes into the Activity's attributes; and only once `accepted` does
 *   `push.device` name it (`live-activity-started.ts`). A start that failed
 *   for good (refused, or dropped at its deadline) holds nothing, so a later
 *   pass starts the dose anew. The row's own status says all of it: nothing
 *   else is written here.
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
import { activitySlotWindow } from "@/lib/push-relay/activity-slot";

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
): Promise<void> {
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

/**
 * Whether the device has a start for this dose in flight or accepted: the
 * server's own record of what it started, on each start's outbox row
 * (`medicationId`, `slotInstant`). It holds the dose before the device
 * reports the Activity, and whatever the device row says about its last
 * start, which a start for another dose replaces. A start that failed for
 * good holds nothing; the cool-down decides when it is tried again.
 */
export async function doseStartHeld(
  deviceId: string,
  medicationId: string,
  slot: Date,
): Promise<boolean> {
  const row = await prisma.pushRelayDelivery.findFirst({
    where: {
      deviceId,
      eventType: LA_START_EVENT,
      medicationId,
      slotInstant: activitySlotWindow(slot),
      status: { in: ["pending", "accepted"] },
    },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Let the doses that were answered and are open again start anew on the
 * owner's devices: a take or skip ended their Activity (the app ends its
 * own, the intake flush the others'), and an undo, a delete or a move put
 * the dose back in its window. Without this the start row of the ended
 * Activity held the dose for good ({@link doseStartHeld}), and the device's
 * last start kept every other start back while the dose was due
 * (`unreportedRelayStart`), so a dose undone within its window never showed
 * on the lock screen again. An Activity of the dose that is still
 * registered keeps the pass from starting a second one beside it.
 */
export async function releaseReopenedDoseStarts(
  userId: string,
  doses: ReadonlyArray<{ medicationId: string; slotInstant: Date }>,
): Promise<void> {
  for (const dose of doses) {
    await releaseDoseStarts({ device: { userId } }, dose);
  }
}

/**
 * Let the starts of one dose go: their rows no longer hold it
 * ({@link doseStartHeld}), so a later pass may start it again, and they hold
 * no other start back. `where` scopes the rows (one device, or the owner's
 * devices).
 */
export async function releaseDoseStarts(
  where: Prisma.PushRelayDeliveryWhereInput,
  dose: { medicationId: string; slotInstant: Date },
): Promise<void> {
  await prisma.pushRelayDelivery.updateMany({
    where: {
      ...where,
      eventType: LA_START_EVENT,
      medicationId: dose.medicationId,
      slotInstant: activitySlotWindow(dose.slotInstant),
    },
    data: { medicationId: null, slotInstant: null },
  });
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
