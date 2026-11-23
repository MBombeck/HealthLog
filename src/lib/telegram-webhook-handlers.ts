import { textEquals } from "@/lib/db-like";
import { activeAccount } from "@/lib/account-deletion/active-account";
import { prisma } from "@/lib/db";
import { isP2025 } from "@/lib/prisma-errors";
import { decrypt } from "@/lib/crypto";
import {
  answerTelegramCallbackQuery,
  deleteMessage,
  sendTelegramMessage,
} from "@/lib/telegram";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { locales, type Locale } from "@/lib/i18n/config";
import { foldForMatch } from "@/lib/i18n/fold-for-match";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import {
  logTelegramMood,
  attachTelegramMoodNote,
} from "@/lib/mood/create-from-telegram";
import { scheduleTelegramAutoDelete } from "@/lib/telegram-cleanup";
import {
  SATISFIABLE_REMINDER_SELECT,
  satisfyReminder,
} from "@/lib/measurement-reminders/satisfy";
import {
  isTelegramCapturableType,
  logTelegramMeasurement,
} from "@/lib/measurements/create-from-telegram";
// Every Telegram path that offers, records or snoozes a dose resolves the
// medication here: tracked, active, course not ended, Medications module on.
import {
  findTelegramDoseMedication,
  listTelegramDoseMedications,
} from "@/lib/telegram-dose-medications";
import { answerDoseSnooze } from "@/lib/telegram-dose-snooze";
import { GREETING_WORDS, HELP_WORDS } from "@/lib/telegram-bare-words";
import {
  markMedicationSkipped,
  markMedicationTaken,
} from "@/lib/telegram-dose-writes";

/**
 * Telegram webhook update handlers, split out of
 * `src/app/api/telegram/webhook/route.ts` (v1.28.26 file-size split —
 * pure code motion, no behaviour change) so the route stays a thin
 * shell: rate limit, shared-secret check, JSON parse, dispatch. The
 * callback (button-tap) and free-text paths plus their medication /
 * mood / measurement helpers live here. The userId is always resolved
 * from the linked chat via `findTelegramUser` — never from the payload.
 */

/**
 * True when the whole message is one of `words`. Folded on both sides, so the
 * comparison is case-, accent- and punctuation-insensitive; anchored to the
 * whole message, so "help me log my weight" is not swallowed as a command.
 */
function isBareCommandWord(text: string, words: readonly string[]): boolean {
  const folded = foldForMatch(text);
  return folded !== "" && words.includes(folded);
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id: number | string };
    reply_to_message?: {
      message_id?: number;
    };
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id?: number | string };
    message?: {
      message_id?: number;
      chat?: { id: number | string };
    };
  };
}

function toChatId(value: number | string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  return String(value);
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Resolve the bot locale for an existing Telegram user.
 *
 * Defaults to "de" when User.locale is null — existing bots were set up in
 * German and we don't want to silently flip them. Users who have switched
 * the UI to English (User.locale = "en") get an English bot too.
 */
function resolveBotLocale(value: string | null | undefined): Locale {
  if (value && (locales as readonly string[]).includes(value)) {
    return value as Locale;
  }
  return "de";
}

async function cleanupReminderTracking(
  recipientUserId: string,
  medicationId: string,
): Promise<void> {
  try {
    await prisma.telegramReminderMessage.deleteMany({
      where: {
        recipientUserId,
        medicationId,
        medication: { userId: recipientUserId },
      },
    });
  } catch {
    // Best-effort cleanup
  }
}

/**
 * A managed-record reminder is tracked under the Guardian recipient so a
 * replacement can delete the prior message. Its callback must never mutate
 * the managed record, even if a crafted Telegram update supplies action data.
 */
async function isManagedReminderCallback(input: {
  recipientUserId: string;
  chatId: string;
  messageId: number;
}): Promise<boolean> {
  const reminder = await prisma.telegramReminderMessage.findFirst({
    where: {
      recipientUserId: input.recipientUserId,
      chatId: input.chatId,
      messageId: input.messageId,
    },
    select: { medication: { select: { userId: true } } },
  });
  return (
    reminder?.medication?.userId !== undefined &&
    reminder.medication.userId !== input.recipientUserId
  );
}

// The auto-delete window lives in `scheduleTelegramAutoDelete`, so the inbound
// (free-text) and outbound (unanswered prompt) paths agree on it.
async function scheduleAutoDelete(
  userId: string,
  chatId: string,
  messageIds: number[],
): Promise<void> {
  await scheduleTelegramAutoDelete(userId, chatId, messageIds);
}

async function findTelegramUser(chatId: string) {
  return prisma.user.findFirst({
    where: activeAccount({
      telegramEnabled: true,
      telegramChatId: chatId,
      telegramBotToken: { not: null },
    }),
    select: {
      id: true,
      telegramBotToken: true,
      locale: true,
      // Pulled into the select so the post-write dose-day refresh can
      // anchor the user's local day.
      timezone: true,
    },
  });
}

export async function handleCallback(update: TelegramUpdate) {
  const callback = update.callback_query;
  if (!callback) return;

  const chatId =
    toChatId(callback.message?.chat?.id) ?? toChatId(callback.from?.id);
  if (!chatId) return;

  const user = await findTelegramUser(chatId);
  if (!user?.telegramBotToken) return;
  const botToken = decrypt(user.telegramBotToken);
  const locale = resolveBotLocale(user.locale);
  const { t } = getServerTranslator(locale);

  const data = callback.data ?? "";
  const messageId = callback.message?.message_id;

  if (
    messageId !== undefined &&
    /^(taken|snooze|skip|ack):/.test(data) &&
    (await isManagedReminderCallback({
      recipientUserId: user.id,
      chatId,
      messageId,
    }))
  ) {
    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.errorInvalidAction"),
    );
    return;
  }

  if (data.startsWith("taken:")) {
    const medicationId = data.slice("taken:".length).trim();
    if (!medicationId) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorInvalidAction"),
      );
      return;
    }

    const msgId = messageId ?? "na";
    const idempotencyKey =
      `telegram:cb:${chatId}:${msgId}:${medicationId}`.slice(0, 128);

    const result = await markMedicationTaken(
      user.id,
      medicationId,
      idempotencyKey,
      locale,
      user.timezone,
      messageId !== undefined ? { chatId, messageId } : undefined,
    );
    await answerTelegramCallbackQuery(botToken, callback.id, result.message);
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
    await cleanupReminderTracking(user.id, medicationId);
  } else if (data.startsWith("snooze:")) {
    await answerDoseSnooze({
      data,
      user,
      t,
      reply: (text) => answerTelegramCallbackQuery(botToken, callback.id, text),
      done: async (medicationId) => {
        if (messageId) await deleteMessage(botToken, chatId, messageId);
        await cleanupReminderTracking(user.id, medicationId);
      },
    });
  } else if (data.startsWith("skip:")) {
    const medicationId = data.slice("skip:".length).trim();
    if (!medicationId) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorInvalidAction"),
      );
      return;
    }

    const medication = await findTelegramDoseMedication(
      user.id,
      user.timezone,
      { id: medicationId },
    );
    if (!medication) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorMedicationNotFound"),
      );
      return;
    }

    const skip = await markMedicationSkipped({
      userId: user.id,
      userTz: user.timezone,
      medicationId: medication.id,
      chatId,
      messageId,
    });
    const name = medication.name;
    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      skip === "alreadyTaken"
        ? t("telegram.alreadyRecorded", { name })
        : t("telegram.skipped", { name }),
    );
    if (messageId) await deleteMessage(botToken, chatId, messageId);
    await cleanupReminderTracking(user.id, medicationId);
  } else if (data.startsWith("ack:")) {
    const medicationId = data.slice("ack:".length).trim();
    if (!medicationId) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorInvalidAction"),
      );
      return;
    }

    const medication = await prisma.medication.findFirst({
      where: { id: medicationId, userId: user.id },
      select: { id: true, name: true },
    });

    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      medication
        ? t("telegram.confirmed", { name: medication.name })
        : t("telegram.genericConfirmed"),
    );
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
    await cleanupReminderTracking(user.id, medicationId);
  } else if (data.startsWith("add:")) {
    // Format: "add:{medicationId}" or "add:{medicationId}:umid:{userMsgId}"
    const withoutPrefix = data.slice("add:".length);
    const umidIdx = withoutPrefix.indexOf(":umid:");
    const medicationId =
      umidIdx >= 0 ? withoutPrefix.slice(0, umidIdx) : withoutPrefix.trim();
    if (!medicationId) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorInvalidAction"),
      );
      return;
    }

    const msgId = messageId ?? "na";
    const idempotencyKey =
      `telegram:add:${chatId}:${msgId}:${medicationId}`.slice(0, 128);

    const result = await markMedicationTaken(
      user.id,
      medicationId,
      idempotencyKey,
      locale,
      user.timezone,
    );
    await answerTelegramCallbackQuery(botToken, callback.id, result.message);
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
    // Also delete the user's /add command message if encoded
    const userMsgMatch = data.match(/:umid:(\d+)$/);
    if (userMsgMatch) {
      const userMsgId = parseInt(userMsgMatch[1], 10);
      if (Number.isFinite(userMsgId)) {
        await deleteMessage(botToken, chatId, userMsgId).catch(() => {});
      }
    }
  } else if (data.startsWith("cancel_add")) {
    // Delete the bot's selection message
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
    // Delete the user's original /add command message if encoded
    const userMsgMatch = data.match(/:umid:(\d+)$/);
    if (userMsgMatch) {
      const userMsgId = parseInt(userMsgMatch[1], 10);
      if (Number.isFinite(userMsgId)) {
        await deleteMessage(botToken, chatId, userMsgId).catch(() => {});
      }
    }
    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.cancelled"),
    );
  } else if (data.startsWith("mood:")) {
    // v1.19.0 — log a mood entry 1–5 from a MOOD_REMINDER prompt tap.
    // The score is the ONLY accepted value; the userId is resolved from
    // the linked chat above, never from the payload. Confirmation is a
    // calm callback toast — no chat echo (restraint).
    const score = parseInt(data.slice("mood:".length).trim(), 10);
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorInvalidAction"),
      );
      return;
    }

    const msgId = messageId ?? "na";
    // Stable per-tap dedup id (Telegram redelivers non-200 updates). The
    // mood-create helper upserts on `(userId, source, externalId)`.
    const externalId = `telegram:mood:${chatId}:${msgId}:${score}`.slice(
      0,
      120,
    );

    const moodResult = await logTelegramMood({
      userId: user.id,
      score,
      tz: user.timezone,
      externalId,
    });

    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.moodLogged", { score: String(score) }),
    );
    // Delete the prompt immediately on a tap; the unanswered-prompt
    // scheduled deletion (written at send time) is then a harmless no-op.
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }

    // Offer an optional note via force_reply. The reply (when it arrives)
    // is correlated back to this mood entry through TelegramPromptContext.
    const notePrompt = await sendTelegramMessage(
      botToken,
      chatId,
      t("telegram.moodNotePrompt"),
      {
        replyMarkup: {
          force_reply: true,
          input_field_placeholder: t("telegram.buttonMoodNote"),
        },
      },
    );
    if (notePrompt.ok && notePrompt.messageId) {
      try {
        await prisma.telegramPromptContext.create({
          data: {
            userId: user.id,
            chatId,
            promptMsgId: notePrompt.messageId,
            kind: "mood_note",
            refId: moodResult.moodEntryId,
            // Force-reply context lifespan: the same ~30-min window as the
            // deletion sweep. A reply after this is treated as expired.
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
          },
        });
      } catch {
        // Best-effort — without the context row the note simply can't bind.
      }
      // The note prompt itself self-cleans on the ~30-min sweep whether or
      // not the user replies.
      await scheduleAutoDelete(user.id, chatId, [notePrompt.messageId]);
    }
  } else if (data.startsWith("mood_later")) {
    // v1.19.0 — restrained "remind me later" for the mood nudge. Clears
    // today's dispatch ledger so the next cron tick (inside the user's
    // reminder-hour window) re-fires the prompt, mirroring how the
    // medication snooze lets the tick re-remind. The prompt is deleted now.
    const tz = user.timezone || DEFAULT_TIMEZONE;
    const parts = wallClockInTz(new Date(), tz);
    const localDate = `${parts.year.toString().padStart(4, "0")}-${parts.month
      .toString()
      .padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
    try {
      await prisma.moodReminderDispatch.deleteMany({
        where: { userId: user.id, date: localDate },
      });
    } catch {
      // Best-effort — a failure just means the day's nudge isn't re-armed.
    }
    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.remindLater", { duration: t("telegram.snoozeOneHour") }),
    );
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
  } else if (data.startsWith("measure_done:")) {
    // v1.19.0 — mark a Vorsorge/measurement reminder done; satisfy the
    // cadence via the shared primitive.
    const reminderId = data.slice("measure_done:".length).trim();
    // An appointment reminder is not addressable here, the same refusal the
    // by-id HTTP family makes: it belongs to a visit, is managed through the
    // visit routes, and sits in a different sharing domain. The lookup answers
    // "not found" rather than acting on it — satisfying one would mark an
    // appointment attended from a chat button, and postponing one would move a
    // date the visit record still believes it owns.
    const reminder = await prisma.measurementReminder.findFirst({
      where: {
        id: reminderId,
        userId: user.id,
        deletedAt: null,
        origin: { not: "ENCOUNTER" },
      },
      select: {
        ...SATISFIABLE_REMINDER_SELECT,
        // v1.19.2 — the target metric; drives the optional numeric capture.
        measurementType: true,
      },
    });
    if (!reminder) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.measurementNotFound"),
      );
      return;
    }
    const tz = user.timezone || DEFAULT_TIMEZONE;
    await satisfyReminder(prisma, reminder, tz, new Date(), "telegram");
    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.measurementDone"),
    );
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }

    // v1.19.2 — optional numeric value capture. When the reminder names a
    // single-value metric (BP and free-text Vorsorge are excluded), offer a
    // force-reply prompt; a numeric reply is captured as a Measurement
    // (source=TELEGRAM) in `handleTextMessage`. The reply binds to THIS
    // reminder + user through a TelegramPromptContext keyed on the prompt
    // message id, the SAME strict chat/message binding the mood-note path
    // uses — the userId is never read from the inbound payload. Optional and
    // self-cleaning: ignoring the prompt leaves the cadence already
    // satisfied, and the prompt is swept on the ~30-min auto-delete.
    if (isTelegramCapturableType(reminder.measurementType)) {
      const valuePrompt = await sendTelegramMessage(
        botToken,
        chatId,
        t("telegram.measureValuePrompt"),
        {
          replyMarkup: {
            force_reply: true,
            input_field_placeholder: t("telegram.buttonMeasureValue"),
          },
        },
      );
      if (valuePrompt.ok && valuePrompt.messageId) {
        try {
          await prisma.telegramPromptContext.create({
            data: {
              userId: user.id,
              chatId,
              promptMsgId: valuePrompt.messageId,
              kind: "measure_value",
              refId: reminder.id,
              // Same ~30-min window as the deletion sweep; a later reply is
              // treated as expired.
              expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            },
          });
        } catch {
          // Best-effort — without the context row the value simply can't bind.
        }
        await scheduleAutoDelete(user.id, chatId, [valuePrompt.messageId]);
      }
    }
  } else if (data.startsWith("measure_later:")) {
    // v1.19.0 — postpone a measurement reminder by N minutes (one-shot
    // nudge). Pushes `nextDueAt` forward; the cron re-fires once due AND in
    // the user's notify-hour window. Mirrors the medication snooze.
    const parts = data.split(":");
    const reminderId = parts[1];
    const minutes = parseInt(parts[2] ?? "180", 10);
    if (!reminderId || !Number.isFinite(minutes)) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorInvalidAction"),
      );
      return;
    }
    // An appointment reminder is not addressable here, the same refusal the
    // by-id HTTP family makes: it belongs to a visit, is managed through the
    // visit routes, and sits in a different sharing domain. The lookup answers
    // "not found" rather than acting on it — satisfying one would mark an
    // appointment attended from a chat button, and postponing one would move a
    // date the visit record still believes it owns.
    const reminder = await prisma.measurementReminder.findFirst({
      where: {
        id: reminderId,
        userId: user.id,
        deletedAt: null,
        origin: { not: "ENCOUNTER" },
      },
      select: { id: true },
    });
    if (!reminder) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.measurementNotFound"),
      );
      return;
    }
    await prisma.measurementReminder.update({
      where: { id: reminder.id },
      data: { nextDueAt: new Date(Date.now() + minutes * 60000) },
    });
    const duration =
      minutes <= 60
        ? t("telegram.snoozeOneHour")
        : t("telegram.snoozeThreeHours");
    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.remindLater", { duration }),
    );
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
  } else {
    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.errorUnknownAction"),
    );
  }
}

export async function handleTextMessage(update: TelegramUpdate) {
  const message = update.message;
  const text = message?.text?.trim();
  const chatId = toChatId(message?.chat?.id);
  if (!text || !chatId) return;

  const user = await findTelegramUser(chatId);
  if (!user?.telegramBotToken) return;
  const botToken = decrypt(user.telegramBotToken);
  const locale = resolveBotLocale(user.locale);
  const { t } = getServerTranslator(locale);

  // v1.19.0 — force-reply note capture. When this message replies to a
  // tracked mood-note prompt, attach the text to the just-logged mood entry
  // and clean up both messages. The context row is keyed on
  // `(chatId, promptMsgId)` and scoped to THIS user, so a reply can only
  // ever attach to that user's own entry.
  const replyToId = message?.reply_to_message?.message_id;
  if (replyToId !== undefined) {
    const context = await prisma.telegramPromptContext.findUnique({
      where: {
        chatId_promptMsgId: { chatId, promptMsgId: replyToId },
      },
      select: {
        id: true,
        userId: true,
        kind: true,
        refId: true,
        expiresAt: true,
      },
    });
    if (
      context &&
      context.userId === user.id &&
      (context.kind === "mood_note" || context.kind === "measure_value")
    ) {
      // The delete IS the replay guard: consuming the context row is what
      // stops a redelivered reply from being applied to the entry twice. Make
      // it authoritative — if the delete fails for any reason OTHER than the
      // row already being gone (P2025), do NOT apply the reply; abort and let
      // Telegram redeliver against a still-present row. P2025 means the row
      // was already consumed, which is the guard succeeding, so proceed.
      try {
        await prisma.telegramPromptContext.delete({
          where: { id: context.id },
        });
      } catch (err) {
        if (!isP2025(err)) return;
      }
      const userMsgId = message?.message_id;
      if (context.expiresAt.getTime() < Date.now()) {
        const resp = await sendTelegramMessage(
          botToken,
          chatId,
          context.kind === "measure_value"
            ? t("telegram.measureValueExpired")
            : t("telegram.moodNoteExpired"),
        );
        const toDelete = [userMsgId, replyToId, resp.messageId].filter(
          (id): id is number => id != null,
        );
        if (toDelete.length > 0) {
          await scheduleAutoDelete(user.id, chatId, toDelete);
        }
        return;
      }

      if (context.kind === "measure_value") {
        // v1.19.2 — numeric value capture for a measurement reminder. The
        // reminder named on the context row carries the expected metric; the
        // userId is the chat-resolved one (never the payload). A non-numeric
        // / out-of-range reply gets a calm hint, not a write. The reply, the
        // prompt, and the confirmation all self-clean on the ~30-min sweep.
        const reminder = await prisma.measurementReminder.findFirst({
          where: { id: context.refId, userId: user.id, deletedAt: null },
          select: { measurementType: true },
        });
        let confirmation: string;
        if (!isTelegramCapturableType(reminder?.measurementType)) {
          confirmation = t("telegram.measurementNotFound");
        } else {
          const externalId = `telegram:measure:${chatId}:${replyToId}`.slice(
            0,
            120,
          );
          const result = await logTelegramMeasurement({
            userId: user.id,
            type: reminder.measurementType,
            rawText: text,
            tz: user.timezone,
            externalId,
          });
          confirmation =
            result.status === "ok"
              ? t("telegram.measureValueSaved")
              : result.status === "out_of_range"
                ? t("telegram.measureValueOutOfRange")
                : t("telegram.measureValueInvalid");
        }
        const resp = await sendTelegramMessage(botToken, chatId, confirmation);
        const toDelete = [userMsgId, replyToId, resp.messageId].filter(
          (id): id is number => id != null,
        );
        if (toDelete.length > 0) {
          await scheduleAutoDelete(user.id, chatId, toDelete);
        }
        return;
      }

      const attached = await attachTelegramMoodNote({
        userId: user.id,
        moodEntryId: context.refId,
        note: text,
      });
      const resp = await sendTelegramMessage(
        botToken,
        chatId,
        attached
          ? t("telegram.moodNoteSaved")
          : t("telegram.errorInvalidAction"),
      );
      // Self-clean the note, the prompt, and the confirmation in ~30 min.
      const toDelete = [userMsgId, replyToId, resp.messageId].filter(
        (id): id is number => id != null,
      );
      if (toDelete.length > 0) {
        await scheduleAutoDelete(user.id, chatId, toDelete);
      }
      return;
    }
  }

  // Help / start. The slash commands are locale-independent by construction and
  // are what `telegram.helpBody` documents in every bundle. The BARE word is an
  // undocumented convenience that used to know English and German only, so a
  // French user typing "aide" got silence — the handler falls through to the
  // intake keyword and returns without a reply.
  if (
    /^\/help\b/i.test(text) ||
    /^\/start\b/i.test(text) ||
    isBareCommandWord(text, HELP_WORDS)
  ) {
    const userMsgId = message?.message_id;
    const resp = await sendTelegramMessage(
      botToken,
      chatId,
      `${t("telegram.helpHeader")}\n\n${t("telegram.helpBody")}`,
    );
    const toDelete = [userMsgId, resp.messageId].filter(
      (id): id is number => id != null,
    );
    if (toDelete.length > 0) {
      await scheduleAutoDelete(user.id, chatId, toDelete);
    }
    return;
  }

  if (/^\/add\b/i.test(text)) {
    const userMsgId = message?.message_id;
    const meds = await listTelegramDoseMedications(user.id, user.timezone);

    if (meds.length === 0) {
      const resp = await sendTelegramMessage(
        botToken,
        chatId,
        t("telegram.noActiveMedications"),
      );
      const toDelete = [userMsgId, resp.messageId].filter(
        (id): id is number => id != null,
      );
      if (toDelete.length > 0) {
        await scheduleAutoDelete(user.id, chatId, toDelete);
      }
      return;
    }

    if (meds.length === 1) {
      const idempotencyKey =
        `telegram:add:${update.update_id}:${meds[0].id}`.slice(0, 128);
      const result = await markMedicationTaken(
        user.id,
        meds[0].id,
        idempotencyKey,
        locale,
        user.timezone,
      );
      const resp = await sendTelegramMessage(
        botToken,
        chatId,
        result.ok
          ? `${escapeHtml(result.message)}`
          : `${escapeHtml(result.message)}`,
      );
      const toDelete = [userMsgId, resp.messageId].filter(
        (id): id is number => id != null,
      );
      if (toDelete.length > 0) {
        await scheduleAutoDelete(user.id, chatId, toDelete);
      }
      return;
    }

    // Encode user's message ID in callback data so cancel/add can delete it
    const umidSuffix = userMsgId ? `:umid:${userMsgId}` : "";
    const keyboard = {
      inline_keyboard: [
        ...meds.map((med) => [
          {
            text: `${med.name} (${med.dose})`,
            callback_data: `add:${med.id}${umidSuffix}`,
          },
        ]),
        [
          {
            text: t("telegram.cancelButton"),
            callback_data: `cancel_add${umidSuffix}`,
          },
        ],
      ],
    };
    const resp = await sendTelegramMessage(
      botToken,
      chatId,
      t("telegram.whichMedication"),
      { parseMode: "HTML", replyMarkup: keyboard },
    );
    // Fallback auto-delete if user never interacts with the selection
    const toDelete = [userMsgId, resp.messageId].filter(
      (id): id is number => id != null,
    );
    if (toDelete.length > 0) {
      await scheduleAutoDelete(user.id, chatId, toDelete);
    }
    return;
  }

  // Greeting responses (kept locale-independent)
  if (isBareCommandWord(text, GREETING_WORDS)) {
    const userMsgId = message?.message_id;
    const reply = text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
    const resp = await sendTelegramMessage(botToken, chatId, `${reply}! 👋`);
    const toDelete = [userMsgId, resp.messageId].filter(
      (id): id is number => id != null,
    );
    if (toDelete.length > 0) {
      await scheduleAutoDelete(user.id, chatId, toDelete);
    }
    return;
  }

  // Accept both "genommen <name>" (DE) and "taken <name>" (EN) regardless of
  // the user's UI locale — keeps backwards compatibility.
  const intakeKeyword = /^(?:genommen|taken)\b/i;
  if (!intakeKeyword.test(text)) return;

  const userMsgId = message?.message_id;
  const nameInput = text.replace(intakeKeyword, "").trim();

  let medicationId: string | null = null;
  if (nameInput) {
    const where = { name: textEquals(nameInput) };
    const med = await findTelegramDoseMedication(user.id, user.timezone, where);
    medicationId = med?.id ?? null;
  } else {
    const meds = await listTelegramDoseMedications(user.id, user.timezone);
    if (meds.length === 1) {
      medicationId = meds[0].id;
    } else {
      const resp = await sendTelegramMessage(
        botToken,
        chatId,
        t("telegram.askMedicationName"),
      );
      const toDelete = [userMsgId, resp.messageId].filter(
        (id): id is number => id != null,
      );
      if (toDelete.length > 0) {
        await scheduleAutoDelete(user.id, chatId, toDelete);
      }
      return;
    }
  }

  if (!medicationId) {
    const resp = await sendTelegramMessage(
      botToken,
      chatId,
      t("telegram.medicationNotFoundExact"),
    );
    const toDelete = [userMsgId, resp.messageId].filter(
      (id): id is number => id != null,
    );
    if (toDelete.length > 0) {
      await scheduleAutoDelete(user.id, chatId, toDelete);
    }
    return;
  }

  const idempotencyKey =
    `telegram:text:${update.update_id}:${medicationId}`.slice(0, 128);
  const result = await markMedicationTaken(
    user.id,
    medicationId,
    idempotencyKey,
    locale,
    user.timezone,
  );
  const resp = await sendTelegramMessage(
    botToken,
    chatId,
    result.ok
      ? `✅ ${escapeHtml(result.message)}`
      : `⚠️ ${escapeHtml(result.message)}`,
  );
  const toDelete = [userMsgId, resp.messageId].filter(
    (id): id is number => id != null,
  );
  if (toDelete.length > 0) {
    await scheduleAutoDelete(user.id, chatId, toDelete);
  }
}
