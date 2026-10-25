import type { Locale } from "@/lib/i18n/config";
import type { NotificationQuickAction } from "@/lib/notifications/action-token";

/**
 * Notification system type definitions.
 * Channels: Telegram, ntfy, Web Push
 * Events: medication reminders, anomalies, compliance, etc.
 */

export const CHANNEL_TYPES = [
  "TELEGRAM",
  "NTFY",
  "WEB_PUSH",
  "APNS",
  // v1.17.1 — generic outbound webhook. The user supplies a public URL and an
  // optional shared secret/header; the dispatcher POSTs a small JSON payload
  // ({ title, message, eventType, ... }) through `safeFetch` with
  // `requirePublicHost: true`, exactly like ntfy. One channel covers Gotify,
  // Discord, Slack, Matrix (via a bridge), Home Assistant, and any homelab
  // relay that accepts an inbound JSON POST.
  "WEBHOOK",
  // v1.17.1 — SMTP / email. Alerts + reminders over email — the channel every
  // self-hoster already has. The SMTP transport is OPERATOR-configured via
  // `SMTP_*` env (absent → channel never offered, like APNs today); the
  // per-user config carries only the recipient address. Bodies stay plain text
  // (no markdown library — hard rule).
  "EMAIL",
] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const EVENT_TYPES = [
  "MEDICATION_REMINDER",
  "MEASUREMENT_ANOMALY",
  "COMPLIANCE_LOW",
  "WITHINGS_SYNC_FAILED",
  "SYSTEM_ALERT",
  // v1.4.25 — PR detection. Default OFF (see DEFAULT_EVENT_PREFS
  // below) so a multi-year Apple Health backfill doesn't fire hundreds
  // of pushes during initial sync.
  "PERSONAL_RECORD",
  // v0.5.4 ios-coord — daily mood-reminder nudge. Default OFF on the
  // per-event policy (see DEFAULT_EVENT_PREFS) and additionally gated
  // on the per-user `moodReminderEnabled` flag, so a user has to opt
  // in twice before the server starts nudging them about an
  // emotionally-loaded surface.
  "MOOD_REMINDER",
  // v1.15 — cycle reminders. Both default OFF (see EVENT_DEFAULT_ENABLED)
  // and are gated again on `CycleProfile.cycleTrackingEnabled`, so a user
  // opts in twice before the server nudges about an intent-revealing,
  // privacy-sensitive surface. `CYCLE_PERIOD_SOON` fires a couple of days
  // before the predicted next-period start; `CYCLE_PERIOD_CONFIRM` is a
  // gentle "did your period start?" on/after the predicted start while no
  // period is logged. When `CycleProfile.discreetNotifications` is true the
  // push body is the generic "HealthLog reminder" so no cycle event is
  // named on the lock screen.
  "CYCLE_PERIOD_SOON",
  "CYCLE_PERIOD_CONFIRM",
  // v1.15.1 — fertile-window reminder. Default OFF (see EVENT_DEFAULT_ENABLED)
  // and TTC-gated in the cron: it only fires when `CycleProfile.goal ===
  // "TRYING_TO_CONCEIVE"`, so fertile language never reaches the
  // AVOID_PREGNANCY / GENERAL_HEALTH / PERIMENOPAUSE goals (the inclusive-
  // framing rule). Fires a few days before `CyclePrediction.fertileWindowStart`
  // and honours discreet mode like the other cycle reminders.
  "CYCLE_FERTILE_SOON",
  // v1.15.20 — proactive Coach nudge. Fired by the 05:15 Europe/Berlin
  // cron when a deterministic trigger (7-day compliance < 60 %, BP
  // weekly mean above target, sharply falling recovery score) warrants
  // pointing the user at /coach. Capped at one nudge per user
  // per rolling week via the `push_attempts` ledger; per-user opt-out
  // lives in `notificationPrefs.coach.nudgesEnabled`.
  "COACH_NUDGE",
  // v1.16.11 — medication low-stock alert. Fired by the daily
  // medication-low-stock cron when a medication with tracked inventory
  // projects fewer remaining-supply days than the user's per-user
  // runway threshold (default 7 days, OFF possible). One notification
  // per threshold crossing; the stamp on the medication row re-arms on
  // refill or threshold change. ON at the channel layer — the real
  // gate is the per-user threshold in `notificationPrefs.medication`.
  "MEDICATION_LOW_STOCK",
  // v1.17.1 — Vorsorge (measurement / preventive-care) reminder. Fired by
  // the every-15-min measurement-reminder cron when a user-created
  // reminder ("measure BP every 7 days", "annual blood panel") is due
  // inside the user's local notify-hour window. ON by default at the
  // channel layer (see EVENT_DEFAULT_ENABLED): these are reminders the
  // user explicitly created, so silence-by-default would be surprising.
  // The real gate is the per-reminder `enabled` flag plus the per-user
  // `notificationPrefs.measurementReminder.clientManaged` suppression.
  // NOT time-sensitive — a Vorsorge nudge is not a Focus-bypass case.
  "MEASUREMENT_REMINDER",
  // v1.17.1 (#22) — silent medication-intake cross-device sync. Fired on a
  // medication-intake mutation (single + bulk) to the user's OTHER iOS
  // devices so a Live Activity / Home-Screen widget reconciles after a dose
  // is logged on one device. APNs-ONLY by construction: it is a silent
  // `apns-push-type: background` push (content-available, no alert) and has
  // no Telegram / ntfy / Web Push semantics, so it never fans out to those
  // channels (the dispatcher would have nothing meaningful to deliver and a
  // user-visible Telegram message on every dose would be noise). Routed
  // through the dedicated intake-sync sender, not the alert cascade.
  "MEDICATION_INTAKE_SYNC",
  // v1.23 — account-security alert (new-device / new-location sign-in). Fired
  // by the login completion path on the first sighting of a coarse device
  // fingerprint. ON by default at the channel layer: a sign-in the user did
  // not make is exactly the case they need to hear about, so silence-by-default
  // would defeat the feature. An explicit per-channel `NotificationPreference`
  // row still wins for a user who opts out.
  "SECURITY_ALERT",
  // The once-daily calm morning briefing. Default OFF (see
  // EVENT_DEFAULT_ENABLED, the PERSONAL_RECORD precedent): the user opts in
  // per-channel from the /notifications matrix, so the channel choice is
  // explicit at opt-in. It reads the CACHED daily digest — never a fresh AI
  // call — and carries a minimal, non-clinical line (cached briefing lead with
  // a deterministic floor). It is a nudge, NEVER the anomaly channel: it is
  // dispatched non-urgent, fired at most once per user per local day (the
  // `push_attempts` ledger is the frequency anchor), and only inside a local
  // morning window, so a concerning reading always stays on
  // `MEASUREMENT_ANOMALY` and this never bypasses Focus.
  "DAILY_BRIEFING",
  // v1.36.x — somebody with a write grant on this record marked one of the
  // owner's doses. The only notification a delegated write produces: every
  // other shared-record write is bookkeeping and stays in the owner's activity
  // view, while "somebody said I took my tablets" is a fact about the owner's
  // own body that they should not have to go looking for. Addressed to the
  // OWNER — the delegate learns what they did from the response in their own
  // session, not from a push (there is no channel that could carry it: the
  // dispatcher addresses a userId, and under record substitution that userId
  // is the owner by design). Default ON, see EVENT_DEFAULT_ENABLED.
  "SHARED_RECORD_INTAKE",
  // Recovery readiness, for admins only: a backup signal turned to
  // attention or failing, is still failing a day later, or is back to normal
  // (`src/lib/recovery/readiness-notify.ts`). Default ON: the whole point is
  // that a stopped backup is pushed rather than found on a page weeks later.
  // An admin routes it per channel in the /notifications matrix, where only
  // admins see the row (`eventTypesForRole`).
  "BACKUP_HEALTH",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * The closed set of managed-record events that may reach Guardians. A
 * `SYSTEM_ALERT` needs the explicit safety-floor discriminator because
 * illness red flags use the same broad delivery event but do not fan out.
 */
export const MANAGED_GUARDIAN_FANOUT_EVENTS = [
  "MEDICATION_REMINDER",
  "MEASUREMENT_REMINDER",
  "MEDICATION_LOW_STOCK",
  "SAFETY_FLOOR_ALERT",
] as const;
export type ManagedGuardianFanoutEvent =
  (typeof MANAGED_GUARDIAN_FANOUT_EVENTS)[number];

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
  // v1.15 — cycle reminders default OFF. Even if a future surface forgets
  // to gate on `CycleProfile.cycleTrackingEnabled`, this per-event default
  // also has to be flipped on before the dispatcher surfaces the channel.
  CYCLE_PERIOD_SOON: false,
  CYCLE_PERIOD_CONFIRM: false,
  // v1.15.20 — ON at the channel layer; the real gate is the per-user
  // `notificationPrefs.coach.nudgesEnabled` opt-out the cron reads
  // (plus the disableCoach / kill-switch / provider gates). An explicit
  // per-channel `NotificationPreference` row still wins.
  COACH_NUDGE: true,
  // v1.15.1 — default OFF and additionally TTC-gated in the cron, so the
  // server never surfaces fertile-window language unless the user has both
  // chosen the conception goal and opted the reminder in.
  CYCLE_FERTILE_SOON: false,
  // v1.16.11 — ON at the channel layer; the per-user runway threshold
  // (`notificationPrefs.medication.lowStockRunwayDays`, OFF-able) is the
  // real gate, and the once-per-crossing stamp keeps the volume at one
  // push per medication per crossing. An explicit per-channel
  // `NotificationPreference` row still wins.
  MEDICATION_LOW_STOCK: true,
  // v1.17.1 — ON at the channel layer; the real gates are the per-reminder
  // `enabled` flag and the per-user `measurementReminder.clientManaged`
  // suppression the cron reads. An explicit per-channel
  // `NotificationPreference` row still wins.
  MEASUREMENT_REMINDER: true,
  // v1.17.1 (#22) — ON at the channel layer; an explicit per-channel
  // `NotificationPreference` row (APNS, eventType MEDICATION_INTAKE_SYNC,
  // enabled=false) still suppresses it. There is no second user-facing
  // toggle: this is plumbing that keeps the user's own devices coherent,
  // not a notification the user chooses to receive.
  MEDICATION_INTAKE_SYNC: true,
  // v1.23 — ON by default; a new-device sign-in is a security event the user
  // needs surfaced. An explicit per-channel `NotificationPreference` row
  // (enabled=false) still suppresses it for a user who opts out.
  SECURITY_ALERT: true,
  // OFF by default (the PERSONAL_RECORD precedent). The calm daily
  // briefing stays silent until the user explicitly opts in per-channel at
  // /notifications; the dispatcher's default-policy gate suppresses every
  // channel that has no explicit enabled row, so a fresh account never
  // receives a morning push it did not ask for.
  DAILY_BRIEFING: false,
  // v1.36.x — ON by default, deliberately against the PERSONAL_RECORD opt-in
  // precedent. The event cannot exist unless the owner invited a second person
  // and gave them write access, so there is no backfill class of volume to
  // protect against; and an owner who has to discover a setting before they
  // learn that somebody else marks their doses was never told at all. The row
  // sits in the /notifications matrix from day one, so an owner who finds it
  // noisy silences it per channel with one switch.
  SHARED_RECORD_INTAKE: true,
  // ON by default; see the note on `EVENT_TYPES`. Only admins are ever
  // addressed, and at most once per state change per signal.
  BACKUP_HEALTH: true,
};

/** Event types only an admin is ever sent, and only an admin is shown. */
export const ADMIN_ONLY_EVENT_TYPES: readonly EventType[] = ["BACKUP_HEALTH"];

/** The event types a person with `role` can receive, in matrix order. */
export function eventTypesForRole(role: string): EventType[] {
  return role === "ADMIN"
    ? [...EVENT_TYPES]
    : EVENT_TYPES.filter((type) => !ADMIN_ONLY_EVENT_TYPES.includes(type));
}

export const CHANNEL_TYPE_LABELS: Record<ChannelType, string> = {
  TELEGRAM: "Telegram",
  NTFY: "ntfy",
  WEB_PUSH: "Web Push",
  APNS: "Apple Push (APNs)",
  WEBHOOK: "Webhook",
  EMAIL: "Email",
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

/**
 * The body shapes the generic webhook can send.
 *
 *  - `generic`: HealthLog's own JSON envelope (`title`, `message`,
 *    `eventType`, `priority` as a word), for Home Assistant, n8n, a Discord
 *    or Slack relay, or anything that reads arbitrary JSON.
 *  - `gotify`: the body Gotify's `POST /message` binds, with `priority` as
 *    the integer Gotify types it as. The generic body is refused there with
 *    a 400.
 */
export const WEBHOOK_PAYLOAD_FORMATS = ["generic", "gotify"] as const;
export type WebhookPayloadFormat = (typeof WEBHOOK_PAYLOAD_FORMATS)[number];

/**
 * Generic-webhook channel config (v1.17.1). The user supplies a URL and an
 * OPTIONAL custom header (Gotify accepts its app token as `X-Gotify-Key`, or
 * as a `token` query parameter on the URL; a Discord or Slack incoming-webhook
 * URL needs no header). The dispatcher POSTs a JSON body — see
 * `sendViaWebhook` — through `safeFetch` with the connect-time pin, so the
 * SSRF floor and the DNS-rebinding defence apply to the user-supplied host
 * exactly as they do for ntfy.
 */
export interface WebhookChannelConfig {
  url: string;
  /** Optional header name to attach (e.g. "Authorization"). */
  headerName?: string;
  /** Optional header value (e.g. "Bearer <token>"). Encrypted at rest. */
  headerValue?: string;
  /**
   * Body shape. Absent means `generic`, which is every config saved before
   * the choice existed; only `gotify` is written to the stored config.
   */
  format?: WebhookPayloadFormat;
}

/**
 * Email channel config (v1.17.1). The SMTP TRANSPORT (host/port/auth/from) is
 * operator-supplied via `SMTP_*` env and loaded in `email-config.ts`; the only
 * per-user value is the recipient address. Splitting it this way keeps SMTP
 * credentials out of every user's encrypted channel blob — they live once in
 * the operator's env, exactly like the APNs key.
 */
export interface EmailChannelConfig {
  recipient: string;
}

// ── Notification payload ──

export interface NotificationPayload {
  eventType: EventType;
  /**
   * Health-record subject retained for established self-delivery callers.
   * Managed delivery must also declare `recordUserId` and `recipientUserId`.
   */
  userId: string;
  /** The health record that supplies notification content and calculations. */
  recordUserId?: string;
  /** The account whose channel, locale, and preferences receive the delivery. */
  recipientUserId?: string;
  title: string;
  message: string;
  /** Channel-specific extras (e.g. medicationId for Telegram inline buttons) */
  metadata?: Record<string, unknown>;
  /**
   * Internal admission marker for managed-record delivery. It is deliberately
   * absent from public request contracts: only the four allowlisted producer
   * paths may set it, and safety-floor is the only SYSTEM_ALERT admission.
   */
  managedFanoutEvent?: ManagedGuardianFanoutEvent;
  /**
   * Internal rendering hook for record-owned notification content. The
   * dispatcher invokes it only after choosing a recipient, then removes it
   * before handing the payload to a channel adapter.
   */
  renderForRecipient?: (locale: Locale) => {
    title: string;
    message: string;
  };
  /**
   * Discreet mode (cycle privacy). When true, the lock-screen-visible
   * routing metadata the senders would otherwise derive from `eventType`
   * (APNs category / threadId / collapseId, ntfy Tags) is replaced with a
   * generic value so the cycle event name never appears on the lock screen
   * — the title/body are already masked upstream.
   */
  discreet?: boolean;
  /**
   * Urgent / escalation dimension (v1.18.4). When true, EVERY configured
   * channel delivers at the HIGHEST urgency it supports — never assuming
   * APNs is one of them (most self-hosters have no Apple Developer account):
   *  - APNs    → interruption-level `time-sensitive` + priority 10 (and
   *    `critical` only when `APNS_CRITICAL_ENTITLEMENT=true`, since the
   *    critical flag needs an Apple-approved entitlement; time-sensitive
   *    does not).
   *  - ntfy    → `Priority: 5` (max) + an `urgent` tag.
   *  - WebPush → `Urgency: high` header + `requireInteraction`.
   *  - Webhook → `priority: "urgent"` in the generic body, `10` in Gotify's.
   *  - Telegram → normal delivery (no urgency tier exists; never silent).
   * Normal events leave `urgent` unset and behave exactly as before.
   */
  urgent?: boolean;
  /**
   * The nudge carries no completion affordance.
   *
   * A reminder push normally ships a Done / Later pair — the Telegram inline
   * keyboard and the APNs category whose actions the iOS app registers. Both
   * resolve the reminder by id and both are refused for an appointment: an
   * appointment reminder belongs to a visit, is managed through the visit
   * routes, and every by-id reminder surface answers "not found" for one. An
   * offered button the server will refuse is worse than no button, so the
   * producer that knows the origin says so here and each channel drops its own
   * affordance rather than each channel re-deriving the rule.
   *
   * The reminder's id still rides `metadata` — it identifies the dispatch for
   * the client-managed suppression tag and the wide event; what this flag
   * removes is the OFFER to act on it.
   */
  suppressActions?: boolean;
  /**
   * Where tapping the notification leads, resolved once per delivery by the
   * dispatcher from `NOTIFICATION_TAP_PATHS` (`tap-target.ts`). Producers
   * never set it; a producer that knows a more precise path says so in
   * `metadata.url`. `path` is a same-origin path (Web Push, APNs), `url` the
   * same target as an absolute URL on the operator's public origin (ntfy,
   * Telegram, webhook, email), `null` when no public origin is configured.
   * `label` is the localised text of a link button.
   */
  tap?: NotificationTap;
  /**
   * One-tap answers the channel can offer inside the notification (ntfy
   * `http` actions). Minted by the dispatcher for a self-delivered mood
   * reminder; each URL carries a signed single-use token
   * (`action-token.ts`).
   */
  quickActions?: NotificationQuickAction[];
}

export interface NotificationTap {
  path: string | null;
  url: string | null;
  label: string;
}

/**
 * Whether a payload should escalate to each channel's highest urgency.
 * Explicit `urgent: true` is the modern signal. `MEDICATION_REMINDER`
 * stays escalated for backward compatibility (it has shipped as APNs
 * time-sensitive / ntfy high since v1.4.40), so callers that don't set
 * the flag keep their existing behaviour.
 */
export function isUrgentPayload(payload: {
  urgent?: boolean;
  eventType: string;
}): boolean {
  return payload.urgent === true || payload.eventType === "MEDICATION_REMINDER";
}
