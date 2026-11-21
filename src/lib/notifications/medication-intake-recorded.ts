/**
 * The visible confirmation that a dose was recorded somewhere else:
 * `MEDICATION_INTAKE_RECORDED`.
 *
 * The silent intake sync is a hint. Apple throttles it to a few per hour and
 * never delivers it to a force-quit app, and a reminder the iPhone scheduled
 * locally can only be withdrawn by the app itself or by its Notification
 * Service Extension, which runs only for a REMOTE alert. So a take or a skip
 * recorded on the web, in Telegram, through the ingest hook or by the
 * auto-take also sends this quiet alert to the owner's iOS devices other than
 * the one that recorded it. The extension reads the payload, withdraws the
 * matching local reminder and shows the neutral text, or nothing.
 *
 * Wire (APNs): `apns-push-type: alert`, priority 5, `apns-collapse-id` per
 * slot, `aps.mutable-content: 1`, `aps.interruption-level: passive`,
 * `aps.thread-id` per medication, and a neutral localised alert with no
 * medication name, like every medication push without a name. Custom keys
 * beside `aps`: `eventType`, `medicationId`, `intakeId`, `slotInstant`,
 * `outcome` (`taken` | `skipped`), `takenAt` (null on a skip), `takenVia`.
 *
 * Gating: the APNs channel must be enabled; an explicit per-channel
 * preference row for this event wins; without one the confirmation is on
 * for an account whose phone keeps its own medication reminders (the
 * account-wide `clientManaged` switch, or a device registered for client
 * delivery) and off otherwise. Every send writes one `push_attempts` row.
 *
 * Rate: one push per slot per coalescing window. Several writes of one slot
 * inside the window send the last state once.
 */
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { locales, type Locale } from "@/lib/i18n/config";
import {
  loadApnsConfig,
  sendApnsRawPush,
} from "@/lib/notifications/senders/apns";
import { recordPushAttempt } from "@/lib/notifications/senders/push-attempt-record";
import { CLIENT_MANAGED_APNS_EVENTS } from "@/lib/notifications/client-managed-apns";
import { pendingDeletionOf } from "@/lib/account-deletion/pending";
import {
  loadPushContext,
  ROUTABLE_DEVICE_SELECT,
} from "@/lib/push-relay/route-device";
import { sendSealedIntakeRecorded } from "@/lib/push-relay/medication-pushes";

/** The confirmation of a row that now records a take or a skip, else none. */
export function recordedEventOf(
  row: {
    id: string;
    medicationId: string;
    scheduledFor: Date;
    takenAt: Date | null;
    skipped: boolean;
  },
  takenVia: IntakeRecordedEvent["takenVia"],
): IntakeRecordedEvent | undefined {
  if (!row.skipped && row.takenAt === null) return undefined;
  return {
    medicationId: row.medicationId,
    intakeId: row.id,
    slotInstant: row.scheduledFor,
    outcome: row.skipped ? "skipped" : "taken",
    takenAt: row.skipped ? null : row.takenAt,
    takenVia,
  };
}

export const INTAKE_RECORDED_EVENT = "MEDICATION_INTAKE_RECORDED";
const COALESCE_WINDOW_MS = 2_000;

export interface IntakeRecordedEvent {
  medicationId: string;
  intakeId: string;
  slotInstant: Date;
  outcome: "taken" | "skipped";
  takenAt: Date | null;
  takenVia:
    | "WEB"
    | "APP"
    | "INTEGRATION"
    | "TELEGRAM"
    | "APPLE_HEALTH"
    | "IMPORT"
    | "AUTO";
}

interface Pending {
  event: IntakeRecordedEvent;
  originDeviceToken: string | null;
}

const pending = new Map<string, Pending>();

function slotKey(userId: string, event: IntakeRecordedEvent): string {
  return `${userId}|${event.medicationId}|${event.slotInstant.toISOString()}`;
}

/** Queue the confirmation of one slot's new outcome. Never throws. */
export function queueIntakeRecorded(input: {
  userId: string;
  event: IntakeRecordedEvent;
  originDeviceToken: string | null;
}): void {
  try {
    const key = slotKey(input.userId, input.event);
    const queued = pending.has(key);
    pending.set(key, {
      event: input.event,
      originDeviceToken: input.originDeviceToken,
    });
    if (queued) return;
    const timer = setTimeout(() => {
      const last = pending.get(key);
      pending.delete(key);
      if (last) void sendIntakeRecorded(input.userId, last);
    }, COALESCE_WINDOW_MS);
    timer.unref?.();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getEvent()?.addWarning(
      `medication_intake_recorded_queue_failed: ${message}`,
    );
  }
}

/** Whether the owner gets the confirmation at all (see the module doc). */
export async function recordedConfirmationEnabled(
  userId: string,
): Promise<boolean> {
  const channel = await prisma.notificationChannel.findUnique({
    where: { userId_type: { userId, type: "APNS" } },
    select: {
      enabled: true,
      preferences: {
        where: { eventType: INTAKE_RECORDED_EVENT },
        select: { enabled: true },
      },
    },
  });
  if (!channel?.enabled) return false;
  const pref = channel.preferences[0];
  if (pref) return pref.enabled;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { notificationPrefs: true },
  });
  const gate = CLIENT_MANAGED_APNS_EVENTS.MEDICATION_REMINDER;
  if (gate?.isClientManaged(user?.notificationPrefs)) return true;
  const clientDevice = await prisma.device.findFirst({
    where: { userId, medicationDelivery: "client", apnsToken: { not: null } },
    select: { id: true },
  });
  return clientDevice !== null;
}

function localeOf(value: string | null | undefined): Locale {
  return value && (locales as readonly string[]).includes(value)
    ? (value as Locale)
    : "en";
}

/** The APNs body of one confirmation. Exported for the contract test. */
export function intakeRecordedPayload(
  event: IntakeRecordedEvent,
  locale: Locale,
): Record<string, unknown> {
  return {
    aps: {
      alert: recordedText(event, locale),
      "mutable-content": 1,
      "interruption-level": "passive",
      "thread-id": `medication-${event.medicationId}`,
    },
    eventType: INTAKE_RECORDED_EVENT,
    medicationId: event.medicationId,
    intakeId: event.intakeId,
    slotInstant: event.slotInstant.toISOString(),
    outcome: event.outcome,
    takenAt: event.takenAt?.toISOString() ?? null,
    takenVia: event.takenVia,
  };
}

/** The neutral localised text of one confirmation. */
function recordedText(event: IntakeRecordedEvent, locale: Locale) {
  const { t } = getServerTranslator(locale);
  return {
    title: t("notifications.intakeRecorded.title"),
    body: t(
      event.outcome === "taken"
        ? "notifications.intakeRecorded.bodyTaken"
        : "notifications.intakeRecorded.bodySkipped",
    ),
  };
}

async function sendIntakeRecorded(userId: string, item: Pending) {
  try {
    const config = loadApnsConfig();
    if (await pendingDeletionOf(userId)) return;
    const [devices, user] = await Promise.all([
      prisma.device.findMany({
        where: { userId, apnsToken: { not: null } },
        select: { token: true, ...ROUTABLE_DEVICE_SELECT },
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { locale: true },
      }),
    ]);
    const sealedAny = devices.some((d) => d.pushKeyPublic !== null);
    if (!config && !sealedAny) return;
    if (!(await recordedConfirmationEnabled(userId))) {
      recordPushAttempt({
        userId,
        channel: "APNS",
        eventType: INTAKE_RECORDED_EVENT,
        result: "skipped",
        reason: "intake_recorded_disabled",
      });
      return;
    }
    const recipients = devices.filter(
      (d) => !item.originDeviceToken || d.token !== item.originDeviceToken,
    );
    if (recipients.length === 0) {
      recordPushAttempt({
        userId,
        channel: "APNS",
        eventType: INTAKE_RECORDED_EVENT,
        result: "skipped",
        reason: "intake_recorded_no_other_devices",
      });
      return;
    }
    const locale = localeOf(user?.locale);
    let anyOk = false;
    let lastReason: string | undefined;
    // A device with a push key gets the confirmation sealed, over this
    // server's APNs key or the relay; never the plaintext below.
    const sealedDevices = recipients.filter((d) => d.pushKeyPublic !== null);
    if (sealedDevices.length > 0) {
      const sealed = await sendSealedIntakeRecorded(
        sealedDevices,
        item.event,
        recordedText(item.event, locale),
        await loadPushContext(),
      );
      if (sealed.anyAccepted) anyOk = true;
      else if (sealed.lastFailure) lastReason = sealed.lastFailure;
    }
    const payload = intakeRecordedPayload(item.event, locale);
    for (const device of recipients) {
      if (!config || !device.apnsToken || device.pushKeyPublic) continue;
      const result = await sendApnsRawPush({
        deviceToken: device.apnsToken,
        environment:
          device.apnsEnvironment === "production" ? "production" : "sandbox",
        pushType: "alert",
        priority: 5,
        collapseId: `intake-${item.event.medicationId}-${item.event.slotInstant.getTime()}`,
        payload,
      });
      if (result.ok) anyOk = true;
      else lastReason = result.reason;
    }
    recordPushAttempt({
      userId,
      channel: "APNS",
      eventType: INTAKE_RECORDED_EVENT,
      result: anyOk ? "ok" : "error",
      reason: anyOk ? null : (lastReason ?? "intake_recorded_failed"),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getEvent()?.addWarning(`medication_intake_recorded_failed: ${message}`);
  }
}
