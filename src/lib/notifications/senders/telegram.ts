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
  const replyMarkup =
    payload.eventType === "MEDICATION_REMINDER" &&
    payload.metadata?.medicationId
      ? {
          inline_keyboard: [
            [
              {
                text: "✅ Als genommen markieren",
                callback_data: `taken:${payload.metadata.medicationId}`,
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
