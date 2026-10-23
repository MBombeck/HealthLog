/**
 * Migration 0476 links existing EXTERNAL readings to the token that carried
 * them only where that is provable (#1272): the account holds exactly one
 * measurement token, revoked ones counted, and the reading is no older than
 * the token. Everything else stays unlinked. The pass writes nothing but the
 * link, so no reading's `updatedAt` or `syncVersion` moves, and a rerun
 * changes nothing.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { MEASUREMENTS_WRITE_SCOPE } from "@/lib/measurements/scopes";

import { makeToken, makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();

const MIGRATION = readFileSync(
  resolve(
    process.cwd(),
    "prisma",
    "migrations",
    "0476_token_apple_health_mirror",
    "migration.sql",
  ),
  "utf8",
);

/** The file is three `DO` blocks; each goes through as its own statement. */
async function runMigration(): Promise<void> {
  const blocks = MIGRATION.match(/DO \$migration\$[\s\S]*?\$migration\$;/g);
  expect(blocks).toHaveLength(3);
  for (const block of blocks!) await prisma.$executeRawUnsafe(block);
}

const TOKEN_AT = new Date("2026-06-01T00:00:00.000Z");

async function externalReading(
  userId: string,
  createdAt: Date,
  source: "EXTERNAL" | "MANUAL" = "EXTERNAL",
) {
  return prisma.measurement.create({
    data: {
      userId,
      type: "WEIGHT",
      value: 80,
      unit: "kg",
      source,
      measuredAt: createdAt,
      createdAt,
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    },
    select: { id: true },
  });
}

async function measurementToken(userId: string, revoked = false) {
  const token = await makeToken(
    { id: userId },
    { permissions: [MEASUREMENTS_WRITE_SCOPE] },
  );
  await prisma.apiToken.update({
    where: { id: token.tokenId },
    data: { createdAt: TOKEN_AT, revoked },
  });
  return token.tokenId;
}

beforeEach(async () => {
  await truncateAllTables(prisma);
});

describe("migration 0476 backfill", () => {
  it("links only what one token provably carried", async () => {
    const sole = await makeUser({ timezone: "UTC" });
    const soleToken = await measurementToken(sole.id, true);
    // A wildcard sign-in token does not make the measurement token ambiguous.
    await makeToken(sole, { permissions: ["*"] });
    const after = await externalReading(
      sole.id,
      new Date("2026-06-02T08:00:00.000Z"),
    );
    const before = await externalReading(
      sole.id,
      new Date("2026-05-30T08:00:00.000Z"),
    );
    const manual = await externalReading(
      sole.id,
      new Date("2026-06-03T08:00:00.000Z"),
      "MANUAL",
    );

    const two = await makeUser({ timezone: "UTC" });
    await measurementToken(two.id);
    await measurementToken(two.id);
    const ambiguous = await externalReading(
      two.id,
      new Date("2026-06-02T08:00:00.000Z"),
    );

    const stamps = await prisma.measurement.findMany({
      select: { id: true, updatedAt: true, syncVersion: true },
      orderBy: { id: "asc" },
    });

    await runMigration();
    await runMigration();

    const links = Object.fromEntries(
      (
        await prisma.measurement.findMany({
          select: { id: true, ingestTokenId: true },
        })
      ).map((r) => [r.id, r.ingestTokenId]),
    );
    expect(links).toEqual({
      [after.id]: soleToken,
      [before.id]: null,
      [manual.id]: null,
      [ambiguous.id]: null,
    });
    expect(
      await prisma.measurement.findMany({
        select: { id: true, updatedAt: true, syncVersion: true },
        orderBy: { id: "asc" },
      }),
    ).toEqual(stamps);
  });
});
