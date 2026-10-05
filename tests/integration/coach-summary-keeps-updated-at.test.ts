/**
 * The Coach memory summary is bookkeeping, not activity (real Postgres).
 *
 * The Coach panel orders and groups conversations by `updatedAt`. The summary
 * refresh rewrites a conversation row in the background, and as a Prisma
 * `update` it stamped `updatedAt` with the run time, so a thread nobody had
 * touched could surface under "Today". The write now goes through raw SQL;
 * this pins that the summary lands (the ciphertext binds as `bytea`) and that
 * the stamp stays where the last turn left it.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { refreshConversationSummary } from "@/lib/ai/coach/conversation-summary";
import { getPrismaClient, truncateAllTables } from "./setup";

const USER = "user-coach-summary";
const LAST_TURN = new Date("2026-04-10T19:30:00.000Z");

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: USER,
      username: "coach-summary",
      email: "coach-summary@example.test",
      timezone: "Europe/Berlin",
    },
  });
});

describe("coach memory summary", () => {
  it("writes the summary and leaves updatedAt alone", async () => {
    const prisma = getPrismaClient();
    const conversation = await prisma.coachConversation.create({
      data: {
        userId: USER,
        titleEncrypted: encryptToBytes("Training plan"),
      },
    });
    await prisma.coachMessage.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        conversationId: conversation.id,
        role: i % 2 === 0 ? "user" : "assistant",
        encryptedContent: encryptToBytes(`turn ${i}`),
        createdAt: new Date(LAST_TURN.getTime() - (30 - i) * 60_000),
      })),
    });
    // Created rows stamp now; set the stamp a last turn would have left.
    await prisma.$executeRaw`
      UPDATE "coach_conversations" SET "updated_at" = ${LAST_TURN}
      WHERE "id" = ${conversation.id}`;

    const now = new Date("2026-10-05T06:00:00.000Z");
    const result = await refreshConversationSummary(conversation.id, USER, {
      now,
      runCompletion: async () => ({
        kind: "ok",
        content: "Training for a 10k, prefers morning runs.",
        providerType: "admin-openai",
        model: "test",
        tokensUsed: 10,
      }),
    });
    expect(result.status).toBe("generated");

    const row = await prisma.coachConversation.findUniqueOrThrow({
      where: { id: conversation.id },
    });
    expect(decryptFromBytes(row.summaryEncrypted!)).toBe(
      "Training for a 10k, prefers morning runs.",
    );
    expect(row.summaryUpdatedAt).toEqual(now);
    expect(row.summaryTurnCount).toBe(12);
    expect(row.updatedAt).toEqual(LAST_TURN);
  });
});
