/**
 * The doses the server-started Live Activities show, for the device that
 * runs them.
 *
 * A relay start carries the content state and its start id only
 * (`HealthLogDoseAttributes`, attributes `{"v":1,"s":"<start id>"}`), never
 * the dose: the relay and Apple see that a dose is due, not which. Each
 * start's outbox row (`push_relay_deliveries`, event `LIVE_ACTIVITY_START`)
 * is the server's record of it: its `ref` is the start id, `medicationId`
 * and `slotInstant` its dose. The app learns the dose over the
 * authenticated channel only, on `GET /api/auth/me` and in the
 * `POST /api/devices` answer, both read through {@link liveActivityStartsState}:
 *
 * - `push.device.liveActivityStarts`: every start that may still run, by
 *   start id, always present (empty when none runs). A start is listed from
 *   the moment the server records it (`state: "pending"`), so an Activity
 *   that appears before the relay's answer has a name at once; once the
 *   relay accepted it, it reads `"accepted"`. A start the relay refused, or
 *   that was dropped at its deadline, started nothing on the device and
 *   leaves the list: no Activity can carry its id.
 * - `push.device.liveActivityStarted`: the device's last start alone, for
 *   builds that read no start id (1.49), and only once accepted. It is
 *   always an entry of the list, the same object.
 *
 * A start leaves both once there is nothing left to show: the slot was
 * taken, skipped or turned missed, its row is gone, the medication was
 * paused, ended or deleted, or its Live Activity opt-in
 * (`liveActivityEnabled`) was turned off, or the system has ended the
 * Activity ({@link RELAY_ACTIVITY_RUNNING_MAX_MS}). The server ends an
 * Activity only in those cases (`liveActivityEndState`, and the relay pass
 * for a server-started Activity whose medication may no longer have one),
 * so an ended Activity reads as gone too. A server-started Activity ended
 * because the app's own Activity shows the same dose
 * (`supersededRelayActivities`) stays named: the dose stays held, so no
 * second start follows. An Activity the person dismissed on the device stays
 * named until the slot is answered; the app knows it dismissed it.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { STARTABLE_MEDICATION_WHERE } from "@/lib/push-relay/activity-slot";
import { LA_START_EVENT } from "@/lib/push-relay/live-activity-settle";

/**
 * How long a relay-started Activity can still be running after its start.
 * ActivityKit ends an Activity eight hours after it started; an ended one
 * may stay on the lock screen up to twelve hours in all, but it takes no
 * further update, cannot be ended twice, and is not an Activity the app
 * reports as running. So past eight hours a start is over whatever the
 * server's records say, and holds no other start back.
 */
export const RELAY_ACTIVITY_RUNNING_MAX_MS = 8 * 3600_000;

/** At most this many starts are listed: the relay's starts per device and day. */
const STARTS_LISTED_MAX = 12;

/**
 * A start id as the app sends it back: opaque ASCII, at most 64 characters.
 * The server mints `las-` and 16 random bytes in base64url (the start's
 * outbox ref); it holds no medication, no dose and no time, since the relay
 * and Apple read the attributes in the clear.
 */
export const START_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export interface LiveActivityStart {
  startId: string;
  medicationId: string;
  slotInstant: string;
  /** When the server issued the start. */
  startedAt: string;
  /** `pending` while the relay has not answered, `accepted` once it took it. */
  state: "pending" | "accepted";
}

/** The device's last start, once accepted: always an entry of the list. */
export type LiveActivityStarted = LiveActivityStart;

/** Whether the dose is still open on a medication that keeps its Activity. */
async function doseStillOpen(
  userId: string,
  medicationId: string,
  slot: Date,
): Promise<boolean> {
  const open = await prisma.medicationIntakeEvent.findFirst({
    where: {
      userId,
      medicationId,
      scheduledFor: slot,
      deletedAt: null,
      takenAt: null,
      skipped: false,
      autoMissed: false,
      medication: STARTABLE_MEDICATION_WHERE,
    },
    select: { id: true },
  });
  // One live row per slot (migration 0515), so an open row is the answer.
  return open !== null;
}

/**
 * Both start fields of `push.device` for one device: the list of starts
 * that may still run, oldest first, and the last start when it is accepted
 * and listed. `liveActivityStarted` is taken from the list itself, so its
 * `startId` is always one of the list's.
 */
export async function liveActivityStartsState(
  device: { id: string; userId: string },
  now: Date = new Date(),
): Promise<{
  liveActivityStarts: LiveActivityStart[];
  liveActivityStarted: LiveActivityStarted | null;
}> {
  const [rows, last] = await Promise.all([
    prisma.pushRelayDelivery.findMany({
      where: {
        deviceId: device.id,
        eventType: LA_START_EVENT,
        status: { in: ["pending", "accepted"] },
        medicationId: { not: null },
        slotInstant: { not: null },
        createdAt: {
          gte: new Date(now.getTime() - RELAY_ACTIVITY_RUNNING_MAX_MS),
        },
      },
      // The newest, so the last start is never cut off; listed oldest first.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: STARTS_LISTED_MAX,
      select: {
        ref: true,
        status: true,
        medicationId: true,
        slotInstant: true,
        createdAt: true,
      },
    }),
    prisma.pushRelayDelivery.findFirst({
      where: { deviceId: device.id, eventType: LA_START_EVENT },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { ref: true },
    }),
  ]);
  const starts: LiveActivityStart[] = [];
  for (const row of rows.reverse()) {
    const { medicationId, slotInstant } = row;
    if (!medicationId || !slotInstant) continue;
    if (!(await doseStillOpen(device.userId, medicationId, slotInstant))) {
      continue;
    }
    starts.push({
      startId: row.ref,
      medicationId,
      slotInstant: slotInstant.toISOString(),
      startedAt: row.createdAt.toISOString(),
      state: row.status === "accepted" ? "accepted" : "pending",
    });
  }
  const started =
    starts.find((s) => s.startId === last?.ref && s.state === "accepted") ??
    null;
  return { liveActivityStarts: starts, liveActivityStarted: started };
}

/** The relay starts of a device the app has not registered yet. */
const UNREPORTED_START_WHERE = {
  eventType: LA_START_EVENT,
  status: { in: ["pending", "accepted"] },
  laReportedAt: null,
  medicationId: { not: null },
} satisfies Prisma.PushRelayDeliveryWhereInput;

/**
 * How many relay starts on `device` may be running unseen: in flight or
 * accepted within {@link RELAY_ACTIVITY_RUNNING_MAX_MS}, still holding
 * their dose, and not registered by the app yet. Each counts against
 * `MAX_DEVICE_ACTIVITIES` (`live-activity.ts`) until the app registers it (then its token
 * counts) or the system has ended it.
 */
export async function unreportedStartCount(
  deviceId: string,
  now: Date,
): Promise<number> {
  return prisma.pushRelayDelivery.count({
    where: {
      deviceId,
      ...UNREPORTED_START_WHERE,
      createdAt: {
        gte: new Date(now.getTime() - RELAY_ACTIVITY_RUNNING_MAX_MS),
      },
    },
  });
}
