import { sendTelegramMessage, deleteMessage } from "@/lib/telegram";
import type {
  TelegramChannelConfig,
  NotificationPayload,
} from "@/lib/notifications/types";
import type { SendOutcome } from "@/lib/notifications/retry-policy";
import { classifyTelegramError } from "@/lib/notifications/retry-policy";
import { prisma } from "@/lib/db";
import { getPhaseKeyboard } from "@/lib/jobs/reminder-phases";
import { resolveSnoozeMinutes } from "@/lib/validations/notification-prefs";
import type { ReminderPhase } from "@/generated/prisma/client";
import { getEvent } from "@/lib/logging/context";
import { recordPushAttemptForPayload } from "@/lib/notifications/senders/push-attempt-record";
import { scheduleTelegramAutoDelete } from "@/lib/telegram-cleanup";
import {
  buildMoodKeyboard,
  buildMeasurementKeyboard,
} from "@/lib/notifications/senders/telegram-keyboards";
import { defaultLocale, locales, type Locale } from "@/lib/i18n/config";
import { telegramLinkMode } from "@/lib/notifications/tap-target";

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/g, "&quot;");
}

/**
 * v1.19.0 — resolve the bot locale for an interactive reminder. The
 * sender knows the recipient through the delivery identity; keyboard labels
 * need that account's locale. Defaults to "de" when
 * unset, matching the webhook's `resolveBotLocale`.
 */
async function resolveSenderLocale(userId: string): Promise<Locale> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { locale: true },
    });
    const value = user?.locale;
    if (value && (locales as readonly string[]).includes(value)) {
      return value as Locale;
    }
  } catch {
    // Fall through to the default on any read failure.
  }
  return (locales as readonly string[]).includes("de")
    ? ("de" as Locale)
    : defaultLocale;
}

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
 * `{ recipientUserId, medicationId, scheduleId, date, phase, timeOfDay }` (the same
 * composite the tracking upsert keys on), NOT the whole medication. A
 * medication with `timesOfDay = ["08:00","20:00"]` has two distinct
 * ledger rows per day; the pre-v1.7 whole-medication wipe deleted the
 * morning row when the evening slot dispatched, so the worker's dedup
 * check (`findUnique`) found nothing and re-fired the morning reminder.
 * Best-effort: logs errors but never throws.
 */
async function deleteExistingReminders(
  botToken: string,
  recipientUserId: string,
  medicationId: string,
  scheduleId: string,
  date: string,
  phase: ReminderPhase,
  timeOfDay: string,
): Promise<void> {
  try {
    const existing = await prisma.telegramReminderMessage.findUnique({
      where: {
        recipientUserId_medicationId_scheduleId_date_phase_timeOfDay: {
          recipientUserId,
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
  const userId = payload.recipientUserId ?? payload.userId;
  const medicationId = payload.metadata?.medicationId as string | undefined;
  const scheduleId = payload.metadata?.scheduleId as string | undefined;
  const phase = payload.metadata?.phase as string | undefined;
  const date = payload.metadata?.date as string | undefined;
  // v1.7.0 — per-slot dedup. Empty string for a legacy
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
      userId,
      medicationId,
      scheduleId,
      date,
      phase as ReminderPhase,
      timeOfDay,
    );
  }

  // v1.19.0 — interactive mood + measurement reminders. The mood prompt
  // ships a 1–5 scale + note/later row; the measurement prompt ships a
  // done/later row (no value capture). Labels are localised; callback_data
  // ids are stable and locale-independent. Both prompts schedule their own
  // ~30-min auto-delete below so an ignored nudge self-cleans.
  const reminderId = payload.metadata?.reminderId as string | undefined;
  let interactiveKeyboard:
    | { inline_keyboard: { text: string; callback_data: string }[][] }
    | undefined;
  const selfDelivery = payload.recordUserId === payload.recipientUserId;
  if (selfDelivery && !replyMarkup) {
    if (payload.eventType === "MOOD_REMINDER") {
      interactiveKeyboard = buildMoodKeyboard(
        await resolveSenderLocale(userId),
      );
    } else if (
      payload.eventType === "MEASUREMENT_REMINDER" &&
      reminderId &&
      // An appointment nudge is dispatched with the affordance suppressed:
      // `measure_done` / `measure_later` both refuse an ENCOUNTER-origin row,
      // so offering the pair would put two buttons in the chat that can only
      // answer "not found".
      !payload.suppressActions
    ) {
      interactiveKeyboard = buildMeasurementKeyboard(
        reminderId,
        await resolveSenderLocale(userId),
      );
    }
  }

  // Build reply markup. A dose reminder that arrives without its own
  // keyboard gets the same one the reminder job builds: localised, with the
  // person's snooze length, never a second hand-written copy.
  const doseKeyboard =
    selfDelivery &&
    !replyMarkup &&
    !interactiveKeyboard &&
    payload.eventType === "MEDICATION_REMINDER" &&
    medicationId
      ? getPhaseKeyboard(
          "GREEN",
          medicationId,
          await resolveSenderLocale(userId),
          resolveSnoozeMinutes(
            (
              await prisma.user.findUnique({
                where: { id: userId },
                select: { notificationPrefs: true },
              })
            )?.notificationPrefs,
          ),
        )
      : undefined;
  const keyboard =
    (selfDelivery ? replyMarkup : undefined) ??
    interactiveKeyboard ??
    doseKeyboard;

  // Tap target. Telegram has no "tap opens a URL" for a message, so the
  // target rides an inline URL button under it (below any action row), or a
  // text link where Telegram would refuse the button (see `telegramLinkMode`).
  const linkMode = payload.tap?.url
    ? telegramLinkMode(payload.tap.url)
    : "none";
  const linkedKeyboard =
    linkMode === "button" && payload.tap?.url
      ? {
          inline_keyboard: [
            ...(keyboard?.inline_keyboard ?? []),
            [{ text: payload.tap.label, url: payload.tap.url }],
          ],
        }
      : keyboard;
  const text =
    linkMode === "text" && payload.tap?.url
      ? `${payload.message}\n\n<a href="${escapeHtmlAttribute(payload.tap.url)}">${escapeHtmlText(payload.tap.label)}</a>`
      : payload.message;

  const result = await sendTelegramMessage(
    config.botToken,
    config.chatId,
    text,
    {
      parseMode: "HTML",
      replyMarkup: linkedKeyboard,
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
          recipientUserId_medicationId_scheduleId_date_phase_timeOfDay: {
            recipientUserId: userId,
            medicationId,
            scheduleId,
            date,
            phase: phase as ReminderPhase,
            timeOfDay,
          },
        },
        create: {
          recipientUserId: userId,
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

  // v1.19.0 — schedule the interactive prompt's own ~30-min self-clean so
  // an UNANSWERED mood / measurement nudge never lingers in the chat (the
  // medication path re-cleans on slot re-send; these have no re-send). A
  // tapped prompt is deleted immediately by the webhook callback handler;
  // this row is the fallback and is harmless once the message is gone.
  if (result.ok && result.messageId && interactiveKeyboard) {
    await scheduleTelegramAutoDelete(userId, config.chatId, [result.messageId]);
  }

  if (result.ok) {
    recordPushAttemptForPayload(payload, userId, {
      userId: payload.userId,
      channel: "TELEGRAM",
      eventType: payload.eventType,
      result: "ok",
    });
    return { ok: true, messageId: result.messageId };
  }
  const classified = classifyTelegramError(result.errorDescription);
  recordPushAttemptForPayload(payload, userId, {
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
