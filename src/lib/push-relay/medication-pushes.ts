/**
 * The medication pushes a sealed device gets: the visible confirmation of a
 * dose recorded elsewhere (`MEDICATION_INTAKE_RECORDED`, alert), the silent
 * intake sync (`MEDICATION_INTAKE_SYNC`, silent) and, over the relay, the
 * Live Activity end.
 *
 * The confirmation carries the same flat fields as the plaintext push
 * (`medicationId`, `intakeId`, `slotInstant`, `outcome`, `takenAt`,
 * `takenVia`) in `d`, the neutral localised text in `n`, and a passive level
 * in `ui`; no medication name. Its deadline is two hours: a confirmation that
 * arrives later than that no longer withdraws anything useful.
 *
 * The Live Activity end travels without an envelope: the relay sends its own
 * fixed content state. Its token and the device's signed activity statement
 * reach the relay only inside the end push, so the relay never learns when an
 * Activity starts. An Activity without a statement (an app build older than
 * the relay contract) is not ended over the relay.
 */
import { prisma } from "@/lib/db";
import { fromBase64Url } from "@/lib/push-relay/encoding";
import type { EnvelopeMessage } from "@/lib/push-relay/envelope";
import {
  routeOf,
  sendSealed,
  type PushContext,
  type RoutableDevice,
  type SealedSendResult,
} from "@/lib/push-relay/route-device";
import { sendRelayItems } from "@/lib/push-relay/relay-send";

const RECORDED_LIFETIME_S = 2 * 3600;
const SYNC_LIFETIME_S = 3600;
const ACTIVITY_LIFETIME_S = 4 * 3600;
/** The relay accepts an activity statement at most 12 hours old. */
const ACTIVITY_STATEMENT_MAX_AGE_S = 12 * 3600 - 300;
/** Silent pushes per relay device and hour (the relay's own limit). */
export const SILENT_PER_HOUR = 6;

export interface RecordedFields {
  medicationId: string;
  intakeId: string;
  slotInstant: Date;
  outcome: "taken" | "skipped";
  takenAt: Date | null;
  takenVia: string;
}

/** The sealed confirmation of one recorded dose. */
export function intakeRecordedMessage(
  event: RecordedFields,
  text: { title: string; body: string },
): EnvelopeMessage {
  return {
    pushClass: "alert",
    type: "MEDICATION_INTAKE_RECORDED",
    lifetimeSeconds: RECORDED_LIFETIME_S,
    data: {
      medicationId: event.medicationId,
      intakeId: event.intakeId,
      slotInstant: event.slotInstant.toISOString(),
      outcome: event.outcome,
      takenAt: event.takenAt?.toISOString() ?? null,
      takenVia: event.takenVia,
    },
    text,
    ui: { thread: `medication-${event.medicationId}`, level: "passive" },
  };
}

/** The sealed silent sync trigger; like the plaintext one, no health data. */
export function intakeSyncMessage(syncedAt: Date): EnvelopeMessage {
  return {
    pushClass: "silent",
    type: "MEDICATION_INTAKE_SYNC",
    lifetimeSeconds: SYNC_LIFETIME_S,
    data: { syncedAt: syncedAt.toISOString() },
  };
}

/** Send the confirmation sealed to every routable device. */
export function sendSealedIntakeRecorded(
  devices: RoutableDevice[],
  event: RecordedFields,
  text: { title: string; body: string },
  ctx: PushContext,
): Promise<SealedSendResult> {
  const message = intakeRecordedMessage(event, text);
  const collapseKey = `intake-${event.medicationId}-${event.slotInstant.getTime()}`;
  return sendSealed(
    devices.map((device) => ({ device, message, collapseKey })),
    ctx,
  );
}

/**
 * Whether a relay device still has silent budget this hour: every silent
 * push the relay carried for it counts, whatever its type.
 */
export async function silentBudgetLeft(
  deviceId: string,
  now: Date,
): Promise<boolean> {
  const sent = await prisma.pushRelayDelivery.count({
    where: {
      deviceId,
      pushClass: "silent",
      createdAt: { gte: new Date(now.getTime() - 3600_000) },
    },
  });
  return sent < SILENT_PER_HOUR;
}

/**
 * Send the silent sync sealed. A relay device is skipped when the flush also
 * carries a recorded confirmation (that alert triggers the sync in the
 * extension) or when its hourly silent budget is spent.
 */
export async function sendSealedIntakeSync(
  devices: RoutableDevice[],
  ctx: PushContext,
  options: { recordedInFlush: boolean },
): Promise<SealedSendResult> {
  const now = new Date();
  const message = intakeSyncMessage(now);
  const targets = [];
  for (const device of devices) {
    if (routeOf(device, ctx) === "relay") {
      if (options.recordedInFlush) continue;
      if (!(await silentBudgetLeft(device.id, now))) continue;
    }
    targets.push({ device, message, collapseKey: "intake-sync" });
  }
  return sendSealed(targets, ctx);
}

export interface RelayActivityRow {
  id: string;
  pushToken: string;
  activityStatement: unknown;
  activitySignature: string | null;
}

/**
 * End these Activities of one relay-bound device over the relay. Returns the
 * ids of the Activity rows that are spent: the relay accepted the end, or
 * reported the Activity gone.
 */
export async function endActivitiesOverRelay(
  device: RoutableDevice & { relayBindingKey: string | null },
  activities: RelayActivityRow[],
  ctx: PushContext,
): Promise<string[]> {
  if (routeOf(device, ctx) !== "relay" || !device.relayBindingKey) return [];
  if (!fromBase64Url(device.relayBindingKey, 32)) return [];
  const nowS = Math.floor(Date.now() / 1000);
  const items = activities.flatMap((activity) => {
    const statement = activity.activityStatement as { iat?: unknown } | null;
    if (
      !statement ||
      typeof statement.iat !== "number" ||
      !activity.activitySignature ||
      nowS - statement.iat > ACTIVITY_STATEMENT_MAX_AGE_S
    ) {
      return [];
    }
    return [
      {
        deviceId: device.id,
        ref: `end-${activity.id}`,
        pushClass: "liveactivity" as const,
        eventType: "LIVE_ACTIVITY_END",
        activity: {
          token: activity.pushToken.toLowerCase(),
          bindingKey: device.relayBindingKey as string,
          statement: statement as Record<string, unknown>,
          signature: activity.activitySignature,
        },
        expiresAt: new Date((nowS + ACTIVITY_LIFETIME_S) * 1000),
      },
    ];
  });
  if (items.length === 0) return [];
  const summary = await sendRelayItems(items, ctx.config);
  const settled = await prisma.pushRelayDelivery.findMany({
    where: {
      deviceId: device.id,
      ref: { in: items.map((i) => i.ref) },
      OR: [{ status: "accepted" }, { reason: "activity_gone" }],
    },
    select: { ref: true },
  });
  const spentRefs = new Set([
    ...settled.map((s) => s.ref),
    ...summary.activityGone,
  ]);
  return activities
    .filter((a) => spentRefs.has(`end-${a.id}`))
    .map((a) => a.id);
}
