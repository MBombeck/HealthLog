import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { decrypt, encrypt } from "@/lib/crypto";
import { sendViaTelegram } from "@/lib/notifications/senders/telegram";
import { sendViaNtfy } from "@/lib/notifications/senders/ntfy";
import { sendViaWebPush } from "@/lib/notifications/senders/web-push";
import { sendApnsTestPush } from "@/lib/push-relay/apns-channel";
import { sendViaWebhook } from "@/lib/notifications/senders/webhook";
import { sendViaEmail } from "@/lib/notifications/senders/email";
import type { SendOutcome } from "@/lib/notifications/retry-policy";
import {
  testFailureDetail,
  testFailureSentence,
  type TestFailureDetail,
} from "@/lib/notifications/test-delivery-failure";
import type {
  TelegramChannelConfig,
  NtfyChannelConfig,
  WebhookChannelConfig,
  EmailChannelConfig,
  ChannelType,
  NotificationPayload,
} from "@/lib/notifications/types";
import { defaultLocale, isLocale, type Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";

export const dynamic = "force-dynamic";

/**
 * Ensure legacy Telegram config (stored on User model) has a matching
 * NotificationChannel record. Returns true if a channel was created.
 */
async function ensureTelegramChannel(userId: string): Promise<boolean> {
  const existing = await prisma.notificationChannel.findUnique({
    where: { userId_type: { userId, type: "TELEGRAM" } },
  });
  if (existing) return false;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      telegramBotToken: true,
      telegramChatId: true,
      telegramEnabled: true,
    },
  });

  if (
    !user?.telegramEnabled ||
    !user.telegramBotToken ||
    !user.telegramChatId
  ) {
    return false;
  }

  const botToken = decrypt(user.telegramBotToken);
  const config = encrypt(
    JSON.stringify({ botToken, chatId: user.telegramChatId }),
  );

  await prisma.notificationChannel.create({
    data: {
      userId,
      type: "TELEGRAM",
      enabled: true,
      config,
    },
  });

  return true;
}

/** The admin toast renders `errorCode` and the status; the relay body stays on the settings card. */
type TestResult = {
  channel: string;
  success: boolean;
  error?: string;
} & Omit<TestFailureDetail, "upstreamBody">;

/**
 * A failed HTTP or SMTP send, with the code, status and SMTP reply code the
 * user-facing test routes answer with, instead of a sentence that drops
 * them. A private-origin refusal forwards its own code.
 */
function failedSend(
  channel: string,
  label: string,
  result: SendOutcome,
): TestResult {
  const { errorCode, upstreamStatus, smtpCode } = result.errorCode
    ? {
        errorCode: result.errorCode,
        upstreamStatus: undefined,
        smtpCode: undefined,
      }
    : testFailureDetail(result);
  const cause = result.errorCode
    ? `refused by the private-origin policy (${result.errorCode})`
    : errorCode
      ? testFailureSentence(label, { errorCode, upstreamStatus, smtpCode })
      : (result.reason ?? "send failed");
  return {
    channel,
    success: false,
    error: cause,
    ...(errorCode ? { errorCode } : {}),
    ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
    ...(smtpCode !== undefined ? { smtpCode } : {}),
  };
}

export const POST = apiHandler(async () => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "admin.notifications.test" } });

  // Auto-migrate legacy Telegram config before querying channels
  const migrated = await ensureTelegramChannel(user.id);
  if (migrated) {
    getEvent()?.addMeta("telegram_migrated", true);
  }

  const channels = await prisma.notificationChannel.findMany({
    where: { userId: user.id, enabled: true },
    include: {
      preferences: { where: { eventType: "SYSTEM_ALERT" } },
    },
  });

  if (channels.length === 0) {
    return apiSuccess({
      sent: false,
      message: "No enabled notification channels found",
      results: [],
    });
  }

  // v1.4.27 — resolve the admin's persisted locale so the test
  // notification arrives in their preferred language. The test route
  // talks to the senders directly (not the dispatcher) because it
  // needs per-channel success / error feedback for the UI, so we
  // compose the payload locally rather than via
  // `dispatchLocalisedNotification`.
  const adminLocaleRow = await prisma.user.findUnique({
    where: { id: user.id },
    select: { locale: true },
  });
  const adminLocale: Locale = isLocale(adminLocaleRow?.locale)
    ? adminLocaleRow.locale
    : defaultLocale;
  const t = getServerTranslator(adminLocale).t;

  const payload: NotificationPayload = {
    eventType: "SYSTEM_ALERT",
    userId: user.id,
    title: t("notifications.admin.testNotificationTitle"),
    message: t("notifications.admin.testNotificationBody"),
  };

  const results: TestResult[] = [];

  for (const channel of channels) {
    const pref = channel.preferences[0];
    if (pref && !pref.enabled) {
      results.push({
        channel: channel.type,
        success: false,
        error: "SYSTEM_ALERT disabled in settings",
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
          const telegramResult = await sendViaTelegram(config, payload);
          success = telegramResult.ok;
          if (!success) {
            results.push({
              channel: "TELEGRAM",
              success: false,
              error: `Telegram API reported error (chatId: ${config.chatId})`,
            });
            continue;
          }
          break;
        }
        case "NTFY": {
          const config = JSON.parse(
            decrypt(channel.config),
          ) as NtfyChannelConfig;
          const ntfyResult = await sendViaNtfy(config, payload);
          success = ntfyResult.ok;
          if (!success) {
            // The topic is not echoed: on a public server it is the secret.
            results.push(failedSend("NTFY", "The ntfy server", ntfyResult));
            continue;
          }
          break;
        }
        // The generic webhook and email are first-class channels in the
        // dispatcher; without these arms they reported "Unknown channel type".
        case "WEBHOOK": {
          const config = JSON.parse(
            decrypt(channel.config),
          ) as WebhookChannelConfig;
          const webhookResult = await sendViaWebhook(config, payload);
          success = webhookResult.ok;
          if (!success) {
            results.push(failedSend("WEBHOOK", "The webhook", webhookResult));
            continue;
          }
          break;
        }
        case "EMAIL": {
          const config = JSON.parse(
            decrypt(channel.config),
          ) as EmailChannelConfig;
          const emailResult = await sendViaEmail(config, payload);
          success = emailResult.ok;
          if (!success) {
            results.push(failedSend("EMAIL", "The mail server", emailResult));
            continue;
          }
          break;
        }
        case "WEB_PUSH": {
          const webPushResult = await sendViaWebPush(user.id, payload);
          success = webPushResult.ok;
          break;
        }
        // v1.4.46 — APNs was missing from the admin-test switch even
        // though the dispatcher already routes the same payload to the
        // sender in production. It takes the dispatcher's channel
        // (`sendApnsTestPush`), so a device with a push key gets the test
        // sealed and only a device without one gets it in plaintext.
        case "APNS": {
          const apnsResult = await sendApnsTestPush(user.id, {
            title: payload.title,
            message: payload.message,
            eventType: payload.eventType,
            metadata: payload.metadata,
          });
          success = apnsResult.ok;
          if (!success) {
            results.push({
              channel: "APNS",
              success: false,
              error: apnsResult.reason ?? "apns_send_failed",
            });
            continue;
          }
          break;
        }
        default:
          results.push({
            channel: type,
            success: false,
            error: "Unknown channel type",
          });
          continue;
      }

      results.push({ channel: type, success });
    } catch (err) {
      results.push({
        channel: channel.type,
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  let message: string;
  if (failCount === 0) {
    message = `All ${successCount} channels successful`;
  } else if (successCount === 0) {
    message = `All ${failCount} channels failed`;
  } else {
    message = `${successCount} successful, ${failCount} failed`;
  }

  return apiSuccess({ sent: successCount > 0, message, results });
});
