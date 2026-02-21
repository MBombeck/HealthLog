import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { decrypt, encrypt } from "@/lib/crypto";
import { deleteTelegramWebhook, setTelegramWebhook } from "@/lib/telegram";
import { telegramSettingsSchema } from "@/lib/validations/telegram";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

/**
 * Get Telegram notification settings for the current user.
 * Never returns the bot token in plaintext.
 */
export async function GET() {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const user = await prisma.user.findUnique({
    where: { id: sessionData.user.id },
    select: {
      telegramBotToken: true,
      telegramChatId: true,
      telegramEnabled: true,
    },
  });

  return apiSuccess({
    enabled: user?.telegramEnabled ?? false,
    hasBotToken: !!user?.telegramBotToken,
    chatId: user?.telegramChatId ?? null,
  });
}

/**
 * Update Telegram notification settings.
 */
export async function PUT(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const current = await prisma.user.findUnique({
    where: { id: sessionData.user.id },
    select: {
      telegramBotToken: true,
      telegramChatId: true,
      telegramEnabled: true,
    },
  });
  if (!current) return apiError("Benutzer nicht gefunden", 404);

  const body = await request.json();
  const result = z.safeParse(telegramSettingsSchema, body);
  if (!result.success) {
    return apiError("Ungültige Eingabe", 422);
  }

  const { botToken, chatId, enabled } = result.data;
  const trimmedToken = botToken?.trim();
  const trimmedChatId = chatId?.trim();

  const hasTokenAfter =
    botToken !== undefined ? !!trimmedToken : !!current.telegramBotToken;
  const hasChatIdAfter =
    chatId !== undefined ? !!trimmedChatId : !!current.telegramChatId;

  if (enabled && (!hasTokenAfter || !hasChatIdAfter)) {
    return apiError(
      "Für aktiviertes Telegram werden Bot-Token und Chat-ID benötigt",
      422,
    );
  }

  const currentTokenPlain = current.telegramBotToken
    ? decrypt(current.telegramBotToken)
    : null;
  const tokenForWebhook = trimmedToken || currentTokenPlain;

  if (enabled && tokenForWebhook) {
    const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
    if (!appUrl) {
      return apiError(
        "Server-Konfiguration fehlerhaft: APP_URL (oder NEXT_PUBLIC_APP_URL) fehlt.",
        500,
      );
    }

    let appBaseUrl: URL;
    try {
      appBaseUrl = new URL(appUrl);
    } catch {
      return apiError(
        "Server-Konfiguration fehlerhaft: APP_URL ist ungültig.",
        500,
      );
    }

    if (appBaseUrl.protocol !== "https:") {
      return apiError(
        "Telegram-Webhook benötigt eine öffentliche HTTPS-URL (kein http/localhost).",
        422,
      );
    }

    const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
    if (localHosts.has(appBaseUrl.hostname.toLowerCase())) {
      return apiError(
        "Telegram-Webhook benötigt eine öffentlich erreichbare Domain (localhost ist nicht erlaubt).",
        422,
      );
    }

    if (
      appBaseUrl.port &&
      !["80", "88", "443", "8443"].includes(appBaseUrl.port)
    ) {
      return apiError(
        "Telegram-Webhook erlaubt nur die Ports 80, 88, 443 oder 8443.",
        422,
      );
    }

    const webhookUrl = new URL("/api/telegram/webhook", appBaseUrl).toString();
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const ok = await setTelegramWebhook(
      tokenForWebhook,
      webhookUrl,
      webhookSecret,
    );
    if (!ok) {
      return apiError(
        "Telegram-Webhook konnte nicht gesetzt werden. Prüfe Bot-Token und Erreichbarkeit.",
        422,
      );
    }
  }

  const data: Record<string, unknown> = { telegramEnabled: enabled };

  if (botToken !== undefined) {
    data.telegramBotToken = trimmedToken ? encrypt(trimmedToken) : null;
  }

  if (chatId !== undefined) {
    data.telegramChatId = trimmedChatId || null;
  }

  await prisma.user.update({
    where: { id: sessionData.user.id },
    data,
  });

  // Sync to NotificationChannel so the dispatcher can find Telegram
  const finalToken = trimmedToken
    ? trimmedToken
    : currentTokenPlain;
  const finalChatId = trimmedChatId ?? current.telegramChatId;

  if (finalToken && finalChatId) {
    const channelConfig = encrypt(
      JSON.stringify({ botToken: finalToken, chatId: finalChatId }),
    );
    await prisma.notificationChannel.upsert({
      where: {
        userId_type: {
          userId: sessionData.user.id,
          type: "TELEGRAM",
        },
      },
      create: {
        userId: sessionData.user.id,
        type: "TELEGRAM",
        enabled,
        config: channelConfig,
      },
      update: {
        enabled,
        config: channelConfig,
      },
    });
  } else if (!enabled) {
    // Remove the channel record if disabled and no credentials
    await prisma.notificationChannel.deleteMany({
      where: {
        userId: sessionData.user.id,
        type: "TELEGRAM",
      },
    });
  }

  if (!enabled && tokenForWebhook) {
    await deleteTelegramWebhook(tokenForWebhook).catch(() => {});
  }

  return apiSuccess({ updated: true });
}
