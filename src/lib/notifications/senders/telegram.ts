import { sendTelegramMessage } from "@/lib/telegram";
import type {
  TelegramChannelConfig,
  NotificationPayload,
} from "@/lib/notifications/types";

/**
 * Send notification via Telegram.
 * For MEDICATION_REMINDER events with medicationId metadata,
 * includes an inline keyboard button for marking as taken.
 */
export async function sendViaTelegram(
  config: TelegramChannelConfig,
  payload: NotificationPayload,
): Promise<boolean> {
  const medicationId = payload.metadata?.medicationId;
  const replyMarkup =
    payload.eventType === "MEDICATION_REMINDER" && medicationId
      ? {
          inline_keyboard: [
            [
              {
                text: "✅ Genommen",
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

  return sendTelegramMessage(config.botToken, config.chatId, payload.message, {
    parseMode: "HTML",
    replyMarkup,
  });
}
