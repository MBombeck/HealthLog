import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import {
  answerTelegramCallbackQuery,
  editMessageReplyMarkup,
  sendTelegramMessage,
} from "@/lib/telegram";
import { NextRequest, NextResponse } from "next/server";

interface TelegramUpdate {
  update_id: number;
  message?: {
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
  if (!expected) return true;
  const received = request.headers.get("x-telegram-bot-api-secret-token");
  return received === expected;
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
    },
  });
}

async function markMedicationTaken(
  userId: string,
  medicationId: string,
  idempotencyKey: string,
): Promise<{ ok: boolean; message: string; medicationName?: string }> {
  const medication = await prisma.medication.findFirst({
    where: { id: medicationId, userId, active: true },
    select: { id: true, name: true },
  });
  if (!medication) {
    return { ok: false, message: "Medikament nicht gefunden oder inaktiv." };
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
      ? `${medication.name} war bereits erfasst.`
      : `${medication.name} als eingenommen erfasst.`,
    medicationName: medication.name,
  };
}

async function removeButtons(
  botToken: string,
  chatId: string,
  messageId: number | undefined,
) {
  if (messageId) {
    await editMessageReplyMarkup(botToken, chatId, messageId);
  }
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

  const data = callback.data ?? "";
  const messageId = callback.message?.message_id;

  if (data.startsWith("taken:")) {
    const medicationId = data.slice("taken:".length).trim();
    if (!medicationId) {
      await answerTelegramCallbackQuery(botToken, callback.id, "Ungültige Aktion.");
      return;
    }

    const msgId = messageId ?? "na";
    const idempotencyKey =
      `telegram:cb:${chatId}:${msgId}:${medicationId}`.slice(0, 128);

    const result = await markMedicationTaken(user.id, medicationId, idempotencyKey);
    await answerTelegramCallbackQuery(botToken, callback.id, result.message);
    await removeButtons(botToken, chatId, messageId);
    await sendTelegramMessage(
      botToken,
      chatId,
      result.ok
        ? `✅ ${escapeHtml(result.message)}`
        : `⚠️ ${escapeHtml(result.message)}`,
    );
  } else if (data.startsWith("snooze:")) {
    // Format: "snooze:{medicationId}:{minutes}"
    const parts = data.split(":");
    const medicationId = parts[1];
    const minutes = parseInt(parts[2], 10);
    if (!medicationId || !Number.isFinite(minutes)) {
      await answerTelegramCallbackQuery(botToken, callback.id, "Ungültige Aktion.");
      return;
    }

    const medication = await prisma.medication.findFirst({
      where: { id: medicationId, userId: user.id, active: true },
      select: { id: true, name: true },
    });
    if (!medication) {
      await answerTelegramCallbackQuery(botToken, callback.id, "Medikament nicht gefunden.");
      return;
    }

    await prisma.medication.update({
      where: { id: medication.id },
      data: { snoozedUntil: new Date(Date.now() + minutes * 60000) },
    });

    const label = minutes <= 60 ? "1 Stunde" : "3 Stunden";
    await answerTelegramCallbackQuery(botToken, callback.id, `Für ${label} zurückgestellt.`);
    await removeButtons(botToken, chatId, messageId);
    await sendTelegramMessage(
      botToken,
      chatId,
      `🔕 ${escapeHtml(medication.name)} für ${label} zurückgestellt.`,
    );
  } else if (data.startsWith("skip:")) {
    const medicationId = data.slice("skip:".length).trim();
    if (!medicationId) {
      await answerTelegramCallbackQuery(botToken, callback.id, "Ungültige Aktion.");
      return;
    }

    const medication = await prisma.medication.findFirst({
      where: { id: medicationId, userId: user.id, active: true },
      select: { id: true, name: true },
    });
    if (!medication) {
      await answerTelegramCallbackQuery(botToken, callback.id, "Medikament nicht gefunden.");
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
      `${medication.name} übersprungen.`,
    );
    await removeButtons(botToken, chatId, messageId);
    await sendTelegramMessage(
      botToken,
      chatId,
      `⏭ ${escapeHtml(medication.name)} für heute übersprungen.`,
    );
  } else {
    await answerTelegramCallbackQuery(botToken, callback.id, "Unbekannte Aktion.");
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

  if (/^\/start\b/i.test(text) || /^hilfe$/i.test(text)) {
    await sendTelegramMessage(
      botToken,
      chatId,
      "HealthLog Bot: Sende <b>genommen MedikamentName</b> oder nutze den Button in einer Erinnerung.",
    );
    return;
  }

  if (!/^genommen\b/i.test(text)) return;

  const nameInput = text.replace(/^genommen\b/i, "").trim();

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
      await sendTelegramMessage(
        botToken,
        chatId,
        "Bitte Medikament angeben, z.B. <b>genommen Ramipril</b>.",
      );
      return;
    }
  }

  if (!medicationId) {
    await sendTelegramMessage(
      botToken,
      chatId,
      "Medikament nicht gefunden. Bitte Namen exakt wie in HealthLog senden.",
    );
    return;
  }

  const idempotencyKey =
    `telegram:text:${update.update_id}:${medicationId}`.slice(0, 128);
  const result = await markMedicationTaken(
    user.id,
    medicationId,
    idempotencyKey,
  );
  await sendTelegramMessage(
    botToken,
    chatId,
    result.ok
      ? `✅ ${escapeHtml(result.message)}`
      : `⚠️ ${escapeHtml(result.message)}`,
  );
}

export async function POST(request: NextRequest) {
  if (!hasValidSecret(request)) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  }

  try {
    const update = (await request.json()) as TelegramUpdate;
    if (!update || typeof update.update_id !== "number") {
      return NextResponse.json({ status: "ignored" }, { status: 200 });
    }

    if (update.callback_query) {
      await handleCallback(update);
      return NextResponse.json({ status: "ok" }, { status: 200 });
    }

    if (update.message?.text) {
      await handleTextMessage(update);
      return NextResponse.json({ status: "ok" }, { status: 200 });
    }

    return NextResponse.json({ status: "ignored" }, { status: 200 });
  } catch (err) {
    console.error("[telegram] webhook error:", err);
    return NextResponse.json({ status: "error" }, { status: 200 });
  }
}

export async function GET(request: NextRequest) {
  if (!hasValidSecret(request)) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
