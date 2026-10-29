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
 *   2. The admin upload without a target refuses the file, because its owner
 *      is gone, says so with `backup.owner.missing`, stores nothing, and does
 *      not write the erased id into the trail either.
 *   3. With the account row put back under its original id, the upload and
 *      the restore bring every section back: the same-id path, unchanged.
 *   4. Into a freshly created account, with the file's owner set to that
 *      account by hand, the restore brings every section back and nothing in
 *      the database names the erased account afterwards. This is the
 *      mechanism the upload's target generalises.
 *   5. The upload with a target does it for the operator: into an existing
 *      empty account (typed confirmation) and into a new account it creates,
 *      every section comes back, the audit trail says what happened, and
 *      nothing names the erased account, the refused first upload included.
 *   6. A target that holds records, is a managed profile, is pending deletion
 *      or is not confirmed is refused before the file is read; so is a target
 *      for a file whose own account is still here, and a new account made for
 *      a refused file is removed again. A non-admin session and a Bearer
 *      token are refused outright.
 *
 * Everything runs through production code: the deletion route, the purge job,
 * the admin upload, target-check and restore routes and the restore job
 * (`restore-job-driver.ts` runs the queued job in-process).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { hashToken } from "@/lib/auth/hmac";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";
import {
  openStoredBackup,
  STORED_BACKUP_SELECT,
} from "@/lib/export/stored-backup";
import {
  backupUploadTargetQuery,
  type BackupUploadTarget,
} from "@/lib/validations/backup-upload-target";

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

async function upload(body: string, query = "") {
  const { POST } = await import("@/app/api/admin/backups/upload/route");
  const res = await POST(
    new Request(`http://localhost/api/admin/backups/upload${query}`, {
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
      meta?: { reason?: string; errorCode?: string; models?: string[] };
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

/** The upload, with a target in the query as the backups console sends it. */
function uploadInto(body: string, target: BackupUploadTarget) {
  return upload(body, `?${backupUploadTargetQuery(target)}`);
}

async function checkTarget(userId: string) {
  const { GET } =
    await import("@/app/api/admin/backups/targets/[userId]/route");
  const { NextRequest } = await import("next/server");
  const res = await GET(
    new NextRequest(`http://localhost/api/admin/backups/targets/${userId}`),
    { params: Promise.resolve({ userId }) },
  );
  return {
    status: res.status,
    body: (await res.json()) as {
      data: {
        id: string;
        eligible: boolean;
        reason: string | null;
        models: string[];
      } | null;
    },
  };
}

/** The stored copy as the restore will read it, as text. */
async function storedCopyText(prisma: PrismaClient, backupId: string) {
  const row = await prisma.dataBackup.findUniqueOrThrow({
    where: { id: backupId },
    select: STORED_BACKUP_SELECT,
  });
  const source = await openStoredBackup(prisma, row);
  const parts: Buffer[] = [];
  for await (const part of source()) parts.push(Buffer.from(part));
  return { row, text: Buffer.concat(parts).toString("utf8") };
}

async function auditDetails(prisma: PrismaClient, action: string) {
  const rows = await prisma.auditLog.findMany({
    where: { action },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => JSON.parse(row.details ?? "{}") as object);
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
      expect(refused.body.meta?.errorCode).toBe("backup.owner.missing");
      const denial = await prisma.auditLog.findFirstOrThrow({
        where: { action: "admin.backups.upload.denied" },
      });
      expect(JSON.parse(denial.details ?? "{}")).toEqual({
        reason: "owner_not_found",
      });
      expect(await prisma.dataBackup.count()).toBe(0);
      // The refusal wrote a row, and that row does not bring the id back.
      expect(await cellsNaming(prisma, OWNER_ID)).toEqual([]);
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

describe("restoring the backup of an erased account into a chosen account", () => {
  it(
    "into an existing empty account: every section, the trail, and nothing naming the erased one",
    async () => {
      const prisma = getPrismaClient();
      const { json, counts } = await eraseAfterExport(prisma);
      const fresh = await prisma.user.create({
        data: {
          username: "returning-person",
          email: "returning-person@example.test",
        },
      });

      // The operator's first try, which the console turns into the choice.
      const first = await upload(json);
      expect(first.body.meta?.errorCode).toBe("backup.owner.missing");

      const check = await checkTarget(fresh.id);
      expect(check.status).toBe(200);
      expect(check.body.data).toMatchObject({
        id: fresh.id,
        eligible: true,
        reason: null,
        models: [],
      });

      const stored = await uploadInto(json, {
        into: "existing",
        userId: fresh.id,
        confirm: "returning-person",
      });
      expect(stored.status, JSON.stringify(stored.body)).toBe(201);
      const backupId = stored.body.data!.id;

      // The stored copy is the chosen account's copy, inside as well.
      const copy = await storedCopyText(prisma, backupId);
      expect(copy.row.userId).toBe(fresh.id);
      expect(JSON.parse(copy.text).userId).toBe(fresh.id);
      expect(copy.text.includes(OWNER_ID)).toBe(false);

      const restored = await restore(backupId);
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      expect(restored.body.data!.skipped.links).toBe(0);
      expect(await countsOf(prisma, fresh.id)).toEqual(counts);

      expect(await auditDetails(prisma, "admin.backups.upload")).toEqual([
        expect.objectContaining({
          backupId,
          ownerId: fresh.id,
          ownerUsername: "returning-person",
          into: "existing",
        }),
      ]);
      expect(await auditDetails(prisma, "admin.backups.restore")).toEqual([
        expect.objectContaining({ backupId, ownerId: fresh.id }),
      ]);
      expect(await cellsNaming(prisma, OWNER_ID)).toEqual([]);
    },
    SLOW,
  );

  it(
    "into a new account: created without a password, filled, and signed into through the admin reset",
    async () => {
      const prisma = getPrismaClient();
      vi.stubEnv("PASSWORD_BREACH_CHECK_DISABLED", "1");
      const { admin, json, counts } = await eraseAfterExport(prisma);
      const usersBefore = await prisma.user.count();

      const stored = await uploadInto(json, {
        into: "new",
        username: "returning-person",
      });
      expect(stored.status, JSON.stringify(stored.body)).toBe(201);
      const backupId = stored.body.data!.id;
      expect(await prisma.user.count()).toBe(usersBefore + 1);
      const account = await prisma.user.findUniqueOrThrow({
        where: { username: "returning-person" },
      });
      expect(account).toMatchObject({
        role: "USER",
        email: null,
        passwordHash: null,
        managedProfileAt: null,
        deletionRequestedAt: null,
      });
      expect(
        (await prisma.dataBackup.findUniqueOrThrow({ where: { id: backupId } }))
          .userId,
      ).toBe(account.id);

      const restored = await restore(backupId);
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      expect(restored.body.data!.skipped.links).toBe(0);
      expect(await countsOf(prisma, account.id)).toEqual(counts);
      // Identity is never in a restore: still the account the upload made.
      expect(
        await prisma.user.findUniqueOrThrow({
          where: { id: account.id },
          select: { username: true, role: true, passwordHash: true },
        }),
      ).toEqual({
        username: "returning-person",
        role: "USER",
        passwordHash: null,
      });

      expect(await auditDetails(prisma, "admin.user.create")).toEqual([
        {
          targetUserId: account.id,
          username: "returning-person",
          reason: "backup_restore",
          backupId,
        },
      ]);
      expect(await auditDetails(prisma, "admin.backups.upload")).toEqual([
        expect.objectContaining({ ownerId: account.id, into: "new" }),
      ]);
      expect(await cellsNaming(prisma, OWNER_ID)).toEqual([]);

      // How the person gets in: the admin sets a first password with the
      // existing reset, which is all the new account needs.
      const { POST: resetPassword } =
        await import("@/app/api/admin/users/[id]/reset-password/route");
      const { NextRequest } = await import("next/server");
      const reset = await resetPassword(
        new NextRequest(
          `http://localhost/api/admin/users/${account.id}/reset-password`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password: "Harbour-lantern-47-quietly" }),
          },
        ),
        { params: Promise.resolve({ id: account.id }) },
      );
      expect(reset.status, await reset.clone().text()).toBe(200);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: account.id } }))
          .passwordHash,
      ).not.toBeNull();
      expect(admin.role).toBe("ADMIN");
    },
    SLOW,
  );

  it(
    "refuses an account that holds records, a managed profile, an account pending deletion and a wrong confirmation, before reading the file",
    async () => {
      const prisma = getPrismaClient();
      const { json } = await eraseAfterExport(prisma);
      const used = await prisma.user.create({
        data: { username: "in-use", email: "in-use@example.test" },
      });
      await prisma.measurement.create({
        data: {
          userId: used.id,
          type: "WEIGHT",
          value: 80,
          unit: "kg",
          measuredAt: new Date("2026-10-01T08:00:00.000Z"),
        },
      });
      const managed = await prisma.user.create({
        data: { username: "managed-cafe01", managedProfileAt: new Date() },
      });
      const leaving = await prisma.user.create({
        data: {
          username: "leaving",
          deletionRequestedAt: new Date(),
          deletionPurgeAt: new Date(Date.now() + 14 * DAY_MS),
        },
      });
      const empty = await prisma.user.create({ data: { username: "empty" } });

      expect((await checkTarget(used.id)).body.data).toMatchObject({
        eligible: false,
        reason: "holds_records",
        models: ["Measurement"],
      });
      expect((await checkTarget("no-such-account")).status).toBe(404);

      const cases: Array<[BackupUploadTarget, number, string]> = [
        [
          { into: "existing", userId: used.id, confirm: "in-use" },
          409,
          "backup.target.holds_records",
        ],
        [
          { into: "existing", userId: managed.id, confirm: "managed-cafe01" },
          409,
          "backup.target.managed_profile",
        ],
        [
          { into: "existing", userId: leaving.id, confirm: "leaving" },
          409,
          "backup.target.pending_deletion",
        ],
        [
          { into: "existing", userId: "no-such-account", confirm: "x" },
          404,
          "backup.target.not_found",
        ],
        [
          { into: "existing", userId: empty.id, confirm: "Empty" },
          422,
          "backup.target.unconfirmed",
        ],
        [
          { into: "new", username: "in-use" },
          409,
          "backup.target.username_taken",
        ],
      ];
      for (const [target, status, code] of cases) {
        await prisma.rateLimit.deleteMany();
        const refused = await uploadInto(json, target);
        expect(refused.status, JSON.stringify(refused.body)).toBe(status);
        expect(refused.body.meta?.errorCode).toBe(code);
      }

      expect(await prisma.dataBackup.count()).toBe(0);
      expect(
        await prisma.measurement.count({ where: { userId: used.id } }),
      ).toBe(1);
      expect(
        (await auditDetails(prisma, "admin.backups.upload.denied")).map(
          (details) => (details as { reason: string }).reason,
        ),
      ).toEqual([
        "target_holds_records",
        "target_managed_profile",
        "target_pending_deletion",
        "target_not_found",
        "target_unconfirmed",
        "target_username_taken",
      ]);

      // A query that does not parse is refused with every issue.
      await prisma.rateLimit.deleteMany();
      const malformed = await upload(json, "?into=new&username=no%20spaces");
      expect(malformed.status).toBe(422);
      expect(
        await prisma.user.count({ where: { username: "no spaces" } }),
      ).toBe(0);
    },
    SLOW,
  );

  it(
    "refuses a target for a file whose own account is still here, and removes an account made for it",
    async () => {
      const prisma = getPrismaClient();
      const { json } = await eraseAfterExport(prisma);
      await createOwner(prisma);
      const empty = await prisma.user.create({ data: { username: "empty" } });
      const usersBefore = await prisma.user.count();

      const existing = await uploadInto(json, {
        into: "existing",
        userId: empty.id,
        confirm: "empty",
      });
      expect(existing.status, JSON.stringify(existing.body)).toBe(409);
      expect(existing.body.meta?.errorCode).toBe("backup.owner.exists");

      await prisma.rateLimit.deleteMany();
      const fresh = await uploadInto(json, {
        into: "new",
        username: "would-be-copy",
      });
      expect(fresh.status, JSON.stringify(fresh.body)).toBe(409);
      expect(fresh.body.meta?.errorCode).toBe("backup.owner.exists");
      expect(await prisma.user.count()).toBe(usersBefore);
      expect(
        await prisma.user.count({ where: { username: "would-be-copy" } }),
      ).toBe(0);
      expect(await auditDetails(prisma, "admin.user.create")).toEqual([]);
      expect(await prisma.dataBackup.count()).toBe(0);

      // Without a target, the same file goes to its own account as before.
      await prisma.rateLimit.deleteMany();
      const own = await upload(json);
      expect(own.status, JSON.stringify(own.body)).toBe(201);
      expect(
        (
          await prisma.dataBackup.findUniqueOrThrow({
            where: { id: own.body.data!.id },
          })
        ).userId,
      ).toBe(OWNER_ID);
    },
    SLOW,
  );

  it(
    "refuses a non-admin session and an admin's Bearer token, and creates nothing",
    async () => {
      const prisma = getPrismaClient();
      const { admin, json } = await eraseAfterExport(prisma);
      const member = await prisma.user.create({ data: { username: "member" } });
      const empty = await prisma.user.create({ data: { username: "empty" } });
      const usersBefore = await prisma.user.count();

      cookieJar.clear();
      await signIn(prisma, member.id);
      const asMember = await uploadInto(json, {
        into: "new",
        username: "member-made",
      });
      expect(asMember.status).toBe(403);
      expect((await checkTarget(empty.id)).status).toBe(403);

      cookieJar.clear();
      const raw = `hlk_erasedrestore_${"0".repeat(48)}`;
      await prisma.apiToken.create({
        data: {
          userId: admin.id,
          name: "wildcard",
          tokenHash: hashToken(raw),
          permissions: ["*"],
        },
      });
      headerJar.set("authorization", `Bearer ${raw}`);
      const asBearer = await uploadInto(json, {
        into: "existing",
        userId: empty.id,
        confirm: "empty",
      });
      expect(asBearer.status).toBe(401);
      expect((await checkTarget(empty.id)).status).toBe(401);

      expect(await prisma.user.count()).toBe(usersBefore);
      expect(await prisma.dataBackup.count()).toBe(0);
    },
    SLOW,
  );
});
