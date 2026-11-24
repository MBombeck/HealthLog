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
 * `POST /api/devices` answer:
 *
 * - `push.device.liveActivityStarts`: every start the relay accepted on the
 *   device that may still run, by start id. An app that reads the `s`
 *   attribute names each Activity exactly.
 * - `push.device.liveActivityStarted`: the device's last start alone, for
 *   builds that read no start id (1.49).
 *
 * A start is named only once the relay accepted it: one still in flight, or
 * one that failed, started nothing on the device. It is no longer named once
 * there is nothing left to show: the slot was taken, skipped or turned
 * missed, its row is gone, the medication was paused, ended or deleted, or
 * its Live Activity opt-in (`liveActivityEnabled`) was turned off, or the
 * system has ended the Activity ({@link RELAY_ACTIVITY_RUNNING_MAX_MS}). The
 * server ends an Activity only in those cases (`liveActivityEndState`, and
 * the relay pass for a server-started Activity whose medication may no
 * longer have one), so an ended Activity reads as gone too. A server-started
 * Activity ended because the app's own Activity shows the same dose
 * (`supersededRelayActivities`) stays named: the dose stays held, so no
 * second start follows. An Activity the person dismissed on the device stays
 * named until the slot is answered; the app knows it dismissed it.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { STARTABLE_MEDICATION_WHERE } from "@/lib/push-relay/activity-slot";
import { LA_START_EVENT } from "@/lib/push-relay/live-activity-settle";

/**
 * How long a relay-started Activity can still be running after the relay
 * accepted its start. ActivityKit ends an Activity eight hours after it
 * started; an ended one may stay on the lock screen up to twelve hours in
 * all, but it takes no further update, cannot be ended twice, and is not an
 * Activity the app reports as running. So past eight hours a start is over
 * whatever the server's records say, and holds no other start back.
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
  /** When the relay accepted the start. */
  startedAt: string;
}

/** The device's last start; the same shape, for builds without start ids. */
export type LiveActivityStarted = LiveActivityStart;

type StartRow = {
  ref: string;
  status: string;
  medicationId: string | null;
  slotInstant: Date | null;
  acceptedAt: Date | null;
};

const START_ROW_SELECT = {
  ref: true,
  status: true,
  medicationId: true,
  slotInstant: true,
  acceptedAt: true,
} as const;

/** Whether the dose of `row` is still open on a medication that keeps it. */
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

/** The start `row` names, once the relay accepted it with its dose. */
function named(row: StartRow): (LiveActivityStart & { slot: Date }) | null {
  const { medicationId, slotInstant, acceptedAt } = row;
  if (row.status !== "accepted" || !medicationId || !slotInstant) return null;
  if (!acceptedAt) return null;
  return {
    startId: row.ref,
    medicationId,
    slotInstant: slotInstant.toISOString(),
    startedAt: acceptedAt.toISOString(),
    slot: slotInstant,
  };
}

/** The start without the slot as a date, as the app reads it. */
function wire({ slot: _slot, ...start }: LiveActivityStart & { slot: Date }) {
  return start;
}

/** The dose of the device's last start, while it may still show. */
export async function liveActivityStartedOf(device: {
  id: string;
  userId: string;
}): Promise<LiveActivityStarted | null> {
  const last = await prisma.pushRelayDelivery.findFirst({
    where: { deviceId: device.id, eventType: LA_START_EVENT },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: START_ROW_SELECT,
  });
  const start = last ? named(last) : null;
  if (!start) return null;
  if (!(await doseStillOpen(device.userId, start.medicationId, start.slot))) {
    return null;
  }
  return wire(start);
}

/**
 * The starts the relay accepted on the device that may still run, oldest
 * first, each with its start id and dose.
 */
export async function liveActivityStartsOf(
  device: { id: string; userId: string },
  now: Date = new Date(),
): Promise<LiveActivityStart[]> {
  const rows = await prisma.pushRelayDelivery.findMany({
    where: {
      deviceId: device.id,
      eventType: LA_START_EVENT,
      status: "accepted",
      medicationId: { not: null },
      acceptedAt: {
        gte: new Date(now.getTime() - RELAY_ACTIVITY_RUNNING_MAX_MS),
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: STARTS_LISTED_MAX,
    select: START_ROW_SELECT,
  });
  const starts: LiveActivityStart[] = [];
  for (const row of rows) {
    const start = named(row);
    if (!start) continue;
    if (!(await doseStillOpen(device.userId, start.medicationId, start.slot))) {
      continue;
    }
    starts.push(wire(start));
  }
  return starts;
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
