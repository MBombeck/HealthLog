import { sendTelegramMessage, deleteMessage } from "@/lib/telegram";
import type {
  TelegramChannelConfig,
  NotificationPayload,
} from "@/lib/notifications/types";
import type { SendOutcome } from "@/lib/notifications/retry-policy";
import { classifyTelegramError } from "@/lib/notifications/retry-policy";
import { prisma } from "@/lib/db";
import type { ReminderPhase } from "@/generated/prisma/client";
import { getEvent } from "@/lib/logging/context";
import { recordPushAttempt } from "@/lib/notifications/senders/push-attempt-record";

/**
 * Telegram sender result. Inherits from `SendOutcome` so the dispatcher
 * can classify hard vs soft rejects, and tacks on `messageId` for the
 * reminder-tracking flow that wants to delete the message later.
 */
export interface TelegramSendResult extends SendOutcome {
  messageId?: number;
}

/**
 * Delete ALL existing Telegram reminder messages for a medication (any date).
 * Ensures max one active message per medication in the chat.
 * Best-effort: logs errors but never throws.
 */
async function deleteExistingReminders(
  botToken: string,
  medicationId: string,
): Promise<void> {
  try {
    const existing = await prisma.telegramReminderMessage.findMany({
      where: { medicationId },
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
        where: { medicationId },
      });
    }
  } catch (err) {
    getEvent()?.addWarning(`Failed to delete existing reminders: ${err}`);
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
): Promise<TelegramSendResult> {
  const medicationId = payload.metadata?.medicationId as string | undefined;
  const scheduleId = payload.metadata?.scheduleId as string | undefined;
  const phase = payload.metadata?.phase as string | undefined;
  const date = payload.metadata?.date as string | undefined;
  const replyMarkup = payload.metadata?.replyMarkup as
    | { inline_keyboard: { text: string; callback_data: string }[][] }
    | undefined;

  // Phase-aware: delete old messages before sending new one
  if (medicationId && phase) {
    await deleteExistingReminders(config.botToken, medicationId);
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
      getEvent()?.addWarning(`Failed to track reminder message: ${err}`);
    }
  }

  if (result.ok) {
    recordPushAttempt({
      userId: payload.userId,
      channel: "TELEGRAM",
      eventType: payload.eventType,
      result: "ok",
    });
    return { ok: true, messageId: result.messageId };
  }
  const classified = classifyTelegramError(result.errorDescription);
  recordPushAttempt({
    userId: payload.userId,
    channel: "TELEGRAM",
    eventType: payload.eventType,
    result: "error",
    reason: classified.reason,
  });
  return {
    ok: false,
    hardReject: classified.hardReject,
    reason: classified.reason,
    message: result.errorDescription,
  };
}
