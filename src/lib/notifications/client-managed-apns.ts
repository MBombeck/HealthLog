/**
 * Client-managed suppression — the APNs leg only.
 *
 * A user whose iOS client schedules its own local reminders sets
 * `notificationPrefs.<category>.clientManaged` (or the medication
 * `deliveryDefault: "client"` that maps onto it). The published contract,
 * the OpenAPI description and every copy site say the same thing: it
 * suppresses the server's APNs send. It used to suppress the whole
 * dispatch, so a user who flipped it also lost Telegram, ntfy, webhook,
 * email and Web Push — channels they may read on a device that is not the
 * phone holding the local schedule.
 *
 * The gate therefore lives here, next to the channel loop, and applies to
 * exactly one channel. The per-skip wide-event annotation is preserved so
 * the suppression stays countable; the annotation key per category is the
 * one the crons emitted before the move.
 */
import { prisma } from "@/lib/db";
import {
  isMeasurementReminderClientManaged,
  isMedicationReminderClientManaged,
} from "@/lib/validations/notification-prefs";

interface ClientManagedGate {
  /** Reads the category's flag out of the raw `notificationPrefs` blob. */
  isClientManaged: (raw: unknown) => boolean;
  /** Wide-event meta key, unchanged from the cron that used to emit it. */
  metaKey: string;
  /** Stable per-skip identifier built from the dispatch payload metadata. */
  tag: (metadata: Record<string, unknown> | undefined) => string;
  /**
   * Optional structured companion, emitted under `detailKey`. Same key and
   * same shape the cron used to emit, so an operator's existing read of the
   * wide event still resolves the medication, schedule and dose instant.
   */
  detailKey?: string;
  detail?: (
    userId: string,
    metadata: Record<string, unknown> | undefined,
  ) => Record<string, unknown>;
  /**
   * Which dispatches of the event the flag covers. Absent: all of them. The
   * flag says the phone delivers this reminder itself, so it covers exactly
   * what the phone replaces and nothing the phone does not send.
   */
  covers?: (metadata: Record<string, unknown> | undefined) => boolean;
  /**
   * #179 — each device may override the account-wide flag for this event
   * through `Device.medicationDelivery`: `client` keeps the server's push off
   * that device, `server` sends it there whatever the account says, and no
   * override follows the account. See {@link resolveApnsDeliveryTargets}.
   */
  perDevice?: boolean;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Closed map: only these event types honour a client-managed flag. Every
 * other event dispatches to APNs unconditionally. Cycle reminders are not
 * listed — that cron still resolves its own flag before dispatching.
 */
export const CLIENT_MANAGED_APNS_EVENTS: Record<string, ClientManagedGate> = {
  MEDICATION_REMINDER: {
    isClientManaged: isMedicationReminderClientManaged,
    metaKey: "medication_reminder_suppressed_client_managed",
    tag: (metadata) =>
      `${str(metadata?.medicationId)}:${str(metadata?.scheduledAt)}`,
    detailKey: "medication_reminder_suppressed_meta",
    detail: (userId, metadata) => ({
      user_id: userId,
      medication_id: str(metadata?.medicationId),
      schedule_id: str(metadata?.scheduleId),
      phase: str(metadata?.phase),
      dose_at: str(metadata?.scheduledAt),
    }),
    // The iOS client reminds once, at dose time, and sends no follow-ups of
    // its own (iOS #116, item 21). So the flag keeps only the reminder that
    // announces the dose off APNs; the escalations for a dose that is still
    // open (`followUp: true`, set by the reminder cron) are pushed as usual.
    // A dispatch that does not say is treated as the announcement, the
    // behaviour every reminder had before the cron started saying.
    covers: (metadata) => metadata?.followUp !== true,
    perDevice: true,
  },
  MEASUREMENT_REMINDER: {
    isClientManaged: isMeasurementReminderClientManaged,
    metaKey: "measurement_reminder.suppressed_client_managed",
    tag: (metadata) => str(metadata?.reminderId),
  },
};

/**
 * Does a client-managed opt-out apply to this dispatch at all? Cheap check
 * the dispatcher runs before paying for the preferences read: the event type
 * has to have the opt-out, and the opt-out has to cover this dispatch.
 */
export function hasClientManagedApnsGate(
  eventType: string,
  metadata?: Record<string, unknown>,
): boolean {
  const gate = CLIENT_MANAGED_APNS_EVENTS[eventType];
  if (!gate) return false;
  return gate.covers ? gate.covers(metadata) : true;
}

/**
 * Does this device deliver the reminder itself? Its own override decides;
 * without one (`null`, shown as "inherit") the account-wide flag does.
 */
export function deviceDeliversLocally(
  override: string | null,
  accountDeliversLocally: boolean,
): boolean {
  if (override === "client") return true;
  if (override === "server") return false;
  return accountDeliversLocally;
}

/**
 * Where the server's APNs push of a client-managed event goes.
 *
 *   `skip` — nothing is pushed over APNs: every device with a push token
 *   delivers the reminder itself (or, with no device, the account does).
 *   `send` — push, to `onlyDeviceIds` when set and to every device
 *   otherwise. `localDeviceIds` names the devices left out, for the wide
 *   event.
 *
 * An event without per-device overrides keeps the account-wide rule: skip
 * when the account delivers locally, send to every device otherwise.
 */
export type ApnsDeliveryTargets =
  | { kind: "skip" }
  | {
      kind: "send";
      onlyDeviceIds?: string[];
      localDeviceIds: string[];
    };

export async function resolveApnsDeliveryTargets(
  eventType: string,
  recipientUserId: string,
  accountDeliversLocally: boolean,
): Promise<ApnsDeliveryTargets> {
  const gate = CLIENT_MANAGED_APNS_EVENTS[eventType];
  if (!gate?.perDevice) {
    return accountDeliversLocally
      ? { kind: "skip" }
      : { kind: "send", localDeviceIds: [] };
  }
  const devices = await prisma.device.findMany({
    where: { userId: recipientUserId, apnsToken: { not: null } },
    select: { id: true, medicationDelivery: true },
  });
  // No device to decide for: the account's rule, exactly as before. The
  // sender then reports `apns_no_devices` when it is asked to send.
  if (devices.length === 0) {
    return accountDeliversLocally
      ? { kind: "skip" }
      : { kind: "send", localDeviceIds: [] };
  }
  const local: string[] = [];
  const server: string[] = [];
  for (const device of devices) {
    (deviceDeliversLocally(device.medicationDelivery, accountDeliversLocally)
      ? local
      : server
    ).push(device.id);
  }
  if (server.length === 0) return { kind: "skip" };
  return local.length === 0
    ? { kind: "send", localDeviceIds: [] }
    : { kind: "send", onlyDeviceIds: server, localDeviceIds: local };
}
