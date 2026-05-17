/**
 * Notification system type definitions.
 * Channels: Telegram, ntfy, Web Push
 * Events: medication reminders, anomalies, compliance, etc.
 */

export const CHANNEL_TYPES = ["TELEGRAM", "NTFY", "WEB_PUSH", "APNS"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const EVENT_TYPES = [
  "MEDICATION_REMINDER",
  "MEASUREMENT_ANOMALY",
  "COMPLIANCE_LOW",
  "WITHINGS_SYNC_FAILED",
  "SYSTEM_ALERT",
  // v1.4.25 W16c — PR detection. Default OFF (see DEFAULT_EVENT_PREFS
  // below) so a multi-year Apple Health backfill doesn't fire hundreds
  // of pushes during initial sync.
  "PERSONAL_RECORD",
  // v0.5.4 ios-coord — daily mood-reminder nudge. Default OFF on the
  // per-event policy (see DEFAULT_EVENT_PREFS) and additionally gated
  // on the per-user `moodReminderEnabled` flag, so a user has to opt
  // in twice before the server starts nudging them about an
  // emotionally-loaded surface.
  "MOOD_REMINDER",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Per-event default policy when no `NotificationPreference` row
 * exists. The dispatcher reads this to decide whether to fire on a
 * channel that has never been explicitly toggled for the event.
 *
 * Every event defaults to ON (the original opt-out model) EXCEPT
 * `PERSONAL_RECORD`: PRs are silent by default and require the user
 * to explicitly enable them in `/settings/notifications`. Rationale —
 * a fresh iOS install backfilling years of HealthKit history would
 * otherwise saturate the user's lock-screen on first launch.
 */
export const EVENT_DEFAULT_ENABLED: Record<EventType, boolean> = {
  MEDICATION_REMINDER: true,
  MEASUREMENT_ANOMALY: true,
  COMPLIANCE_LOW: true,
  WITHINGS_SYNC_FAILED: true,
  SYSTEM_ALERT: true,
  PERSONAL_RECORD: false,
  // v0.5.4 ios-coord — see note above on `EVENT_TYPES`. Default OFF
  // is the safer posture: even if a future surface forgets to gate on
  // `User.moodReminderEnabled`, this per-event default also has to be
  // flipped on before the dispatcher will surface the channel.
  MOOD_REMINDER: false,
};

export const CHANNEL_TYPE_LABELS: Record<ChannelType, string> = {
  TELEGRAM: "Telegram",
  NTFY: "ntfy",
  WEB_PUSH: "Web Push",
  APNS: "Apple Push (APNs)",
};

// ── Channel config shapes (stored as encrypted JSON) ──

export interface TelegramChannelConfig {
  botToken: string;
  chatId: string;
}

export interface NtfyChannelConfig {
  serverUrl: string;
  topic: string;
  authToken?: string;
}

export type WebPushChannelConfig = Record<string, never>;

/**
 * APNs channel config is empty by design — the per-device APNs token +
 * environment live on the `Device` model, not on the channel row. The
 * channel row exists so per-event preference toggles in
 * `NotificationPreference` apply uniformly across all four channels.
 */
export type ApnsChannelConfig = Record<string, never>;

export type ChannelConfig =
  | TelegramChannelConfig
  | NtfyChannelConfig
  | WebPushChannelConfig
  | ApnsChannelConfig;

// ── Notification payload ──

export interface NotificationPayload {
  eventType: EventType;
  userId: string;
  title: string;
  message: string;
  /** Channel-specific extras (e.g. medicationId for Telegram inline buttons) */
  metadata?: Record<string, unknown>;
}
