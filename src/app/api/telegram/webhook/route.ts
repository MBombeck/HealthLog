import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import {
  answerTelegramCallbackQuery,
  deleteMessage,
  sendTelegramMessage,
} from "@/lib/telegram";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-response";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { locales, type Locale } from "@/lib/i18n/config";

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id: number | string };
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

function hasValidSecret(request: NextRequest): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) {
    getEvent()?.addWarning("TELEGRAM_WEBHOOK_SECRET not configured");
    return false;
  }
  const received = request.headers.get("x-telegram-bot-api-secret-token");
  if (!received) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
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

async function cleanupReminderTracking(medicationId: string): Promise<void> {
  try {
    await prisma.telegramReminderMessage.deleteMany({
      where: { medicationId },
    });
  } catch {
    // Best-effort cleanup
  }
}

const AUTO_DELETE_DELAY_MS = 60 * 60 * 1000; // 1 hour

async function scheduleAutoDelete(
  userId: string,
  chatId: string,
  messageIds: number[],
): Promise<void> {
  const deleteAfter = new Date(Date.now() + AUTO_DELETE_DELAY_MS);
  try {
    await prisma.telegramScheduledDeletion.createMany({
      data: messageIds.map((messageId) => ({
        userId,
        chatId,
        messageId,
        deleteAfter,
      })),
    });
  } catch {
    // Best-effort
  }
}

async function findTelegramUser(chatId: string) {
  return prisma.user.findFirst({
    where: {
      telegramEnabled: true,
      telegramChatId: chatId,
      telegramBotToken: { not: null },
    },
    select: {
      id: true,
      telegramBotToken: true,
      locale: true,
    },
  });
}

async function markMedicationTaken(
  userId: string,
  medicationId: string,
  idempotencyKey: string,
  locale: Locale,
): Promise<{ ok: boolean; message: string; medicationName?: string }> {
  const { t } = getServerTranslator(locale);
  const medication = await prisma.medication.findFirst({
    where: { id: medicationId, userId, active: true },
    select: { id: true, name: true },
  });
  if (!medication) {
    return { ok: false, message: t("telegram.errorMedicationInactive") };
  }

  const existing = await prisma.medicationIntakeEvent.findFirst({
    where: { userId, medicationId: medication.id, idempotencyKey },
    select: { id: true },
  });

  if (!existing) {
    await prisma.$transaction([
      prisma.medicationIntakeEvent.create({
        data: {
          userId,
          medicationId: medication.id,
          scheduledFor: new Date(),
          takenAt: new Date(),
          skipped: false,
          source: "REMINDER",
          idempotencyKey,
        },
      }),
      prisma.medication.update({
        where: { id: medication.id },
        data: { snoozedUntil: null },
      }),
    ]);
  }

  return {
    ok: true,
    message: existing
      ? t("telegram.alreadyRecorded", { name: medication.name })
      : t("telegram.recordedAsTaken", { name: medication.name }),
    medicationName: medication.name,
  };
}

async function handleCallback(update: TelegramUpdate) {
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
    );
    await answerTelegramCallbackQuery(botToken, callback.id, result.message);
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
    await cleanupReminderTracking(medicationId);
  } else if (data.startsWith("snooze:")) {
    // Format: "snooze:{medicationId}:{minutes}"
    const parts = data.split(":");
    const medicationId = parts[1];
    const minutes = parseInt(parts[2], 10);
    if (!medicationId || !Number.isFinite(minutes)) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorInvalidAction"),
      );
      return;
    }

    const medication = await prisma.medication.findFirst({
      where: { id: medicationId, userId: user.id, active: true },
      select: { id: true, name: true },
    });
    if (!medication) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorMedicationNotFound"),
      );
      return;
    }

    await prisma.medication.update({
      where: { id: medication.id },
      data: { snoozedUntil: new Date(Date.now() + minutes * 60000) },
    });

    const duration =
      minutes <= 60 ? t("telegram.snoozeOneHour") : t("telegram.snoozeThreeHours");
    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.snoozedFor", { name: medication.name, duration }),
    );
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
    await cleanupReminderTracking(medicationId);
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

    const medication = await prisma.medication.findFirst({
      where: { id: medicationId, userId: user.id, active: true },
      select: { id: true, name: true },
    });
    if (!medication) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorMedicationNotFound"),
      );
      return;
    }

    const msgId = messageId ?? "na";
    const idempotencyKey =
      `telegram:skip:${chatId}:${msgId}:${medicationId}`.slice(0, 128);

    const existing = await prisma.medicationIntakeEvent.findFirst({
      where: { userId: user.id, medicationId: medication.id, idempotencyKey },
      select: { id: true },
    });

    if (!existing) {
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);

      await prisma.$transaction([
        prisma.medicationIntakeEvent.create({
          data: {
            userId: user.id,
            medicationId: medication.id,
            scheduledFor: new Date(),
            takenAt: null,
            skipped: true,
            source: "REMINDER",
            idempotencyKey,
          },
        }),
        prisma.medication.update({
          where: { id: medication.id },
          data: { snoozedUntil: endOfDay },
        }),
      ]);
    }

    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.skipped", { name: medication.name }),
    );
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
    await cleanupReminderTracking(medicationId);
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
    await cleanupReminderTracking(medicationId);
  } else if (data.startsWith("add:")) {
    // Format: "add:{medicationId}" or "add:{medicationId}:umid:{userMsgId}"
    const withoutPrefix = data.slice("add:".length);
    const umidIdx = withoutPrefix.indexOf(":umid:");
    const medicationId = umidIdx >= 0 ? withoutPrefix.slice(0, umidIdx) : withoutPrefix.trim();
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
    await answerTelegramCallbackQuery(botToken, callback.id, t("telegram.cancelled"));
  } else {
    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.errorUnknownAction"),
    );
  }
}

async function handleTextMessage(update: TelegramUpdate) {
  const message = update.message;
  const text = message?.text?.trim();
  const chatId = toChatId(message?.chat?.id);
  if (!text || !chatId) return;

  const user = await findTelegramUser(chatId);
  if (!user?.telegramBotToken) return;
  const botToken = decrypt(user.telegramBotToken);
  const locale = resolveBotLocale(user.locale);
  const { t } = getServerTranslator(locale);

  // "Help" / start: accept English + German keyword aliases independent of locale
  if (
    /^\/help\b/i.test(text) ||
    /^\/start\b/i.test(text) ||
    /^hilfe$/i.test(text) ||
    /^help$/i.test(text)
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
    const meds = await prisma.medication.findMany({
      where: { userId: user.id, active: true },
      select: { id: true, name: true, dose: true },
      orderBy: { name: "asc" },
    });

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
  const greetings = ["hi", "hallo", "hey", "moin", "hello"];
  const lowerText = text.toLowerCase();
  const matchedGreeting = greetings.find((g) => lowerText === g);
  if (matchedGreeting) {
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
    const med = await prisma.medication.findFirst({
      where: {
        userId: user.id,
        active: true,
        name: { equals: nameInput, mode: "insensitive" },
      },
      select: { id: true },
    });
    medicationId = med?.id ?? null;
  } else {
    const meds = await prisma.medication.findMany({
      where: { userId: user.id, active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 2,
    });
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

export const POST = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "telegram.webhook" } });

  const ip = getClientIp(request);
  const rl = await checkRateLimit(`telegram-webhook:${ip}`, 120, 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { status: "rate_limited" },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  if (!hasValidSecret(request)) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  }

  getEvent()?.setAuth({ auth_method: "telegram_webhook" });

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ status: "invalid json" }, { status: 200 });
  }
  if (!update || typeof update.update_id !== "number") {
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  annotate({ meta: { update_id: update.update_id } });

  if (update.callback_query) {
    await handleCallback(update);
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  if (update.message?.text) {
    await handleTextMessage(update);
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  return NextResponse.json({ status: "ignored" }, { status: 200 });
});

export const GET = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "telegram.webhook.verify" } });

  if (!hasValidSecret(request)) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  }
  getEvent()?.setAuth({ auth_method: "telegram_webhook" });
  return NextResponse.json({ status: "ok" }, { status: 200 });
});
