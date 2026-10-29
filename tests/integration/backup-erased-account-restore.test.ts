/**
 * The backup of an account that has since been erased.
 *
 * An account is filled (the shared backup seed), its disaster-recovery file is
 * written by the exporter the weekly copy uses, and the account is then
 * deleted the way a person deletes it: `DELETE /api/settings/account` under a
 * 14-day grace window, and the hourly purge job run past the window's end.
 * What is left is what an operator has after the fact: the file, an admin
 * session, and a server that no longer knows the account.
 *
 *   1. The purge leaves nothing in the database that names the account.
 *   2. The admin upload refuses the file, because its owner is gone, and
 *      stores nothing (the documented contract in `docs/ops/backup-restore.md`:
 *      a restore writes into an account that exists under the same id).
 *   3. With the account row put back under its original id, the one way that
 *      contract leaves, the upload and the restore bring every section back.
 *   4. Into a freshly created account, with the file's owner set to that
 *      account, the restore brings every section back and nothing in the
 *      database names the erased account afterwards.
 *
 * Everything runs through production code: the deletion route, the purge job,
 * the admin upload and restore routes and the restore job
 * (`restore-job-driver.ts` runs the queued job in-process).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";

import {
  OWNER_ID,
  createOwner,
  seedColumnShapes,
  seedEveryTwoEndedModel,
} from "./backup-fixture";
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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/notifications/dispatch-localised", () => ({
  dispatchLocalisedNotification: vi.fn(async () => undefined),
}));

const DAY_MS = 86_400_000;
const SLOW = 240_000;

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.rateLimit.deleteMany();
  cookieJar.clear();
  headerJar.clear();
  vi.stubEnv("ACCOUNT_DELETION_GRACE_DAYS", "14");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function signIn(prisma: PrismaClient, userId: string) {
  const session = await prisma.session.create({
    data: { userId, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

/**
 * Every text and JSON cell in the public schema that contains `needle`, as
 * `table.column (rows)`. Bytes are left out: ciphertext cannot be searched,
 * and the backup seed seals nothing that names its owner.
 */
async function cellsNaming(
  prisma: PrismaClient,
  needle: string,
): Promise<string[]> {
  const columns = await prisma.$queryRaw<
    Array<{ table_name: string; column_name: string }>
  >`
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.table_name <> '_prisma_migrations'
      AND (c.data_type IN ('text', 'character varying', 'json', 'jsonb')
           OR c.udt_name IN ('_text', '_varchar'))
    ORDER BY c.table_name, c.column_name`;
  const hits: string[] = [];
  for (const { table_name, column_name } of columns) {
    if (table_name === "rate_limits") {
      // A rate-limit bucket (`record-write:<userId>`) is counting state, not
      // a record: it expires with its window and `rate-limit-cleanup` deletes
      // it. Allowed only while that holds, so a bucket that outlives its
      // account by more than a day still shows up.
      const lasting = await prisma.$queryRaw<Array<{ key: string }>>`
        SELECT key FROM rate_limits
        WHERE key LIKE '%' || ${needle} || '%'
          AND reset_at > (NOW() AT TIME ZONE 'UTC') + interval '1 day'`;
      hits.push(...lasting.map((row) => `rate_limits.key: ${row.key}`));
      continue;
    }
    // Identifiers come from the catalogue above, never from input.
    const rows = await prisma.$queryRawUnsafe<
      Array<{ n: bigint; sample: string | null }>
    >(
      `SELECT count(*) AS n, min(left("${column_name}"::text, 80)) AS sample
       FROM "${table_name}" WHERE "${column_name}"::text LIKE '%' || $1 || '%'`,
      needle,
    );
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) {
      hits.push(`${table_name}.${column_name} (${n}): ${rows[0]?.sample}`);
    }
  }
  return hits;
}

/** The account, its file, and the account erased by the real path. */
async function eraseAfterExport(prisma: PrismaClient) {
  const admin = await prisma.user.create({
    data: {
      username: "erasure-admin",
      email: "erasure-admin@example.test",
      role: "ADMIN",
    },
  });
  await createOwner(prisma);
  await seedEveryTwoEndedModel(prisma);
  await seedColumnShapes(prisma);
  // The seed's illness symptom lives in a catalogue row of its own, which
  // the purge rightly keeps (catalogues are the instance's). Re-point the
  // link at a shipped symptom so the scan below reads the account alone.
  const shipped = await prisma.illnessSymptom.findFirstOrThrow({
    where: { key: { not: "round_trip_cough" } },
    orderBy: { key: "asc" },
  });
  const own = await prisma.illnessSymptom.findUniqueOrThrow({
    where: { key: "round_trip_cough" },
  });
  await prisma.illnessSymptomLink.updateMany({
    where: { symptomId: own.id },
    data: { symptomId: shipped.id },
  });
  await prisma.illnessSymptom.delete({ where: { id: own.id } });

  let json = "";
  const exported = await streamFullBackupJson(
    prisma,
    OWNER_ID,
    (chunk) => {
      json += chunk;
    },
    { purpose: "disaster-recovery" },
  );
  const counts: Record<string, number> = { ...exported };

  // The person deletes their account; the window starts.
  await signIn(prisma, OWNER_ID);
  const { DELETE } = await import("@/app/api/settings/account/route");
  const { NextRequest } = await import("next/server");
  const deleted = await DELETE(
    new NextRequest("http://localhost/api/settings/account", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE_ACCOUNT" }),
    }),
  );
  expect(deleted.status, await deleted.clone().text()).toBe(200);
  expect(
    (await prisma.user.findUniqueOrThrow({ where: { id: OWNER_ID } }))
      .deletionPurgeAt,
  ).not.toBeNull();

  // The window ends and the hourly job runs to completion.
  const { processDueAccountDeletions } =
    await import("@/lib/jobs/account-deletion-purge");
  const report = await processDueAccountDeletions(
    new Date(Date.now() + 15 * DAY_MS),
  );
  expect(report).toMatchObject({ due: 1, purged: 1, refused: 0, failed: 0 });
  expect(await prisma.user.findUnique({ where: { id: OWNER_ID } })).toBeNull();

  cookieJar.clear();
  await signIn(prisma, admin.id);
  return { admin, json, counts };
}

async function upload(body: string) {
  const { POST } = await import("@/app/api/admin/backups/upload/route");
  const res = await POST(
    new Request("http://localhost/api/admin/backups/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }) as unknown as Parameters<typeof POST>[0],
  );
  return {
    status: res.status,
    body: (await res.json()) as {
      data: { id: string } | null;
      error: string | null;
      meta?: { reason?: string; errorCode?: string };
    },
  };
}

async function restore(backupId: string) {
  const { POST } = await import("./restore-job-driver");
  const res = await POST(
    new Request(`http://localhost/api/admin/backups/${backupId}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "RESTORE" }),
    }) as unknown as Parameters<typeof POST>[0],
    { params: Promise.resolve({ id: backupId }) },
  );
  return {
    status: res.status,
    body: (await res.json()) as {
      data: { skipped: { links: number } } | null;
      error: string | null;
    },
  };
}

async function countsOf(prisma: PrismaClient, userId: string) {
  const { counts } = await buildFullBackupPayload(prisma, userId, {
    purpose: "disaster-recovery",
  });
  return { ...counts } as Record<string, number>;
}

describe("restoring the backup of an erased account", () => {
  it(
    "the purge leaves nothing that names the account, and the upload refuses its file",
    async () => {
      const prisma = getPrismaClient();
      const { json, counts } = await eraseAfterExport(prisma);
      expect(Object.values(counts).filter((n) => n > 0).length).toBeGreaterThan(
        40,
      );

      expect(await cellsNaming(prisma, OWNER_ID)).toEqual([]);

      const refused = await upload(json);
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      const denial = await prisma.auditLog.findFirstOrThrow({
        where: { action: "admin.backups.upload.denied" },
      });
      expect(JSON.parse(denial.details ?? "{}")).toMatchObject({
        reason: "owner_not_found",
        ownerId: OWNER_ID,
      });
      expect(await prisma.dataBackup.count()).toBe(0);
    },
    SLOW,
  );

  it(
    "comes back whole once the account row exists again under its id",
    async () => {
      const prisma = getPrismaClient();
      const { json, counts } = await eraseAfterExport(prisma);
      await createOwner(prisma);

      const stored = await upload(json);
      expect(stored.status, JSON.stringify(stored.body)).toBe(201);
      const restored = await restore(stored.body.data!.id);
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      expect(restored.body.data!.skipped.links).toBe(0);
      expect(await countsOf(prisma, OWNER_ID)).toEqual(counts);
    },
    SLOW,
  );

  it(
    "comes back whole into a freshly created account, and nothing names the erased one",
    async () => {
      const prisma = getPrismaClient();
      const { json, counts } = await eraseAfterExport(prisma);
      const fresh = await prisma.user.create({
        data: {
          username: "returning-person",
          email: "returning-person@example.test",
        },
      });
      // The file names its owner once, at the top; the restore targets the
      // account it names. Point it at the new account.
      const payload = JSON.parse(json) as { userId: string };
      expect(payload.userId).toBe(OWNER_ID);
      payload.userId = fresh.id;

      const stored = await upload(JSON.stringify(payload));
      expect(stored.status, JSON.stringify(stored.body)).toBe(201);
      const restored = await restore(stored.body.data!.id);
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      expect(restored.body.data!.skipped.links).toBe(0);

      expect(await countsOf(prisma, fresh.id)).toEqual(counts);
      expect(await cellsNaming(prisma, OWNER_ID)).toEqual([]);
    },
    SLOW,
  );
});
