import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/session";
import { apiError, apiSuccess } from "@/lib/api-response";
import { decrypt } from "@/lib/crypto";
import { sendViaTelegram } from "@/lib/notifications/senders/telegram";
import { sendViaNtfy } from "@/lib/notifications/senders/ntfy";
import { sendViaWebPush } from "@/lib/notifications/senders/web-push";
import type {
  TelegramChannelConfig,
  NtfyChannelConfig,
  ChannelType,
  NotificationPayload,
} from "@/lib/notifications/types";

export const dynamic = "force-dynamic";

export async function POST() {
  const admin = await requireAdmin();
  if (!admin) return apiError("Nicht berechtigt", 403);

  try {
    const channels = await prisma.notificationChannel.findMany({
      where: { userId: admin.id, enabled: true },
      include: {
        preferences: { where: { eventType: "SYSTEM_ALERT" } },
      },
    });

    if (channels.length === 0) {
      return apiSuccess({
        sent: false,
        message: "Keine aktivierten Benachrichtigungskanäle gefunden",
        results: [],
      });
    }

    const payload: NotificationPayload = {
      eventType: "SYSTEM_ALERT",
      userId: admin.id,
      title: "Test-Notification",
      message:
        "<b>HealthLog Test:</b> Wenn du diese Nachricht siehst, funktionieren deine Benachrichtigungen!",
    };

    const results: Array<{
      channel: string;
      success: boolean;
      error?: string;
    }> = [];

    for (const channel of channels) {
      const pref = channel.preferences[0];
      if (pref && !pref.enabled) {
        results.push({
          channel: channel.type,
          success: false,
          error: "SYSTEM_ALERT deaktiviert in Einstellungen",
        });
        continue;
      }

      try {
        const type = channel.type as ChannelType;
        let success = false;

        switch (type) {
          case "TELEGRAM": {
            const config = JSON.parse(
              decrypt(channel.config),
            ) as TelegramChannelConfig;
            success = await sendViaTelegram(config, payload);
            if (!success) {
              results.push({
                channel: "TELEGRAM",
                success: false,
                error: `Senden fehlgeschlagen (chatId: ${config.chatId})`,
              });
              continue;
            }
            break;
          }
          case "NTFY": {
            const config = JSON.parse(
              decrypt(channel.config),
            ) as NtfyChannelConfig;
            success = await sendViaNtfy(config, payload);
            if (!success) {
              results.push({
                channel: "NTFY",
                success: false,
                error: `Senden fehlgeschlagen (topic: ${config.topic})`,
              });
              continue;
            }
            break;
          }
          case "WEB_PUSH": {
            success = await sendViaWebPush(admin.id, payload);
            break;
          }
          default:
            results.push({
              channel: type,
              success: false,
              error: "Unbekannter Kanaltyp",
            });
            continue;
        }

        results.push({ channel: type, success });
      } catch (err) {
        results.push({
          channel: channel.type,
          success: false,
          error: err instanceof Error ? err.message : "Unbekannter Fehler",
        });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    let message: string;
    if (failCount === 0) {
      message = `Alle ${successCount} Kanäle erfolgreich`;
    } else if (successCount === 0) {
      message = `Alle ${failCount} Kanäle fehlgeschlagen`;
    } else {
      message = `${successCount} erfolgreich, ${failCount} fehlgeschlagen`;
    }

    return apiSuccess({ sent: successCount > 0, message, results });
  } catch (error) {
    console.error("Notification test failed:", error);
    return apiError("Test-Notification konnte nicht gesendet werden", 500);
  }
}
