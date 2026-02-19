import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { decrypt } from "@/lib/crypto";
import { sendTelegramMessage } from "@/lib/telegram";

/**
 * Send a test Telegram message to verify the bot token and chat ID.
 */
export async function POST() {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const user = await prisma.user.findUnique({
    where: { id: sessionData.user.id },
    select: { telegramBotToken: true, telegramChatId: true },
  });

  if (!user?.telegramBotToken || !user?.telegramChatId) {
    return apiError(
      "Bot-Token und Chat-ID müssen zuerst gespeichert werden",
      422,
    );
  }

  const botToken = decrypt(user.telegramBotToken);
  const ok = await sendTelegramMessage(
    botToken,
    user.telegramChatId,
    "HealthLog: Verbindung erfolgreich! Telegram-Benachrichtigungen sind aktiv.",
  );

  if (!ok) {
    return apiError(
      "Nachricht konnte nicht gesendet werden. Prüfe Bot-Token und Chat-ID.",
      422,
    );
  }

  return apiSuccess({ sent: true });
}
