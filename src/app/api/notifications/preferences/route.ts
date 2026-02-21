import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { notificationPreferenceSchema } from "@/lib/validations/notifications";
import { EVENT_TYPES, CHANNEL_TYPE_LABELS } from "@/lib/notifications/types";
import type { ChannelType } from "@/lib/notifications/types";
import { decrypt, encrypt } from "@/lib/crypto";

export async function GET() {
  const session = await getSession();
  if (!session) return apiError("Nicht angemeldet", 401);

  const appSettings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });

  const globalToggles: Record<string, boolean> = {
    TELEGRAM: appSettings?.telegramGlobal ?? true,
    NTFY: appSettings?.ntfyGlobal ?? true,
    WEB_PUSH: appSettings?.webPushGlobal ?? true,
  };

  const channels = await prisma.notificationChannel.findMany({
    where: { userId: session.user.id },
    include: { preferences: true },
  });

  // Auto-migrate legacy Telegram config from User model if no channel record exists
  const hasTelegramChannel = channels.some((ch) => ch.type === "TELEGRAM");
  if (!hasTelegramChannel) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: {
          telegramBotToken: true,
          telegramChatId: true,
          telegramEnabled: true,
        },
      });

      if (user?.telegramBotToken && user.telegramChatId) {
        const botToken = decrypt(user.telegramBotToken);
        const channelConfig = encrypt(
          JSON.stringify({ botToken, chatId: user.telegramChatId }),
        );

        const created = await prisma.notificationChannel.upsert({
          where: {
            userId_type: { userId: session.user.id, type: "TELEGRAM" },
          },
          create: {
            userId: session.user.id,
            type: "TELEGRAM",
            enabled: user.telegramEnabled ?? true,
            config: channelConfig,
          },
          update: {},
          include: { preferences: true },
        });

        channels.push(created);
      }
    } catch (err) {
      console.error("[preferences] Legacy Telegram migration failed:", err);
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
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session) return apiError("Nicht angemeldet", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("Ungültige JSON-Daten", 422);
  }

  const parsed = notificationPreferenceSchema.safeParse(body);
  if (!parsed.success) return apiError("Ungültige Daten", 422);

  const { channelId, eventType, enabled } = parsed.data;

  const channel = await prisma.notificationChannel.findFirst({
    where: { id: channelId, userId: session.user.id },
  });
  if (!channel) return apiError("Kanal nicht gefunden", 404);

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
}
