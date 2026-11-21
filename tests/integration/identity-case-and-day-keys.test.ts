/**
 * Migration 0517 against a real database: e-mail and username unique
 * regardless of case, its refusal to build those keys over accounts that
 * already clash, and the shape check on text day keys.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();

function migration0517(): string {
  const dir = join(process.cwd(), "prisma", "migrations");
  const name = readdirSync(dir).find((entry) => entry.startsWith("0517_"));
  if (!name) throw new Error("migration 0517 is missing");
  return readFileSync(join(dir, name, "migration.sql"), "utf8");
}

/** One DO block of the migration, by its dollar-quote tag. */
function block(tag: string): string {
  const sql = migration0517();
  const match = new RegExp(`DO \\$${tag}\\$[\\s\\S]*?\\$${tag}\\$;`).exec(sql);
  if (!match) throw new Error(`block ${tag} is missing from 0517`);
  return match[0];
}

async function connect(): Promise<Client> {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.searchParams.delete("schema");
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

beforeEach(async () => {
  await truncateAllTables(prisma);
});

describe("0517 identity keys", () => {
  it("refuses a second account whose e-mail differs only in case", async () => {
    await prisma.user.create({
      data: { username: "first", email: "Person@Example.test" },
    });
    await expect(
      prisma.user.create({
        data: { username: "second", email: "person@example.test" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("refuses a second account whose username differs only in case", async () => {
    await prisma.user.create({ data: { username: "Person" } });
    await expect(
      prisma.user.create({ data: { username: "person" } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("stops before building the keys when accounts already clash, and changes nothing", async () => {
    const db = await connect();
    try {
      await db.query("BEGIN");
      await db.query('DROP INDEX "users_email_lower_key"');
      await db.query('DROP INDEX "users_username_lower_key"');
      await db.query(
        `INSERT INTO users (id, username, email, role, created_at, updated_at)
         VALUES ('a', 'one', 'Same@Example.test', 'USER', now(), now()),
                ('b', 'two', 'same@example.test', 'USER', now(), now())`,
      );
      await expect(db.query(block("identity"))).rejects.toThrow(
        /0517: 1 e-mail address\(es\) and 0 username\(s\) belong to more than one account/,
      );
    } finally {
      await db.query("ROLLBACK");
      await db.end();
    }
    // The rolled-back probe left the keys as the migration built them.
    const keys = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
       WHERE tablename = 'users' AND indexname LIKE 'users_%_lower_key'
       ORDER BY indexname`;
    expect(keys.map((k) => k.indexname)).toEqual([
      "users_email_lower_key",
      "users_username_lower_key",
    ]);
  });

  it("builds them over accounts that do not clash", async () => {
    const db = await connect();
    try {
      await db.query("BEGIN");
      await db.query('DROP INDEX "users_email_lower_key"');
      await db.query('DROP INDEX "users_username_lower_key"');
      await db.query(
        `INSERT INTO users (id, username, email, role, created_at, updated_at)
         VALUES ('a', 'One', 'One@Example.test', 'USER', now(), now()),
                ('b', 'two', NULL, 'USER', now(), now()),
                ('c', 'three', NULL, 'USER', now(), now())`,
      );
      await db.query(block("identity"));
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_indexes
          WHERE tablename = 'users' AND indexname LIKE 'users_%_lower_key'`,
      );
      expect(Number(rows[0].n)).toBe(2);
    } finally {
      await db.query("ROLLBACK");
      await db.end();
    }
  });
});

describe("0517 day keys", () => {
  it("refuses a day that is not YYYY-MM-DD and keeps one that is", async () => {
    const user = await prisma.user.create({ data: { username: "days" } });
    await expect(
      prisma.$executeRaw`
        INSERT INTO coach_usage (id, user_id, date_key, updated_at)
        VALUES ('bad', ${user.id}, '2026-1-5', now())`,
    ).rejects.toThrow(/coach_usage_date_key_day_key_shape/);
    await prisma.$executeRaw`
      INSERT INTO coach_usage (id, user_id, date_key, updated_at)
      VALUES ('good', ${user.id}, '2026-01-05', now())`;
    expect(await prisma.coachUsage.count()).toBe(1);
  });

  it("refuses a pregnancy day on the cycle profile that is not YYYY-MM-DD", async () => {
    // These days reach the backup verbatim, and the backup schema reads them
    // as day keys: a column that took any text let the writer produce a copy
    // its own preview and restore then refused.
    const user = await prisma.user.create({ data: { username: "pregnancy" } });
    for (const column of [
      "pregnancyStartDate",
      "pregnancyDueDate",
      "deliveryDate",
    ] as const) {
      await expect(
        prisma.cycleProfile.upsert({
          where: { userId: user.id },
          create: { userId: user.id, [column]: "2026-1-5" },
          update: { [column]: "2026-1-5" },
        }),
      ).rejects.toThrow(/day_key_shape/);
    }
    await prisma.cycleProfile.create({
      data: {
        userId: user.id,
        pregnancyStartDate: "2026-01-05",
        pregnancyDueDate: "2026-10-12",
        deliveryDate: null,
      },
    });
    expect(await prisma.cycleProfile.count()).toBe(1);
  });

  it("checks every listed column", async () => {
    const rows = await prisma.$queryRaw<
      Array<{ conname: string; validated: boolean }>
    >`
      SELECT conname, convalidated AS validated FROM pg_constraint
       WHERE conname LIKE '%\\_day\\_key\\_shape' ORDER BY conname`;
    // 16 from 0517, three from 0533 (the pregnancy days on cycle_profiles).
    expect(rows).toHaveLength(19);
    // A fresh database holds no misfit, so every check is validated.
    expect(rows.every((row) => row.validated)).toBe(true);
  });
});
