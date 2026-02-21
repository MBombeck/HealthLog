import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
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
      return sendViaTelegram(config, payload);
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
