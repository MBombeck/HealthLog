import { prisma } from "@/lib/db";
import { apiSuccess, apiError } from "@/lib/api-response";
import { decrypt } from "@/lib/crypto";
import { sendTelegramMessage } from "@/lib/telegram";
import { checkRateLimit } from "@/lib/rate-limit";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { defaultLocale, type Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";

function isLocale(value: string | null | undefined): value is Locale {
  return value === "de" || value === "en" || value === "fr" ||
    value === "es" || value === "it" || value === "pl";
}

/**
 * Send a test Telegram message to verify the bot token and chat ID.
 */
export const POST = apiHandler(async () => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(`telegram-test:${user.id}`, 5, 5 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 5 tests in 5 minutes", 429);
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { telegramBotToken: true, telegramChatId: true, locale: true },
  });

  if (!dbUser?.telegramBotToken || !dbUser?.telegramChatId) {
    return apiError("Bot token and chat ID must be saved first", 422);
  }

  // v1.4.27 F21 — the test body now reads from the user's persisted
  // locale rather than the hardcoded English string. The route talks
  // to `sendTelegramMessage` directly (it needs the boolean send
  // result for the UI) so we compose the body via the server
  // translator rather than going through the dispatcher.
  const userLocale: Locale = isLocale(dbUser.locale)
    ? dbUser.locale
    : defaultLocale;
  const t = getServerTranslator(userLocale).t;
  const botToken = decrypt(dbUser.telegramBotToken);
  const result = await sendTelegramMessage(
    botToken,
    dbUser.telegramChatId,
    t("notifications.user.telegramTestBody"),
  );

  if (!result.ok) {
    return apiError(
      "Failed to send message. Check bot token and chat ID.",
      422,
    );
  }

  annotate({
    action: { name: "settings.telegram.test" },
    meta: { success: true },
  });

  return apiSuccess({ sent: true });
});
