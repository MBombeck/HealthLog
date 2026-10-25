/**
 * Deleting an account, or wiping its data, takes its off-host copies out of
 * the bucket.
 *
 * The bucket is replaced at the client boundary (`getS3Client`) by an
 * in-memory map; everything above it is real: the route, its transaction, the
 * request row it commits and the purge job that works it. Mutations that must
 * turn this red: drop `requestOffhostPurge` from either route (no request is
 * written and the objects stay), or write the request outside the deletion's
 * transaction and let it fail (the deletion commits without one).
 *
 * With a deletion grace window the objects stay until it ends: an account
 * deletion writes no request until the purge job erases the account, and a
 * wipe's request waits for its `notBefore`. Mutations that must turn the
 * second block red: purge in the deletion route again, or drop the
 * `notBefore` filter from the purge job.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const bucket = vi.hoisted(() => new Set<string>());

vi.mock("@/lib/jobs/offhost-backup", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/jobs/offhost-backup")>();
  return {
    ...actual,
    getS3Client: vi.fn(async () => ({
      putObject: vi.fn(),
      putStream: vi.fn(),
      getObject: vi.fn(),
      headObject: vi.fn(),
      listObjects: vi.fn(async (prefix: string) =>
        [...bucket].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
      ),
      deleteObject: vi.fn(async (key: string) => {
        bucket.delete(key);
      }),
    })),
  };
});

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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  bucket.clear();
  process.env.BACKUP_S3_ENDPOINT = "https://r2.example";
  process.env.BACKUP_S3_BUCKET = "hl-backups";
  process.env.BACKUP_S3_ACCESS_KEY = "AKIA";
  process.env.BACKUP_S3_SECRET_KEY = "secret";
  process.env.BACKUP_ENCRYPTION_KEY = "ab".repeat(32);
});

async function seedUserWithSession(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: { username, email: `${username}@example.test` },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user.id;
}

function seedBucket(userId: string, otherId: string) {
  for (const day of ["2026-09-01", "2026-09-02", "2026-09-03"]) {
    bucket.add(`${day}/user-${userId}.json.enc`);
    bucket.add(`${day}/user-${otherId}.json.enc`);
  }
  bucket.add("_healthcheck/1.bin");
}

describe("off-host copies leave with the account", () => {
  it("account deletion removes every copy of that account", async () => {
    const prisma = getPrismaClient();
    const other = await prisma.user.create({
      data: { username: "neighbour", email: "neighbour@example.test" },
    });
    const userId = await seedUserWithSession("leaving");
    seedBucket(userId, other.id);

    const { DELETE } = await import("@/app/api/settings/account/route");
    const res = await DELETE(
      new NextRequest("http://localhost/api/settings/account", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE_ACCOUNT" }),
      }),
    );
    expect(res.status).toBe(200);

    const pending = await prisma.offhostPurgeRequest.findMany();
    expect(pending.map((r) => [r.subjectId, r.reason])).toEqual([
      [userId, "account_deleted"],
    ]);

    const { processOffhostPurges } = await import("@/lib/jobs/offhost-purge");
    const report = await processOffhostPurges(prisma);
    expect(report).toMatchObject({ completed: 1, objectsDeleted: 3 });
    expect([...bucket].filter((k) => k.includes(userId))).toEqual([]);
    expect([...bucket].filter((k) => k.includes(other.id))).toHaveLength(3);
    expect(bucket.has("_healthcheck/1.bin")).toBe(true);
    expect(await prisma.offhostPurgeRequest.count()).toBe(0);
  });

  it("delete-all-data removes every copy and leaves the receipt", async () => {
    const prisma = getPrismaClient();
    const other = await prisma.user.create({
      data: { username: "neighbour2", email: "neighbour2@example.test" },
    });
    const userId = await seedUserWithSession("wiping");
    seedBucket(userId, other.id);

    const { DELETE } = await import("@/app/api/settings/data/route");
    const res = await DELETE(
      new NextRequest("http://localhost/api/settings/data", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      }),
    );
    expect(res.status).toBe(200);

    const { processOffhostPurges } = await import("@/lib/jobs/offhost-purge");
    await processOffhostPurges(prisma);
    expect([...bucket].filter((k) => k.includes(userId))).toEqual([]);
    expect([...bucket].filter((k) => k.includes(other.id))).toHaveLength(3);
    const receipt = await prisma.auditLog.findFirst({
      where: { action: "offhost.backup.purged", userId },
    });
    expect(receipt).not.toBeNull();

    // The request outlives the purge until a nightly run has walked the
    // account since the wipe: the upload in flight at the wipe reads it to
    // throw its pre-wipe copy away.
    expect(await prisma.offhostPurgeRequest.count()).toBe(1);
    await prisma.offhostBackupState.upsert({
      where: { userId },
      create: { userId, lastAttemptAt: new Date(Date.now() + 1000) },
      update: { lastAttemptAt: new Date(Date.now() + 1000) },
    });
    const report = await processOffhostPurges(prisma);
    expect(report).toMatchObject({ completed: 1, awaitingRun: 0 });
    expect(await prisma.offhostPurgeRequest.count()).toBe(0);
  });
});

describe("with a deletion grace window, the copies wait for it", () => {
  beforeEach(() => {
    vi.stubEnv("ACCOUNT_DELETION_GRACE_DAYS", "14");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function deleteAccount() {
    const { DELETE } = await import("@/app/api/settings/account/route");
    return DELETE(
      new NextRequest("http://localhost/api/settings/account", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE_ACCOUNT" }),
      }),
    );
  }

  it("keeps an undone deletion's copies, and purges them once the window ends", async () => {
    const prisma = getPrismaClient();
    const other = await prisma.user.create({
      data: { username: "neighbour3", email: "neighbour3@example.test" },
    });
    const admin = await prisma.user.create({
      data: { username: "admin3", email: "admin3@example.test", role: "ADMIN" },
    });
    const userId = await seedUserWithSession("changing-mind");
    seedBucket(userId, other.id);

    // Locked, not erased: no request, every copy still there.
    expect((await deleteAccount()).status).toBe(200);
    expect(await prisma.offhostPurgeRequest.count()).toBe(0);
    const { processOffhostPurges } = await import("@/lib/jobs/offhost-purge");
    await processOffhostPurges(prisma);
    expect([...bucket].filter((k) => k.includes(userId))).toHaveLength(3);

    // Undone: still every copy.
    const { cancelAccountDeletion } =
      await import("@/lib/account-deletion/lifecycle");
    expect(await cancelAccountDeletion({ userId, adminId: admin.id })).toBe(
      "cancelled",
    );
    expect([...bucket].filter((k) => k.includes(userId))).toHaveLength(3);

    // Deleted again and left to run out: the purge job erases the account and
    // writes the request with the erasure; the off-host purge empties it.
    const session = await prisma.session.create({
      data: { userId, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    cookieJar.set("healthlog_session", session.id);
    expect((await deleteAccount()).status).toBe(200);
    await prisma.user.update({
      where: { id: userId },
      data: { deletionPurgeAt: new Date(Date.now() - 1000) },
    });
    const { processDueAccountDeletions } =
      await import("@/lib/jobs/account-deletion-purge");
    expect(await processDueAccountDeletions(new Date())).toMatchObject({
      purged: 1,
    });
    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();
    const pending = await prisma.offhostPurgeRequest.findMany();
    expect(pending.map((r) => [r.subjectId, r.reason, r.notBefore])).toEqual([
      [userId, "account_deleted", null],
    ]);
    const report = await processOffhostPurges(prisma);
    expect(report).toMatchObject({ completed: 1, objectsDeleted: 3 });
    expect([...bucket].filter((k) => k.includes(userId))).toEqual([]);
    expect([...bucket].filter((k) => k.includes(other.id))).toHaveLength(3);
  });

  it("holds a wipe's purge back until the window ends", async () => {
    const prisma = getPrismaClient();
    const other = await prisma.user.create({
      data: { username: "neighbour4", email: "neighbour4@example.test" },
    });
    const userId = await seedUserWithSession("wiping-later");
    seedBucket(userId, other.id);

    const { DELETE } = await import("@/app/api/settings/data/route");
    const res = await DELETE(
      new NextRequest("http://localhost/api/settings/data", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      }),
    );
    expect(res.status).toBe(200);

    const [request] = await prisma.offhostPurgeRequest.findMany();
    expect(request?.reason).toBe("data_wiped");
    expect(request!.notBefore!.getTime() - Date.now()).toBeGreaterThan(
      13.9 * 24 * 60 * 60 * 1000,
    );

    // Not due: nothing leaves the bucket.
    const { processOffhostPurges } = await import("@/lib/jobs/offhost-purge");
    expect(await processOffhostPurges(prisma)).toMatchObject({
      pending: 0,
      objectsDeleted: 0,
    });
    expect([...bucket].filter((k) => k.includes(userId))).toHaveLength(3);

    // Due: the copies from before the wipe go, as an immediate wipe's did.
    await prisma.offhostPurgeRequest.update({
      where: { id: request!.id },
      data: { notBefore: new Date(Date.now() - 1000) },
    });
    const report = await processOffhostPurges(prisma);
    expect(report.objectsDeleted).toBe(3);
    expect([...bucket].filter((k) => k.includes(userId))).toEqual([]);
    expect([...bucket].filter((k) => k.includes(other.id))).toHaveLength(3);
  });
});
