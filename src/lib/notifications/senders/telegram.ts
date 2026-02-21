import { sendTelegramMessage } from "@/lib/telegram";
import type { SendMessageResult } from "@/lib/telegram";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import type {
  TelegramChannelConfig,
  NotificationPayload,
} from "@/lib/notifications/types";

const TELEGRAM_CLEANUP_QUEUE = "telegram-message-cleanup";

/**
 * Send notification via Telegram.
 * For MEDICATION_REMINDER events with medicationId metadata,
 * includes an inline keyboard button for marking as taken.
 *
 * After successful send, schedules a delayed pg-boss job
 * to delete the message after 24 hours.
 */
export async function sendViaTelegram(
  config: TelegramChannelConfig,
  payload: NotificationPayload,
): Promise<SendMessageResult> {
  const medicationId = payload.metadata?.medicationId;
  const replyMarkup =
    payload.eventType === "MEDICATION_REMINDER" && medicationId
      ? {
          inline_keyboard: [
            [
              {
                text: "Genommen",
                callback_data: `taken:${medicationId}`,
              },
            ],
            [
              {
                text: "🕐 1h",
                callback_data: `snooze:${medicationId}:60`,
              },
              {
                text: "🕐 3h",
                callback_data: `snooze:${medicationId}:180`,
              },
              {
                text: "⏭ Überspringen",
                callback_data: `skip:${medicationId}`,
              },
            ],
          ],
        }
      : undefined;

  const result = await sendTelegramMessage(
    config.botToken,
    config.chatId,
    payload.message,
    {
      parseMode: "HTML",
      replyMarkup,
    },
  );

  // Schedule cleanup: delete this message after 24 hours
  if (result.ok && result.messageId) {
    const boss = getGlobalBoss();
    if (boss) {
      try {
        await boss.send(
          TELEGRAM_CLEANUP_QUEUE,
          {
            userId: payload.userId,
            chatId: config.chatId,
            messageId: result.messageId,
          },
          { startAfter: 86400 },
        );
      } catch (err) {
        console.error("[telegram] Failed to schedule cleanup:", err);
      }
    }
  }

  return result;
}
