import { prisma } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import type {
  NotificationPayload,
  TelegramChannelConfig,
  NtfyChannelConfig,
  ChannelType,
  EventType,
} from "@/lib/notifications/types";
import { EVENT_DEFAULT_ENABLED } from "@/lib/notifications/types";
import { sendViaTelegram } from "@/lib/notifications/senders/telegram";
import { sendViaNtfy } from "@/lib/notifications/senders/ntfy";
import { sendViaWebPush } from "@/lib/notifications/senders/web-push";
import { sendViaApns } from "@/lib/notifications/senders/apns";
import type { SendOutcome } from "@/lib/notifications/retry-policy";
import {
  isChannelInCooldown,
  recordChannelHardReject,
  recordChannelSuccess,
  recordChannelTransientFailure,
} from "@/lib/notifications/channel-state";
import { getEvent } from "@/lib/logging/context";

/**
 * Dispatch a notification to all enabled channels for a user.
 * Best-effort: logs errors but never throws.
 *
 * For each channel:
 *  1. Skip if `enabled=false` (manually or auto-disabled).
 *  2. Skip if currently in retry-cooldown (`nextRetryAt > now`).
 *  3. Check the per-channel preference for this eventType (default: enabled).
 *  4. Call the appropriate sender — which now returns a `SendOutcome` so
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

export async function dispatchNotification(
  payload: NotificationPayload,
): Promise<DispatchOutcome> {
  let channelsAttempted = 0;
  let channelsSucceeded = 0;

  try {
    const channels = await prisma.notificationChannel.findMany({
      where: { userId: payload.userId, enabled: true },
      include: {
        preferences: {
          where: { eventType: payload.eventType },
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
          where: { id: payload.userId },
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
                userId: payload.userId,
                type: "TELEGRAM",
              },
            },
            create: {
              userId: payload.userId,
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
                where: { eventType: payload.eventType },
              },
            },
          });

          channels.push(created);
          getEvent()?.addMeta("telegram_legacy_migration", payload.userId);
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
      EVENT_DEFAULT_ENABLED[payload.eventType as EventType] ?? true;

    // v1.7.0 — MOOD_REMINDER single source of truth = the visible card.
    // The event used to default OFF, layered on top of the per-user
    // `moodReminderEnabled` flag, so a user who flipped the card still
    // got nothing (no pref row → `!defaultEnabled` → continue). Collapse
    // the double opt-in: when the card is on, the event default is on, so
    // enabling the card alone delivers. A genuine explicit per-event
    // opt-out (a `NotificationPreference` row with `enabled = false`) is
    // still honoured below via `pref.enabled` — only the no-row default
    // is derived from the card.
    if (payload.eventType === "MOOD_REMINDER") {
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: { moodReminderEnabled: true },
      });
      defaultEnabled = user?.moodReminderEnabled === true;
    }
    for (const channel of channels) {
      const pref = channel.preferences[0];
      if (pref) {
        if (!pref.enabled) continue;
      } else if (!defaultEnabled) {
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

      channelsAttempted += 1;

      try {
        const outcome = await sendToChannel(
          channel.type as ChannelType,
          channel.config,
          payload,
        );

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

async function sendToChannel(
  type: ChannelType,
  encryptedConfig: string,
  payload: NotificationPayload,
): Promise<SendOutcome> {
  let decrypted: string;
  try {
    decrypted = decrypt(encryptedConfig);
  } catch {
    getEvent()?.addWarning(`Failed to decrypt ${type} channel config`);
    return {
      ok: false,
      hardReject: false,
      reason: `${type.toLowerCase()}_config_decrypt_failed`,
    };
  }

  switch (type) {
    case "TELEGRAM": {
      let config: TelegramChannelConfig;
      try {
        config = JSON.parse(decrypted) as TelegramChannelConfig;
      } catch {
        getEvent()?.addWarning("Failed to parse Telegram channel config");
        return {
          ok: false,
          hardReject: false,
          reason: "telegram_config_parse_failed",
        };
      }
      return sendViaTelegram(config, payload);
    }
    case "NTFY": {
      let config: NtfyChannelConfig;
      try {
        config = JSON.parse(decrypted) as NtfyChannelConfig;
      } catch {
        getEvent()?.addWarning("Failed to parse ntfy channel config");
        return {
          ok: false,
          hardReject: false,
          reason: "ntfy_config_parse_failed",
        };
      }
      return sendViaNtfy(config, payload);
    }
    case "WEB_PUSH": {
      return sendViaWebPush(payload.userId, payload);
    }
    case "APNS": {
      // APNs config lives on the Device row, not in the channel config.
      // The decrypt above is a no-op (config is the empty object `{}`),
      // we just keep the symmetric path so future per-user overrides
      // (e.g. a custom APNs topic) can hang off the channel without
      // changing the dispatcher shape.
      return sendViaApns(payload.userId, payload);
    }
    default:
      getEvent()?.addWarning(`Unknown notification channel type: ${type}`);
      return {
        ok: false,
        hardReject: false,
        reason: "unknown_channel_type",
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
    case "WEB_PUSH":
      return 3;
    default:
      return 99;
  }
}
