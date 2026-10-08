import { prisma } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { defaultLocale, locales, type Locale } from "@/lib/i18n/config";
import type {
  NotificationPayload,
  TelegramChannelConfig,
  NtfyChannelConfig,
  WebhookChannelConfig,
  EmailChannelConfig,
  ChannelType,
  EventType,
} from "@/lib/notifications/types";
import { EVENT_DEFAULT_ENABLED } from "@/lib/notifications/types";
import { sendViaTelegram } from "@/lib/notifications/senders/telegram";
import { sendViaNtfy } from "@/lib/notifications/senders/ntfy";
import { sendViaWebPush } from "@/lib/notifications/senders/web-push";
import { sendViaApns } from "@/lib/notifications/senders/apns";
import { sendViaWebhook } from "@/lib/notifications/senders/webhook";
import { sendViaEmail } from "@/lib/notifications/senders/email";
import type { SendOutcome } from "@/lib/notifications/retry-policy";
import {
  isChannelInCooldown,
  recordChannelHardReject,
  recordChannelSuccess,
  recordChannelTransientFailure,
} from "@/lib/notifications/channel-state";
import { getEvent } from "@/lib/logging/context";
import {
  getGlobalServiceAvailability,
  hasGlobalChannelSwitch,
  resolveChannelGloballyEnabled,
  type GlobalServiceAvailability,
} from "@/lib/app-settings";
import {
  CLIENT_MANAGED_APNS_EVENTS,
  hasClientManagedApnsGate,
} from "@/lib/notifications/client-managed-apns";
import { recordPushAttempt } from "@/lib/notifications/senders/push-attempt-record";
import {
  claimManagedGuardianEgressAuthorization,
  completeManagedGuardianEgressAuthorization,
  resolveManagedGuardianRecipientIds,
  resolveNotificationDeliveryIdentity,
} from "@/lib/notifications/delivery-identity";

/**
 * Dispatch a notification to all enabled channels for a user.
 * Best-effort: logs errors but never throws.
 *
 * For each channel:
 *  1. Skip if `enabled=false` (manually or auto-disabled).
 *  2. Check the per-channel preference for this eventType (default: enabled).
 *  3. Skip if the operator switched the channel off instance-wide.
 *  4. Skip if currently in retry-cooldown (`nextRetryAt > now`).
 *  5. Skip the APNs channel — and only that one — when the user's iOS
 *     client owns the local reminder for this event type.
 *  6. Call the appropriate sender — which now returns a `SendOutcome` so
 *     the dispatcher can classify hard rejects (410, blocked-by-user) vs
 *     soft errors (5xx, 429, network) and update channel state accordingly.
 *
 * Also handles legacy Telegram config stored on the User model by
 * auto-migrating it to a NotificationChannel record on first dispatch.
 */
export interface DispatchOutcome {
  /** True when at least one channel reported a successful delivery. */
  dispatched: boolean;
  /** Channels considered after enable / cooldown / preference filtering. */
  channelsAttempted: number;
  /** Subset of attempted channels that returned ok. */
  channelsSucceeded: number;
}

function isLocale(value: string | null | undefined): value is Locale {
  return (locales as readonly string[]).includes(value ?? "");
}

/** Render record-owned content only after the delivery recipient is known. */
async function renderForRecipient(
  payload: NotificationPayload,
  recipientUserId: string,
): Promise<NotificationPayload> {
  const { renderForRecipient: render, ...deliveryPayload } = payload;
  if (!render) return deliveryPayload;

  const recipient = await prisma.user.findUnique({
    where: { id: recipientUserId },
    select: { locale: true },
  });
  const locale = isLocale(recipient?.locale) ? recipient.locale : defaultLocale;
  return { ...deliveryPayload, ...render(locale) };
}

export async function dispatchNotification(
  payload: NotificationPayload,
): Promise<DispatchOutcome> {
  let channelsAttempted = 0;
  let channelsSucceeded = 0;

  try {
    const guardianRecipientIds =
      await resolveManagedGuardianRecipientIds(payload);
    if (guardianRecipientIds !== null) {
      const outcomes = await Promise.all(
        guardianRecipientIds.map((recipientUserId) =>
          dispatchNotification({
            ...payload,
            recordUserId: payload.userId,
            recipientUserId,
          }),
        ),
      );
      return outcomes.reduce<DispatchOutcome>(
        (aggregate, outcome) => ({
          dispatched: aggregate.dispatched || outcome.dispatched,
          channelsAttempted:
            aggregate.channelsAttempted + outcome.channelsAttempted,
          channelsSucceeded:
            aggregate.channelsSucceeded + outcome.channelsSucceeded,
        }),
        { dispatched: false, channelsAttempted: 0, channelsSucceeded: 0 },
      );
    }

    const delivery = await resolveNotificationDeliveryIdentity(payload);
    if (!delivery) {
      getEvent()?.addWarning("Notification delivery identity was invalid");
      return { dispatched: false, channelsAttempted, channelsSucceeded };
    }
    const deliveryPayload: NotificationPayload = {
      ...payload,
      recordUserId: delivery.recordUserId,
      recipientUserId: delivery.recipientUserId,
    };
    const recipientPayload = await renderForRecipient(
      deliveryPayload,
      delivery.recipientUserId,
    );
    const channels = await prisma.notificationChannel.findMany({
      where: { userId: delivery.recipientUserId, enabled: true },
      include: {
        preferences: {
          where: { eventType: recipientPayload.eventType },
        },
      },
    });

    // Check for legacy Telegram config on User model if no TELEGRAM channel exists
    const hasTelegramChannel = channels.some(
      (ch: { type: string }) => ch.type === "TELEGRAM",
    );
    if (!hasTelegramChannel) {
      try {
        const user = await prisma.user.findUnique({
          where: { id: delivery.recipientUserId },
          select: {
            telegramBotToken: true,
            telegramChatId: true,
            telegramEnabled: true,
          },
        });

        if (
          user?.telegramEnabled &&
          user.telegramBotToken &&
          user.telegramChatId
        ) {
          const botToken = decrypt(user.telegramBotToken);
          const channelConfig = encrypt(
            JSON.stringify({ botToken, chatId: user.telegramChatId }),
          );

          // Auto-migrate: create NotificationChannel record
          const created = await prisma.notificationChannel.upsert({
            where: {
              userId_type: {
                userId: delivery.recipientUserId,
                type: "TELEGRAM",
              },
            },
            create: {
              userId: delivery.recipientUserId,
              type: "TELEGRAM",
              enabled: true,
              config: channelConfig,
            },
            update: {
              enabled: true,
              config: channelConfig,
            },
            include: {
              preferences: {
                where: { eventType: recipientPayload.eventType },
              },
            },
          });

          channels.push(created);
          getEvent()?.addMeta(
            "telegram_legacy_migration",
            delivery.recipientUserId,
          );
        }
      } catch (err) {
        getEvent()?.addWarning(`Legacy Telegram migration failed: ${err}`);
      }
    }

    // Cascade order: APNs first (if the user paired an iPhone), then
    // Telegram, then ntfy, then Web Push as the universal fallback.
    // The order matters because each channel is best-effort — sorting
    // here keeps the payload-delivery sequence deterministic across
    // dispatches even when Postgres returns rows in physical order.
    channels.sort((a, b) => channelPriority(a.type) - channelPriority(b.type));

    const now = new Date();
    // v1.4.25 W16c — per-event default policy. Most events stay
    // opt-out (no row = enabled); PERSONAL_RECORD flips to opt-in
    // (no row = disabled) so the iOS backfill doesn't saturate the
    // lock-screen on first launch. The user enables it explicitly
    // from /settings/notifications once they've seen the badge a few
    // times and decided they want push.
    let defaultEnabled =
      EVENT_DEFAULT_ENABLED[recipientPayload.eventType as EventType] ?? true;

    // v1.7.0 — MOOD_REMINDER single source of truth = the visible card.
    // The event used to default OFF, layered on top of the per-user
    // `moodReminderEnabled` flag, so a user who flipped the card still
    // got nothing (no pref row → `!defaultEnabled` → continue). Collapse
    // the double opt-in: when the card is on, the event default is on, so
    // enabling the card alone delivers. A genuine explicit per-event
    // opt-out (a `NotificationPreference` row with `enabled = false`) is
    // still honoured below via `pref.enabled` — only the no-row default
    // is derived from the card.
    if (recipientPayload.eventType === "MOOD_REMINDER") {
      const user = await prisma.user.findUnique({
        where: { id: delivery.recipientUserId },
        select: { moodReminderEnabled: true },
      });
      defaultEnabled = user?.moodReminderEnabled === true;
    }
    // Operator kill switches for the three channels that carry one, read at
    // most once per dispatch and only when such a channel is actually in the
    // cascade — a cascade of APNs + webhook + email pays nothing for it.
    let globalAvailability: GlobalServiceAvailability | null = null;
    const resolveGlobalAvailability =
      async (): Promise<GlobalServiceAvailability> => {
        globalAvailability ??= await getGlobalServiceAvailability();
        return globalAvailability;
      };

    // Client-managed APNs suppression, resolved at most once per dispatch
    // and only when an APNs channel is actually in the cascade. `null`
    // means "not applicable"; the read is lazy so the common event types
    // pay nothing for it.
    let clientManagedApns: boolean | null = null;
    const resolveClientManagedApns = async (): Promise<boolean> => {
      if (clientManagedApns !== null) return clientManagedApns;
      const gate = CLIENT_MANAGED_APNS_EVENTS[recipientPayload.eventType];
      if (!gate) {
        clientManagedApns = false;
        return false;
      }
      const row = await prisma.user.findUnique({
        where: { id: delivery.recipientUserId },
        select: { notificationPrefs: true },
      });
      clientManagedApns = gate.isClientManaged(row?.notificationPrefs);
      return clientManagedApns;
    };

    for (const channel of channels) {
      const pref = channel.preferences[0];
      if (pref) {
        if (!pref.enabled) continue;
      } else if (!defaultEnabled) {
        continue;
      }

      // The operator's instance-wide switch for this channel
      // (`AppSettings.{telegram,ntfy,webPush}Global`). It sits above every
      // per-user setting: a channel switched off here delivers nothing, no
      // matter what the account has configured. Not counted as an attempt —
      // nothing was sent — but the ledger carries a `globally_disabled` row
      // so the operator reads a reason instead of inferring silence.
      const globalSwitch = hasGlobalChannelSwitch(channel.type)
        ? channel.type
        : null;
      if (
        globalSwitch &&
        !resolveChannelGloballyEnabled(
          await resolveGlobalAvailability(),
          globalSwitch,
        )
      ) {
        getEvent()?.addMeta(
          `notification_skip_${globalSwitch.toLowerCase()}_globally_disabled`,
          recipientPayload.eventType,
        );
        recordPushAttempt({
          recordUserId: delivery.recordUserId,
          recipientUserId: delivery.recipientUserId,
          channel: globalSwitch,
          eventType: recipientPayload.eventType,
          result: "skipped",
          reason: "globally_disabled",
        });
        continue;
      }

      // Backoff cooldown — skip the channel until `nextRetryAt`. Without
      // this guard, a flapping upstream would burn API quota every
      // reminder-tick (every 60s by default), defeating the whole point
      // of the exponential backoff.
      if (isChannelInCooldown({ nextRetryAt: channel.nextRetryAt }, now)) {
        getEvent()?.addMeta(
          `notification_skip_${channel.type.toLowerCase()}_cooldown`,
          channel.nextRetryAt?.toISOString() ?? "unknown",
        );
        continue;
      }

      // The iOS client owns the local banner for this event type — skip
      // the server's APNs send and nothing else. Not counted as an
      // attempt: no send was made, so `dispatched` keeps telling the truth
      // about whether anything actually reached the user.
      if (
        channel.type === "APNS" &&
        !delivery.managed &&
        hasClientManagedApnsGate(
          recipientPayload.eventType,
          recipientPayload.metadata,
        ) &&
        (await resolveClientManagedApns())
      ) {
        const gate = CLIENT_MANAGED_APNS_EVENTS[recipientPayload.eventType];
        getEvent()?.addMeta(gate.metaKey, gate.tag(recipientPayload.metadata));
        if (gate.detail && gate.detailKey) {
          getEvent()?.addMeta(
            gate.detailKey,
            gate.detail(recipientPayload.userId, recipientPayload.metadata),
          );
        }
        recordPushAttempt({
          recordUserId: delivery.recordUserId,
          recipientUserId: delivery.recipientUserId,
          channel: "APNS",
          eventType: recipientPayload.eventType,
          result: "skipped",
          reason: "client_managed",
        });
        continue;
      }

      try {
        const prepared = prepareChannelSend(
          channel.type as ChannelType,
          channel.config,
          delivery.recipientUserId,
          recipientPayload,
        );
        let outcome: SendOutcome;
        if ("outcome" in prepared) {
          outcome = prepared.outcome;
          channelsAttempted += 1;
        } else {
          const authorization = delivery.managed
            ? await claimManagedGuardianEgressAuthorization(
                delivery,
                channel.type as ChannelType,
                recipientPayload.eventType,
              )
            : null;
          if (delivery.managed && authorization === null) {
            getEvent()?.addWarning(
              "Guardian notification authorization changed before channel egress",
            );
            continue;
          }

          channelsAttempted += 1;
          try {
            outcome = await prepared.send();
          } catch (err) {
            if (authorization) {
              await completeManagedGuardianEgressAuthorization(
                authorization.id,
                "sender_threw",
              );
            }
            throw err;
          }
          if (authorization) {
            await completeManagedGuardianEgressAuthorization(
              authorization.id,
              outcome.ok
                ? "ok"
                : outcome.hardReject
                  ? "hard_reject"
                  : "transient_failure",
            );
          }
        }
        if (outcome.ok) {
          await recordChannelSuccess({
            id: channel.id,
            userId: channel.userId,
            type: channel.type as ChannelType,
          });
          channelsSucceeded += 1;
          continue;
        }

        if (outcome.hardReject) {
          await recordChannelHardReject(
            {
              id: channel.id,
              userId: channel.userId,
              type: channel.type as ChannelType,
            },
            outcome,
          );
          getEvent()?.addWarning(
            `Notification channel ${channel.type} auto-disabled: ${outcome.reason}`,
          );
          continue;
        }

        const result = await recordChannelTransientFailure(
          {
            id: channel.id,
            userId: channel.userId,
            type: channel.type as ChannelType,
          },
          outcome,
          now,
        );
        getEvent()?.addWarning(
          `Notification dispatch failed for channel ${channel.type}: ${outcome.reason}` +
            (result.autoDisabled ? " (auto-disabled after 5 failures)" : ""),
        );
      } catch (err) {
        // Sender threw unexpectedly — treat as a soft failure so the
        // backoff schedule absorbs the blip. (Senders are supposed to
        // be no-throw, this is defence-in-depth.)
        const message = err instanceof Error ? err.message : String(err);
        await recordChannelTransientFailure(
          {
            id: channel.id,
            userId: channel.userId,
            type: channel.type as ChannelType,
          },
          { reason: "sender_threw", message },
          now,
        );
        getEvent()?.addWarning(
          `Notification sender threw for ${channel.type}: ${message}`,
        );
      }
    }
  } catch (err) {
    getEvent()?.addWarning(`Notification dispatcher error: ${err}`);
  }

  return {
    dispatched: channelsSucceeded > 0,
    channelsAttempted,
    channelsSucceeded,
  };
}

type PreparedChannelSend =
  { send: () => Promise<SendOutcome> } | { outcome: SendOutcome };

/**
 * Decrypt and validate a recipient-owned channel before the final managed
 * Guardian authorization claim. The returned closure is the only code that
 * can begin provider I/O, and is invoked immediately after that claim commits.
 */
function prepareChannelSend(
  type: ChannelType,
  encryptedConfig: string,
  recipientUserId: string,
  payload: NotificationPayload,
): PreparedChannelSend {
  let decrypted: string;
  try {
    decrypted = decrypt(encryptedConfig);
  } catch {
    getEvent()?.addWarning(`Failed to decrypt ${type} channel config`);
    // A config that can't be decrypted is a structurally-permanent failure,
    // not a transient blip: the ciphertext / key pairing won't fix itself on
    // a retry. Hard-reject so the channel auto-disables on first occurrence
    // with an accurate reason, rather than burning the 5-failure transient
    // budget and ending on the misleading `give_up_after_5_failures`. During
    // a key-rotation gap every channel would otherwise auto-disable for the
    // wrong reason.
    return {
      outcome: {
        ok: false,
        hardReject: true,
        reason: `${type.toLowerCase()}_config_decrypt_failed`,
      },
    };
  }

  switch (type) {
    case "TELEGRAM": {
      let config: TelegramChannelConfig;
      try {
        config = JSON.parse(decrypted) as TelegramChannelConfig;
      } catch {
        getEvent()?.addWarning("Failed to parse Telegram channel config");
        // Malformed config decodes the same on every retry — permanent.
        return {
          outcome: {
            ok: false,
            hardReject: true,
            reason: "telegram_config_parse_failed",
          },
        };
      }
      return { send: () => sendViaTelegram(config, payload) };
    }
    case "NTFY": {
      let config: NtfyChannelConfig;
      try {
        config = JSON.parse(decrypted) as NtfyChannelConfig;
      } catch {
        getEvent()?.addWarning("Failed to parse ntfy channel config");
        // Malformed config decodes the same on every retry — permanent.
        return {
          outcome: {
            ok: false,
            hardReject: true,
            reason: "ntfy_config_parse_failed",
          },
        };
      }
      return { send: () => sendViaNtfy(config, payload) };
    }
    case "WEBHOOK": {
      let config: WebhookChannelConfig;
      try {
        config = JSON.parse(decrypted) as WebhookChannelConfig;
      } catch {
        getEvent()?.addWarning("Failed to parse webhook channel config");
        // Malformed config decodes the same on every retry — permanent.
        return {
          outcome: {
            ok: false,
            hardReject: true,
            reason: "webhook_config_parse_failed",
          },
        };
      }
      return { send: () => sendViaWebhook(config, payload) };
    }
    case "EMAIL": {
      let config: EmailChannelConfig;
      try {
        config = JSON.parse(decrypted) as EmailChannelConfig;
      } catch {
        getEvent()?.addWarning("Failed to parse email channel config");
        // Malformed config decodes the same on every retry — permanent.
        return {
          outcome: {
            ok: false,
            hardReject: true,
            reason: "email_config_parse_failed",
          },
        };
      }
      return { send: () => sendViaEmail(config, payload) };
    }
    case "WEB_PUSH": {
      return { send: () => sendViaWebPush(recipientUserId, payload) };
    }
    case "APNS": {
      // APNs config lives on the Device row, not in the channel config.
      // The decrypt above is a no-op (config is the empty object `{}`),
      // we just keep the symmetric path so future per-user overrides
      // (e.g. a custom APNs topic) can hang off the channel without
      // changing the dispatcher shape.
      return { send: () => sendViaApns(recipientUserId, payload) };
    }
    default:
      getEvent()?.addWarning(`Unknown notification channel type: ${type}`);
      return {
        outcome: {
          ok: false,
          hardReject: false,
          reason: "unknown_channel_type",
        },
      };
  }
}

/**
 * Static cascade order: APNs first, Web Push last. Lower number = earlier.
 * The order is deliberate:
 *  - APNs   — native iOS path; best UX when the user has an iPhone.
 *  - Telegram — explicit user-set chat; high deliverability.
 *  - ntfy   — self-hosted-friendly; user controls the relay.
 *  - WebPush — broadest reach, slowest UX (browser must be alive).
 *
 * Unknown channel types sort last so they never preempt a real channel.
 */
function channelPriority(type: string): number {
  switch (type) {
    case "APNS":
      return 0;
    case "TELEGRAM":
      return 1;
    case "NTFY":
      return 2;
    // v1.17.1 — generic webhook + email sit between the self-host-friendly
    // relays and Web Push: a user who configures them wants them ahead of the
    // browser-must-be-alive fallback.
    case "WEBHOOK":
      return 3;
    case "EMAIL":
      return 4;
    case "WEB_PUSH":
      return 5;
    default:
      return 99;
  }
}
