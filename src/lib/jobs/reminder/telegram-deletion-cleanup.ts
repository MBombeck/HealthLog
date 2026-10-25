/**
 * The scheduled removal of Telegram messages the reminder tick sent, run at
 * the start of every tick. Moved out of `medication-reminder-check.ts`
 * unchanged: it reads no medication and no account beyond the bot token of
 * the messages it removes.
 */
import { decrypt } from "@/lib/crypto";
import { deleteMessage } from "@/lib/telegram";
import { getWorkerPrisma } from "./shared";

/**
 * Process expired TelegramScheduledDeletion records.
 * Deletes messages from Telegram and removes the DB records.
 * Called at the start of every reminder check (every 15 minutes).
 */
export async function cleanupScheduledTelegramDeletions(): Promise<void> {
  const prisma = getWorkerPrisma();
  try {
    let totalDeleted = 0;

    // Process in batches until all expired records are handled
    while (true) {
      // account-deletion: removes Telegram messages already sent; cleanup, not a reminder.
      const expired = await prisma.telegramScheduledDeletion.findMany({
        where: { deleteAfter: { lte: new Date() } },
        take: 100,
      });

      if (expired.length === 0) break;

      // Group by userId to fetch bot token once per user
      const byUser = new Map<
        string,
        { chatId: string; messageId: number; id: string }[]
      >();
      for (const record of expired) {
        const list = byUser.get(record.userId) ?? [];
        list.push({
          chatId: record.chatId,
          messageId: record.messageId,
          id: record.id,
        });
        byUser.set(record.userId, list);
      }

      const deletedIds: string[] = [];
      for (const [userId, messages] of byUser) {
        const user = await prisma.user.findFirst({
          where: { id: userId, telegramBotToken: { not: null } },
          select: { telegramBotToken: true },
        });
        if (!user?.telegramBotToken) {
          // No bot token — just clean up the records
          deletedIds.push(...messages.map((m) => m.id));
          continue;
        }
        const botToken = decrypt(user.telegramBotToken);
        for (const msg of messages) {
          try {
            await deleteMessage(botToken, msg.chatId, msg.messageId);
          } catch {
            // Best-effort: message may already be deleted
          }
          deletedIds.push(msg.id);
        }
      }

      if (deletedIds.length > 0) {
        await prisma.telegramScheduledDeletion.deleteMany({
          where: { id: { in: deletedIds } },
        });
        totalDeleted += deletedIds.length;
      }
    }

    if (totalDeleted > 0) {
      const { getEvent } = await import("@/lib/logging/context");
      getEvent()?.addMeta("telegram_scheduled_cleanup", totalDeleted);
    }

    // Prune expired force-reply correlation rows in the same
    // tick (no new sweep). An unanswered mood-note prompt leaves a
    // TelegramPromptContext row; once past `expiresAt` it can never bind a
    // reply, so drop it. The prompt MESSAGE itself self-cleans through the
    // scheduled-deletion rows above.
    const prunedContexts = await prisma.telegramPromptContext.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    if (prunedContexts.count > 0) {
      const { getEvent } = await import("@/lib/logging/context");
      getEvent()?.addMeta(
        "telegram_prompt_context_cleanup",
        prunedContexts.count,
      );
    }
  } catch (err) {
    const { getEvent } = await import("@/lib/logging/context");
    getEvent()?.addWarning(`telegram-scheduled-cleanup failed: ${err}`);
  }
}
