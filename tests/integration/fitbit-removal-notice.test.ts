/**
 * The Fitbit integration's removal, against real Postgres.
 *
 * Migration 0503 marks every account that still held a Fitbit connection,
 * then drops the connection rows, the OAuth state ledger, the per-account app
 * credentials and the integration's status and watchdog rows. Imported
 * readings stay. The status envelope then publishes `fitbitRemovalNotice` for
 * a marked account only, and dismissing the note clears it for good.
 *
 * The schema here is already migrated, so the Fitbit tables and columns are
 * put back in their last shape before the migration file is replayed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

const MIGRATION = resolve(
  __dirname,
  "../../prisma/migrations/0503_remove_fitbit_integration/migration.sql",
);
const prisma = () => getPrismaClient();

beforeEach(async () => {
  await truncateAllTables(prisma());
  cookieJar.clear();
  headerJar.clear();
});

async function user(id: string, data: Record<string, unknown> = {}) {
  await prisma().user.create({
    data: { id, username: id, email: `${id}@example.test`, ...data },
  });
}

/** The Fitbit tables and columns as they stood before 0503. */
async function restorePreRemovalShape() {
  await prisma().$executeRawUnsafe(`
    ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "fitbit_client_id_encrypted" TEXT,
      ADD COLUMN IF NOT EXISTS "fitbit_client_secret_encrypted" TEXT`);
  await prisma().$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "fitbit_connections" (
      "id" TEXT PRIMARY KEY,
      "user_id" TEXT NOT NULL UNIQUE
        REFERENCES "users"("id") ON DELETE CASCADE,
      "fitbit_user_id" TEXT NOT NULL,
      "access_token" TEXT NOT NULL,
      "refresh_token" TEXT NOT NULL,
      "token_expires_at" TIMESTAMP(3) NOT NULL)`);
  await prisma().$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "fitbit_oauth_states" (
      "nonce" TEXT PRIMARY KEY,
      "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "expires_at" TIMESTAMP(3) NOT NULL)`);
}

async function exists(relation: string): Promise<boolean> {
  const rows = await prisma().$queryRawUnsafe<Array<{ found: boolean }>>(
    `SELECT to_regclass('${relation}') IS NOT NULL AS found`,
  );
  return rows[0]!.found;
}

async function hasColumn(column: string): Promise<boolean> {
  const rows = await prisma().$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = '${column}'`,
  );
  return rows[0]!.n > 0;
}

describe("migration 0503", () => {
  it("marks the formerly connected, drops what only the integration used, and keeps the readings", async () => {
    await user("had-fitbit");
    await user("never-fitbit");
    await restorePreRemovalShape();
    await prisma().$executeRawUnsafe(`
      UPDATE "users" SET "fitbit_client_id_encrypted" = 'sealed-id',
                         "fitbit_client_secret_encrypted" = 'sealed-secret'
       WHERE "id" IN ('had-fitbit', 'never-fitbit')`);
    await prisma().$executeRawUnsafe(`
      INSERT INTO "fitbit_connections"
        ("id", "user_id", "fitbit_user_id", "access_token", "refresh_token", "token_expires_at")
      VALUES ('c1', 'had-fitbit', 'FB1', 'sealed-a', 'sealed-r', NOW())`);
    await prisma().$executeRawUnsafe(`
      INSERT INTO "fitbit_oauth_states" ("nonce", "user_id", "expires_at")
      VALUES ('n1', 'never-fitbit', NOW())`);
    for (const integration of ["fitbit", "google-health"]) {
      await prisma().integrationStatus.create({
        data: { userId: "had-fitbit", integration },
      });
      await prisma().integrationWatch.create({
        data: { userId: "had-fitbit", integration },
      });
    }
    await prisma().measurement.create({
      data: {
        userId: "had-fitbit",
        type: "ACTIVITY_STEPS",
        value: 9000,
        unit: "steps",
        source: "FITBIT",
        measuredAt: new Date("2026-10-20T12:00:00Z"),
        externalId: "stats:steps:2026-10-20",
      },
    });

    const sql = readFileSync(MIGRATION, "utf8");
    await prisma().$executeRawUnsafe(sql);

    const marked = await prisma().user.findMany({
      select: { id: true, fitbitRemovalNoticeAt: true },
      orderBy: { id: "asc" },
    });
    expect(marked[0]).toMatchObject({ id: "had-fitbit" });
    expect(marked[0]!.fitbitRemovalNoticeAt).toBeInstanceOf(Date);
    expect(marked[1]).toEqual({
      id: "never-fitbit",
      fitbitRemovalNoticeAt: null,
    });

    expect(await exists("fitbit_connections")).toBe(false);
    expect(await exists("fitbit_oauth_states")).toBe(false);
    expect(await hasColumn("fitbit_client_id_encrypted")).toBe(false);
    expect(await hasColumn("fitbit_client_secret_encrypted")).toBe(false);

    const statuses = await prisma().integrationStatus.findMany({
      select: { integration: true },
    });
    expect(statuses).toEqual([{ integration: "google-health" }]);
    const watches = await prisma().integrationWatch.findMany({
      select: { integration: true },
    });
    expect(watches).toEqual([{ integration: "google-health" }]);

    expect(
      await prisma().measurement.count({ where: { source: "FITBIT" } }),
    ).toBe(1);

    // A replay changes nothing and does not fail.
    await prisma().$executeRawUnsafe(sql);
    const again = await prisma().user.findUniqueOrThrow({
      where: { id: "had-fitbit" },
      select: { fitbitRemovalNoticeAt: true },
    });
    expect(again.fitbitRemovalNoticeAt).toEqual(
      marked[0]!.fitbitRemovalNoticeAt,
    );
  });
});

async function signIn(id: string) {
  const session = await prisma().session.create({
    data: { userId: id, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.clear();
  cookieJar.set("healthlog_session", session.id);
}

async function notice(): Promise<boolean> {
  const { GET } = await import("@/app/api/integrations/status/route");
  const res = await GET(
    new NextRequest("http://localhost/api/integrations/status"),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: {
      fitbitRemovalNotice: boolean;
      integrations: { integration: string }[];
    };
  };
  expect(body.data.integrations.map((e) => e.integration)).not.toContain(
    "fitbit",
  );
  return body.data.fitbitRemovalNotice;
}

describe("the note on the status envelope", () => {
  it("shows only to a formerly connected account, until it is dismissed", async () => {
    await user("had-fitbit", { fitbitRemovalNoticeAt: new Date() });
    await user("never-fitbit");

    await signIn("never-fitbit");
    expect(await notice()).toBe(false);

    await signIn("had-fitbit");
    expect(await notice()).toBe(true);

    const { POST } =
      await import("@/app/api/integrations/fitbit-removal-notice/dismiss/route");
    const dismiss = () =>
      POST(
        new NextRequest(
          "http://localhost/api/integrations/fitbit-removal-notice/dismiss",
          { method: "POST" },
        ),
      );
    const first = await dismiss();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      data: { dismissed: true },
      error: null,
    });
    expect(await notice()).toBe(false);

    // Idempotent: a second dismissal is a success and changes nothing.
    expect((await dismiss()).status).toBe(200);
    expect(await notice()).toBe(false);
  });

  it("refuses a dismissal without a session", async () => {
    const { POST } =
      await import("@/app/api/integrations/fitbit-removal-notice/dismiss/route");
    const res = await POST(
      new NextRequest(
        "http://localhost/api/integrations/fitbit-removal-notice/dismiss",
        { method: "POST" },
      ),
    );
    expect(res.status).toBe(401);
  });
});
