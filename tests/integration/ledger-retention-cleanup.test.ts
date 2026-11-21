/**
 * The nightly ledger retention against real tables: what goes, what stays,
 * and that a backlog larger than a batch drains over the batch loop. The
 * Coach message purge, batched in the same release, is covered here too.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { cleanupOldCoachMessages } from "@/lib/jobs/coach-message-cleanup";
import {
  cleanupRetainedLedgers,
  COACH_USAGE_RETENTION_DAYS,
  TELEGRAM_REMINDER_MESSAGE_RETENTION_DAYS,
} from "@/lib/jobs/ledger-retention-cleanup";

import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const DAY_MS = 86_400_000;
const NOW = new Date("2026-11-21T03:58:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

beforeEach(async () => {
  await truncateAllTables(prisma);
});

async function medicationFor(userId: string) {
  const medication = await prisma.medication.create({
    data: {
      userId,
      name: "Ledger medication",
      dose: "1 tablet",
      schedules: { create: { windowStart: "08:00", windowEnd: "08:00" } },
    },
    include: { schedules: true },
  });
  return {
    medicationId: medication.id,
    scheduleId: medication.schedules[0]!.id,
  };
}

describe("ledger retention", () => {
  it("removes Telegram reminder messages past 30 days and keeps the recent ones", async () => {
    const user = await prisma.user.create({ data: { username: "tg" } });
    const slot = await medicationFor(user.id);
    const row = (date: string, sentAt: Date, messageId: number) => ({
      recipientUserId: user.id,
      ...slot,
      chatId: "chat",
      messageId,
      phase: "YELLOW" as const,
      date,
      timeOfDay: "08:00",
      sentAt,
    });
    await prisma.telegramReminderMessage.createMany({
      data: [
        row(
          "2026-09-01",
          daysAgo(TELEGRAM_REMINDER_MESSAGE_RETENTION_DAYS + 1),
          1,
        ),
        row(
          "2026-11-01",
          daysAgo(TELEGRAM_REMINDER_MESSAGE_RETENTION_DAYS - 1),
          2,
        ),
      ],
    });

    const result = await cleanupRetainedLedgers(prisma, NOW);

    expect(result.deleted.telegram_reminder_messages).toBe(1);
    const left = await prisma.telegramReminderMessage.findMany({
      select: { messageId: true },
    });
    expect(left).toEqual([{ messageId: 2 }]);
  });

  it("removes Coach usage days not written for 180 days and keeps the rest", async () => {
    const user = await prisma.user.create({ data: { username: "coach" } });
    await prisma.$executeRaw`
      INSERT INTO coach_usage (id, user_id, date_key, total_tokens, updated_at)
      VALUES
        ('old', ${user.id}, '2026-05-01', 10, ${daysAgo(COACH_USAGE_RETENTION_DAYS + 1)}),
        ('recent', ${user.id}, '2026-11-20', 20, ${daysAgo(1)})`;

    const result = await cleanupRetainedLedgers(prisma, NOW);

    expect(result.deleted.coach_usage).toBe(1);
    expect(result.drained).toBe(true);
    const left = await prisma.coachUsage.findMany({ select: { id: true } });
    expect(left).toEqual([{ id: "recent" }]);
  });

  it("drains a backlog larger than one batch and says when it stopped at the cap", async () => {
    const user = await prisma.user.create({ data: { username: "backlog" } });
    await prisma.$executeRaw`
      INSERT INTO coach_usage (id, user_id, date_key, updated_at)
      SELECT 'u' || n, ${user.id},
             to_char(date '2025-01-01' + n, 'YYYY-MM-DD'),
             ${daysAgo(COACH_USAGE_RETENTION_DAYS + 30)}
        FROM generate_series(1, 25) AS n`;

    const capped = await cleanupRetainedLedgers(prisma, NOW, {
      batchSize: 10,
      maxBatches: 2,
    });
    expect(capped.deleted.coach_usage).toBe(20);
    expect(capped.drained).toBe(false);

    const rest = await cleanupRetainedLedgers(prisma, NOW, { batchSize: 10 });
    expect(rest.deleted.coach_usage).toBe(5);
    expect(rest.drained).toBe(true);
    expect(await prisma.coachUsage.count()).toBe(0);
  });
});

describe("Coach message retention", () => {
  it("removes messages past the retention in batches and keeps the recent ones", async () => {
    const user = await prisma.user.create({ data: { username: "msgs" } });
    const conversation = await prisma.coachConversation.create({
      data: { userId: user.id },
    });
    await prisma.coachMessage.createMany({
      data: [
        ...Array.from({ length: 3 }, () => ({
          conversationId: conversation.id,
          role: "user",
          encryptedContent: Buffer.from("x"),
          createdAt: daysAgo(400),
        })),
        {
          conversationId: conversation.id,
          role: "assistant",
          encryptedContent: Buffer.from("y"),
          createdAt: daysAgo(10),
        },
      ],
    });

    expect(await cleanupOldCoachMessages(prisma, NOW)).toBe(3);
    expect(await prisma.coachMessage.count()).toBe(1);
  });
});
