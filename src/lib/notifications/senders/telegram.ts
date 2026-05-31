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
 * Delete the existing Telegram reminder message for a single dose slot
 * before re-sending it. v1.7.0 SB-SCHED-4 — scoped to the exact slot
 * `{ medicationId, scheduleId, date, phase, timeOfDay }` (the same
 * composite the tracking upsert keys on), NOT the whole medication. A
 * medication with `timesOfDay = ["08:00","20:00"]` has two distinct
 * ledger rows per day; the pre-v1.7 whole-medication wipe deleted the
 * morning row when the evening slot dispatched, so the worker's dedup
 * check (`findUnique`) found nothing and re-fired the morning reminder.
 * Best-effort: logs errors but never throws.
 */
async function deleteExistingReminders(
  botToken: string,
  medicationId: string,
  scheduleId: string,
  date: string,
  phase: ReminderPhase,
  timeOfDay: string,
): Promise<void> {
  try {
    const existing = await prisma.telegramReminderMessage.findUnique({
      where: {
        medicationId_scheduleId_date_phase_timeOfDay: {
          medicationId,
          scheduleId,
          date,
          phase,
          timeOfDay,
        },
      },
    });

    if (!existing) return;

    try {
      await deleteMessage(botToken, existing.chatId, existing.messageId);
    } catch {
      // Best-effort: message may already be deleted
    }

    await prisma.telegramReminderMessage.delete({
      where: {
        medicationId_scheduleId_date_phase_timeOfDay: {
          medicationId,
          scheduleId,
          date,
          phase,
          timeOfDay,
        },
      },
    });
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
  // v1.7.0 SB-SCHED-4 — per-slot dedup. Empty string for a legacy
  // single-window schedule (byte-stable against pre-v1.7 rows).
  const timeOfDay = (payload.metadata?.timeOfDay as string | undefined) ?? "";
  const replyMarkup = payload.metadata?.replyMarkup as
    | { inline_keyboard: { text: string; callback_data: string }[][] }
    | undefined;

  // Phase-aware: delete the prior message for THIS slot before re-sending,
  // keyed on the same composite the tracking upsert uses so a multi-time-
  // of-day medication's other slots keep their live ledger rows.
  if (medicationId && scheduleId && phase && date) {
    await deleteExistingReminders(
      config.botToken,
      medicationId,
      scheduleId,
      date,
      phase as ReminderPhase,
      timeOfDay,
    );
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
          medicationId_scheduleId_date_phase_timeOfDay: {
            medicationId,
            scheduleId,
            date,
            phase: phase as ReminderPhase,
            timeOfDay,
          },
        },
        create: {
          medicationId,
          scheduleId,
          chatId: config.chatId,
          messageId: result.messageId,
          phase: phase as ReminderPhase,
          date,
          timeOfDay,
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
