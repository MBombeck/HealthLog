import { prisma } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import type {
  NotificationPayload,
  TelegramChannelConfig,
  NtfyChannelConfig,
  ChannelType,
} from "@/lib/notifications/types";
import { sendViaTelegram } from "@/lib/notifications/senders/telegram";
import { sendViaNtfy } from "@/lib/notifications/senders/ntfy";
import { sendViaWebPush } from "@/lib/notifications/senders/web-push";

/**
 * Dispatch a notification to all enabled channels for a user.
 * Best-effort: logs errors but never throws.
 *
 * For each channel:
 *  1. Check if the channel is enabled
 *  2. Check if a preference exists for this eventType (default: enabled / opt-out)
 *  3. Call the appropriate sender
 *
 * Also handles legacy Telegram config stored on the User model by
 * auto-migrating it to a NotificationChannel record on first dispatch.
 */
export async function dispatchNotification(
  payload: NotificationPayload,
): Promise<void> {
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

        if (user?.telegramEnabled && user.telegramBotToken && user.telegramChatId) {
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
          console.log(
            `[dispatcher] Auto-migrated legacy Telegram config for user ${payload.userId}`,
          );
        }
      } catch (err) {
        console.error("[dispatcher] Legacy Telegram migration failed:", err);
      }
    }

    for (const channel of channels) {
      // Opt-out model: if no preference row exists, default to enabled
      const pref = channel.preferences[0];
      if (pref && !pref.enabled) continue;

      try {
        await sendToChannel(
          channel.type as ChannelType,
          channel.config,
          payload,
        );
      } catch (err) {
        console.error(
          `Notification dispatch failed for channel ${channel.type}:`,
          err,
        );
      }
    }
  } catch (err) {
    console.error("Notification dispatcher error:", err);
  }
}

async function sendToChannel(
  type: ChannelType,
  encryptedConfig: string,
  payload: NotificationPayload,
): Promise<boolean> {
  switch (type) {
    case "TELEGRAM": {
      const config = JSON.parse(
        decrypt(encryptedConfig),
      ) as TelegramChannelConfig;
      const result = await sendViaTelegram(config, payload);
      return result.ok;
    }
    case "NTFY": {
      const config = JSON.parse(decrypt(encryptedConfig)) as NtfyChannelConfig;
      return sendViaNtfy(config, payload);
    }
    case "WEB_PUSH": {
      return sendViaWebPush(payload.userId, payload);
    }
    default:
      console.warn(`Unknown notification channel type: ${type}`);
      return false;
  }
}
