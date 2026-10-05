/**
 * Migration 0375 moves a Coach conversation's updated_at back to its newest
 * message (real Postgres).
 *
 * The migration has already run on the empty test database when the
 * container booted, so the test seeds the shapes it has to tell apart and
 * runs the same SQL file again: a conversation a backfill bumped, one renamed
 * within a minute of its last turn, one without messages, and a second pass
 * that must change nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { getPrismaClient, truncateAllTables } from "./setup";

const REPAIR_SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/0375_coach_conversation_updated_at_repair/migration.sql",
  ),
  "utf8",
);

const USER = "user-coach-updated-at-repair";
const LAST_TURN = new Date("2026-03-02T09:15:00.000Z");
const BACKFILL_RUN = new Date("2026-10-01T04:00:00.000Z");
const RENAMED = new Date("2026-03-02T09:15:40.000Z");
const EMPTY_STAMP = new Date("2026-09-30T12:00:00.000Z");

async function setUpdatedAt(id: string, at: Date) {
  // A Prisma update would stamp now; set the column as the history left it.
  await getPrismaClient().$executeRaw`
    UPDATE "coach_conversations" SET "updated_at" = ${at} WHERE "id" = ${id}`;
}

async function stamps(): Promise<Record<string, string>> {
  const rows = await getPrismaClient().coachConversation.findMany({
    where: { userId: USER },
    select: { id: true, updatedAt: true },
  });
  return Object.fromEntries(rows.map((r) => [r.id, r.updatedAt.toISOString()]));
}

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: USER,
      username: "coach-repair",
      email: "coach-repair@example.test",
      timezone: "Europe/Berlin",
    },
  });
  for (const id of ["bumped", "renamed", "empty"]) {
    await prisma.coachConversation.create({
      data: { id, userId: USER, titleEncrypted: encryptToBytes(id) },
    });
  }
  for (const id of ["bumped", "renamed"]) {
    await prisma.coachMessage.createMany({
      data: [
        {
          conversationId: id,
          role: "user",
          encryptedContent: encryptToBytes("question"),
          createdAt: new Date(LAST_TURN.getTime() - 30_000),
        },
        {
          conversationId: id,
          role: "assistant",
          encryptedContent: encryptToBytes("answer"),
          createdAt: LAST_TURN,
        },
      ],
    });
  }
  await setUpdatedAt("bumped", BACKFILL_RUN);
  await setUpdatedAt("renamed", RENAMED);
  await setUpdatedAt("empty", EMPTY_STAMP);
});

describe("migration 0375 — coach conversation updated_at repair", () => {
  it("moves a bumped conversation back and leaves the others alone", async () => {
    const changed = await getPrismaClient().$executeRawUnsafe(REPAIR_SQL);
    expect(changed).toBe(1);
    expect(await stamps()).toEqual({
      bumped: LAST_TURN.toISOString(),
      renamed: RENAMED.toISOString(),
      empty: EMPTY_STAMP.toISOString(),
    });
  });

  it("changes nothing on a second run", async () => {
    const prisma = getPrismaClient();
    await prisma.$executeRawUnsafe(REPAIR_SQL);
    const after = await stamps();
    expect(await prisma.$executeRawUnsafe(REPAIR_SQL)).toBe(0);
    expect(await stamps()).toEqual(after);
  });

  it("reads the newest message through the conversation index", async () => {
    const rows = await getPrismaClient().$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'coach_messages'
        AND indexname = 'coach_messages_conversation_id_created_at_idx'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/\(conversation_id, created_at\)/);
  });
});
