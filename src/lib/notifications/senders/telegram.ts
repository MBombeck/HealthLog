import { sendTelegramMessage, deleteMessage } from "@/lib/telegram";
import type { SendMessageResult } from "@/lib/telegram";
import type {
  TelegramChannelConfig,
  NotificationPayload,
} from "@/lib/notifications/types";
import { PrismaClient, type ReminderPhase } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

let senderPrisma: PrismaClient | null = null;

function getSenderPrisma(): PrismaClient {
  if (!senderPrisma) {
    const adapter = new PrismaPg({
      connectionString: process.env.DATABASE_URL!,
    });
    senderPrisma = new PrismaClient({ adapter });
  }
  return senderPrisma;
}

/**
 * Delete all existing Telegram reminder messages for a medication on a given date.
 * Best-effort: logs errors but never throws.
 */
async function deleteExistingReminders(
  botToken: string,
  medicationId: string,
  date: string,
): Promise<void> {
  const prisma = getSenderPrisma();
  try {
    const existing = await prisma.telegramReminderMessage.findMany({
      where: { medicationId, date },
    });

    for (const msg of existing) {
      try {
        await deleteMessage(botToken, msg.chatId, msg.messageId);
      } catch {
        // Best-effort: message may already be deleted
      }
    }

    if (existing.length > 0) {
      await prisma.telegramReminderMessage.deleteMany({
        where: { medicationId, date },
      });
    }
  } catch (err) {
    console.error("[telegram] Failed to delete existing reminders:", err);
  }
}

/**
 * Send notification via Telegram.
 * For MEDICATION_REMINDER events with phase metadata:
 *  1. Delete existing reminder messages for this medication
 *  2. Send new message with phase-specific keyboard
 *  3. Track the message in TelegramReminderMessage table
 *
 * For non-reminder events, sends as before without tracking.
 */
export async function sendViaTelegram(
  config: TelegramChannelConfig,
  payload: NotificationPayload,
): Promise<SendMessageResult> {
  const medicationId = payload.metadata?.medicationId as string | undefined;
  const scheduleId = payload.metadata?.scheduleId as string | undefined;
  const phase = payload.metadata?.phase as string | undefined;
  const date = payload.metadata?.date as string | undefined;
  const replyMarkup = payload.metadata?.replyMarkup as
    | { inline_keyboard: { text: string; callback_data: string }[][] }
    | undefined;

  // Phase-aware: delete old messages before sending new one
  if (medicationId && phase && date) {
    await deleteExistingReminders(config.botToken, medicationId, date);
  }

  // Build reply markup
  const keyboard =
    replyMarkup ??
    (payload.eventType === "MEDICATION_REMINDER" && medicationId
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
                text: "\u{1F550} 1h",
                callback_data: `snooze:${medicationId}:60`,
              },
              {
                text: "\u{1F550} 3h",
                callback_data: `snooze:${medicationId}:180`,
              },
              {
                text: "\u23ED Überspringen",
                callback_data: `skip:${medicationId}`,
              },
            ],
          ],
        }
      : undefined);

  const result = await sendTelegramMessage(
    config.botToken,
    config.chatId,
    payload.message,
    {
      parseMode: "HTML",
      replyMarkup: keyboard,
    },
  );

  // Track the message in DB for later deletion
  if (
    result.ok &&
    result.messageId &&
    medicationId &&
    scheduleId &&
    phase &&
    date
  ) {
    const prisma = getSenderPrisma();
    try {
      await prisma.telegramReminderMessage.upsert({
        where: {
          medicationId_scheduleId_date_phase: {
            medicationId,
            scheduleId,
            date,
            phase: phase as ReminderPhase,
          },
        },
        create: {
          medicationId,
          scheduleId,
          chatId: config.chatId,
          messageId: result.messageId,
          phase: phase as ReminderPhase,
          date,
        },
        update: {
          chatId: config.chatId,
          messageId: result.messageId,
        },
      });
    } catch (err) {
      console.error("[telegram] Failed to track reminder message:", err);
    }
  }

  return result;
}
