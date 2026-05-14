import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { apiSuccess, apiError } from "@/lib/api-response";
import { notificationPreferenceSchema } from "@/lib/validations/notifications";
import { EVENT_TYPES, CHANNEL_TYPE_LABELS } from "@/lib/notifications/types";
import type { ChannelType } from "@/lib/notifications/types";
import { decrypt, encrypt } from "@/lib/crypto";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "notifications.preferences.get" } });

  const appSettings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });

  const globalToggles: Record<string, boolean> = {
    TELEGRAM: appSettings?.telegramGlobal ?? true,
    NTFY: appSettings?.ntfyGlobal ?? true,
    WEB_PUSH: appSettings?.webPushGlobal ?? true,
  };

  const channels = await prisma.notificationChannel.findMany({
    where: { userId: user.id },
    include: { preferences: true },
  });

  // Auto-migrate legacy Telegram config from User model if no channel record exists
  const hasTelegramChannel = channels.some((ch) => ch.type === "TELEGRAM");
  if (!hasTelegramChannel) {
    try {
      const legacyUser = await prisma.user.findUnique({
        where: { id: user.id },
        select: {
          telegramBotToken: true,
          telegramChatId: true,
          telegramEnabled: true,
        },
      });

      if (legacyUser?.telegramBotToken && legacyUser.telegramChatId) {
        const botToken = decrypt(legacyUser.telegramBotToken);
        const channelConfig = encrypt(
          JSON.stringify({ botToken, chatId: legacyUser.telegramChatId }),
        );

        const created = await prisma.notificationChannel.upsert({
          where: {
            userId_type: { userId: user.id, type: "TELEGRAM" },
          },
          create: {
            userId: user.id,
            type: "TELEGRAM",
            enabled: legacyUser.telegramEnabled ?? true,
            config: channelConfig,
          },
          update: {},
          include: { preferences: true },
        });

        channels.push(created);
      }
    } catch {
      getEvent()?.addWarning("Legacy Telegram migration failed");
    }
  }

  const channelData = channels.map((ch) => ({
    id: ch.id,
    type: ch.type,
    label: CHANNEL_TYPE_LABELS[ch.type as ChannelType] ?? ch.type,
    enabled: ch.enabled,
    globallyEnabled: globalToggles[ch.type] ?? true,
  }));

  const preferences = channels.flatMap((ch) =>
    ch.preferences.map((p) => ({
      channelId: p.channelId,
      eventType: p.eventType,
      enabled: p.enabled,
    })),
  );

  return apiSuccess({
    channels: channelData,
    preferences,
    eventTypes: EVENT_TYPES as unknown as string[],
  });
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "notifications.preferences.update" } });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("Invalid JSON data", 422);
  }

  const parsed = notificationPreferenceSchema.safeParse(body);
  if (!parsed.success) return apiError("Invalid data", 422);

  const { channelId, eventType, enabled } = parsed.data;

  const channel = await prisma.notificationChannel.findFirst({
    where: { id: channelId, userId: user.id },
  });
  if (!channel) return apiError("Channel not found", 404);

  const preference = await prisma.notificationPreference.upsert({
    where: {
      channelId_eventType: { channelId, eventType },
    },
    create: { channelId, eventType, enabled },
    update: { enabled },
  });

  return apiSuccess({
    channelId: preference.channelId,
    eventType: preference.eventType,
    enabled: preference.enabled,
  });
});
