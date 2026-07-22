import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
const WHOOP_OWNER_MIGRATION_SQL = readFileSync(
  resolve(
    process.cwd(),
    "prisma/migrations/0264_whoop_owner_identity/migration.sql",
  ),
  "utf8",
);

async function createUser(tag: string) {
  const prisma = getPrismaClient();
  return prisma.user.create({
    data: {
      username: `whoop-owner-${tag}`,
      email: `whoop-owner-${tag}@example.test`,
      role: "USER",
    },
  });
}

describe("WHOOP provider identity ownership — integration", () => {
  beforeEach(async () => {
    await truncateAllTables(getPrismaClient());
  });

  it("prevents one WHOOP user id from belonging to two local users", async () => {
    const prisma = getPrismaClient();
    const firstUser = await createUser("first");
    const secondUser = await createUser("second");
    const tokenExpiresAt = new Date("2026-08-01T00:00:00.000Z");

    await prisma.whoopConnection.create({
      data: {
        userId: firstUser.id,
        whoopUserId: "shared-provider-user",
        accessToken: "encrypted-access-1",
        refreshToken: "encrypted-refresh-1",
        tokenExpiresAt,
      },
    });

    await expect(
      prisma.whoopConnection.create({
        data: {
          userId: secondUser.id,
          whoopUserId: "shared-provider-user",
          accessToken: "encrypted-access-2",
          refreshToken: "encrypted-refresh-2",
          tokenExpiresAt,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("keeps the earliest duplicate deterministically when the migration is applied", async () => {
    const prisma = getPrismaClient();
    const winnerUser = await createUser("migration-winner");
    const tiedLoserUser = await createUser("migration-tied-loser");
    const laterLoserUser = await createUser("migration-later-loser");
    const earliest = new Date("2026-01-01T00:00:00.000Z");
    const later = new Date("2026-01-02T00:00:00.000Z");
    const tokenExpiresAt = new Date("2026-08-01T00:00:00.000Z");

    await prisma.$executeRawUnsafe(
      'DROP INDEX "whoop_connections_whoop_user_id_key"',
    );
    await prisma.whoopConnection.createMany({
      data: [
        {
          id: "a-earliest",
          userId: winnerUser.id,
          whoopUserId: "duplicate-provider-user",
          accessToken: "encrypted-access-1",
          refreshToken: "encrypted-refresh-1",
          tokenExpiresAt,
          createdAt: earliest,
          updatedAt: earliest,
        },
        {
          id: "z-earliest",
          userId: tiedLoserUser.id,
          whoopUserId: "duplicate-provider-user",
          accessToken: "encrypted-access-2",
          refreshToken: "encrypted-refresh-2",
          tokenExpiresAt,
          createdAt: earliest,
          updatedAt: earliest,
        },
        {
          id: "0-later",
          userId: laterLoserUser.id,
          whoopUserId: "duplicate-provider-user",
          accessToken: "encrypted-access-3",
          refreshToken: "encrypted-refresh-3",
          tokenExpiresAt,
          createdAt: later,
          updatedAt: later,
        },
      ],
    });

    await prisma.$executeRawUnsafe(WHOOP_OWNER_MIGRATION_SQL);

    const connections = await prisma.whoopConnection.findMany({
      where: { id: { in: ["a-earliest", "z-earliest", "0-later"] } },
      orderBy: { id: "asc" },
      select: { id: true, whoopUserId: true },
    });
    expect(connections).toEqual([
      { id: "0-later", whoopUserId: null },
      { id: "a-earliest", whoopUserId: "duplicate-provider-user" },
      { id: "z-earliest", whoopUserId: null },
    ]);
  });
});
