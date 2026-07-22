import { prisma } from "@/lib/db";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { decrypt, encrypt } from "@/lib/crypto";
import { deleteTelegramWebhook, setTelegramWebhook } from "@/lib/telegram";
import { telegramSettingsSchema } from "@/lib/validations/telegram";
import { notificationChannelEnabledSchema } from "@/lib/validations/notifications";
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

/**
 * Get Telegram notification settings for the current user.
 * Never returns the bot token in plaintext.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      telegramBotToken: true,
      telegramChatId: true,
      telegramEnabled: true,
    },
  });

  annotate({ action: { name: "settings.telegram.get" } });

  return apiSuccess({
    enabled: dbUser?.telegramEnabled ?? false,
    hasBotToken: !!dbUser?.telegramBotToken,
    chatId: dbUser?.telegramChatId ?? null,
  });
});

async function registerTelegramWebhook(botToken: string) {
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    return apiError(
      "Server configuration error: APP_URL (or NEXT_PUBLIC_APP_URL) is missing.",
      500,
    );
  }

  let appBaseUrl: URL;
  try {
    appBaseUrl = new URL(appUrl);
  } catch {
    return apiError("Server configuration error: APP_URL is invalid.", 500);
  }

  if (appBaseUrl.protocol !== "https:") {
    return apiError(
      "Telegram webhook requires a public HTTPS URL (no http/localhost).",
      422,
    );
  }

  const localHosts: Record<string, true> = {
    localhost: true,
    "127.0.0.1": true,
    "::1": true,
  };
  if (localHosts[appBaseUrl.hostname.toLowerCase()]) {
    return apiError(
      "Telegram webhook requires a publicly reachable domain (localhost is not allowed).",
      422,
    );
  }

  if (
    appBaseUrl.port &&
    !["80", "88", "443", "8443"].includes(appBaseUrl.port)
  ) {
    return apiError(
      "Telegram webhook only allows ports 80, 88, 443, or 8443.",
      422,
    );
  }

  const webhookUrl = new URL("/api/telegram/webhook", appBaseUrl).toString();
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const ok = await setTelegramWebhook(botToken, webhookUrl, webhookSecret);
  if (!ok) {
    return apiError(
      "Failed to set Telegram webhook. Check bot token and reachability.",
      422,
    );
  }

  return null;
}

/**
 * Update Telegram notification settings.
 */
export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const current = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      telegramBotToken: true,
      telegramChatId: true,
      telegramEnabled: true,
    },
  });
  if (!current) return apiError("User not found", 404);

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });

  if (jsonError) return jsonError;

  const enabledOnly = notificationChannelEnabledSchema.safeParse(body);
  if (enabledOnly.success) {
    const { enabled } = enabledOnly.data;
    if (enabled && (!current.telegramBotToken || !current.telegramChatId)) {
      return apiError(
        "Bot token and chat ID are required when Telegram is enabled",
        422,
      );
    }

    const currentTokenPlain = current.telegramBotToken
      ? decrypt(current.telegramBotToken)
      : null;
    if (enabled && currentTokenPlain) {
      const webhookError = await registerTelegramWebhook(currentTokenPlain);
      if (webhookError) return webhookError;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { telegramEnabled: enabled },
    });
    await prisma.notificationChannel.updateMany({
      where: { userId: user.id, type: "TELEGRAM" },
      data: { enabled },
    });

    if (!enabled && currentTokenPlain) {
      await deleteTelegramWebhook(currentTokenPlain).catch(() => {});
    }

    annotate({
      action: { name: "settings.telegram.update" },
      meta: { enabled },
    });
    return apiSuccess({ updated: true });
  }

  const result = z.safeParse(telegramSettingsSchema, body);
  if (!result.success) {
    return apiError("Invalid input", 422);
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
      "Bot token and chat ID are required when Telegram is enabled",
      422,
    );
  }

  const currentTokenPlain = current.telegramBotToken
    ? decrypt(current.telegramBotToken)
    : null;
  const tokenForWebhook = trimmedToken || currentTokenPlain;

  if (enabled && tokenForWebhook) {
    const webhookError = await registerTelegramWebhook(tokenForWebhook);
    if (webhookError) return webhookError;
  }

  const data: Record<string, unknown> = { telegramEnabled: enabled };

  if (botToken !== undefined) {
    data.telegramBotToken = trimmedToken ? encrypt(trimmedToken) : null;
  }

  if (chatId !== undefined) {
    data.telegramChatId = trimmedChatId || null;
  }

  await prisma.user.update({
    where: { id: user.id },
    data,
  });

  // Sync to NotificationChannel so the dispatcher can find Telegram
  const finalToken = trimmedToken ? trimmedToken : currentTokenPlain;
  const finalChatId = trimmedChatId ?? current.telegramChatId;

  if (finalToken && finalChatId) {
    const channelConfig = encrypt(
      JSON.stringify({ botToken: finalToken, chatId: finalChatId }),
    );
    await prisma.notificationChannel.upsert({
      where: {
        userId_type: {
          userId: user.id,
          type: "TELEGRAM",
        },
      },
      create: {
        userId: user.id,
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
        userId: user.id,
        type: "TELEGRAM",
      },
    });
  }

  if (!enabled && tokenForWebhook) {
    await deleteTelegramWebhook(tokenForWebhook).catch(() => {});
  }

  annotate({ action: { name: "settings.telegram.update" }, meta: { enabled } });

  return apiSuccess({ updated: true });
});
