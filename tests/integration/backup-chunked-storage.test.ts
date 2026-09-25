/**
 * #1031 — a stored backup kept in pieces.
 *
 * v1.39.1 wrote a backup a piece at a time but still joined the pieces into
 * one value in `data_backups.data`, and one value has to pass through the app
 * whole. So a copy could be at most a fifth of the heap, 105 MB in a 1 GB
 * container, and an account with 1.75 million readings could not be backed up
 * at all. A copy is now a run of sealed pieces in `data_backup_chunks`, and
 * this file pins what that has to keep true:
 *
 *   - the weekly copy restores exactly, and the size it lists is what it takes;
 *   - a piece dropped, moved, altered or cut off the end is refused, and the
 *     refusal comes before the restore deletes anything;
 *   - a copy stored in one value by an earlier release still restores;
 *   - a run that fails halfway leaves the previous copy whole and readable;
 *   - replacing, wiping or deleting a copy takes its pieces with it.
 *
 * The pieces are made small here (`chunkBytes`) so a record that fits a test
 * run still spans many of them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { readStoredBackup } from "./stored-backup-read";
import { legacyStreamedBlobFrom } from "@/__tests__/helpers/legacy-backup-blob";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";
import { restoreBackup } from "@/lib/export/restore-backup";
import { storeBackupBlob } from "@/lib/export/store-backup-blob";
import { STORED_BACKUP_SELECT } from "@/lib/export/stored-backup";

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

const COUNT = 12_000;
/** Small pieces, so a test-sized record spans many of them. */
const SMALL = { chunkBytes: 4 * 1024 };

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function seedAccount() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "chunked-owner",
      email: "chunked-owner@example.test",
      role: "ADMIN",
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  const start = Date.UTC(2024, 0, 1);
  await prisma.measurement.createMany({
    data: Array.from({ length: COUNT }, (_, i) => ({
      id: `m-${String(i).padStart(5, "0")}`,
      userId: user.id,
      type: i % 2 === 0 ? ("PULSE" as const) : ("WEIGHT" as const),
      value: 50 + (i % 40) + 0.5,
      unit: i % 2 === 0 ? "bpm" : "kg",
      source: "APPLE_HEALTH" as const,
      measuredAt: new Date(start + i * 600_000),
      externalId: `hk-${i}`,
    })),
  });
  return user;
}

async function measurementsOf(userId: string) {
  return getPrismaClient().measurement.findMany({
    where: { userId },
    orderBy: { id: "asc" },
    omit: { createdAt: true, updatedAt: true },
  });
}

/** The weekly job's own write, with small pieces. */
async function weeklyCopy(
  userId: string,
  options: { chunkBytes: number; maxBytes?: number } = SMALL,
) {
  const prisma = getPrismaClient();
  return storeBackupBlob(
    prisma,
    { userId, type: "WEEKLY_AUTO" },
    (write) =>
      streamFullBackupJson(prisma, userId, write, {
        purpose: "disaster-recovery",
      }),
    options,
  );
}

async function restoreRoute(id: string) {
  const { POST } = await import("./restore-job-driver");
  return POST(
    new Request(`http://localhost/api/admin/backups/${id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "RESTORE" }),
    }) as never,
    { params: Promise.resolve({ id }) },
  );
}

/** The restore itself, without the route's admission check in front of it. */
async function restoreDirect(id: string, actorUserId: string) {
  const backup = await getPrismaClient().dataBackup.findUniqueOrThrow({
    where: { id },
    select: STORED_BACKUP_SELECT,
  });
  return restoreBackup({
    backup,
    actorUserId,
    ipAddress: null,
    restoreInstanceSettings: false,
  });
}

async function chunksOf(backupId: string) {
  return getPrismaClient().dataBackupChunk.findMany({
    where: { backupId },
    orderBy: { seq: "asc" },
  });
}

describe("a backup stored in pieces", () => {
  it("restores every measurement exactly, from many pieces", async () => {
    const user = await seedAccount();
    const before = await measurementsOf(user.id);
    const { id, chunks } = await weeklyCopy(user.id);
    expect(chunks).toBeGreaterThan(5);

    const prisma = getPrismaClient();
    const row = await prisma.dataBackup.findUniqueOrThrow({ where: { id } });
    expect(row.data).toBeNull();
    expect(row.chunkCount).toBe(chunks);
    expect(await chunksOf(id)).toHaveLength(chunks);

    await prisma.measurement.deleteMany({ where: { userId: user.id } });
    const res = await restoreRoute(id);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await measurementsOf(user.id)).toEqual(before);
  });

  it("previews and downloads the copy the job stored", async () => {
    const user = await seedAccount();
    const { id } = await weeklyCopy(user.id);
    const params = { params: Promise.resolve({ id }) };

    const { GET: summary } =
      await import("@/app/api/admin/backups/[id]/summary/route");
    const preview = await summary(new Request("http://x") as never, params);
    expect(preview.status).toBe(200);
    const { data } = (await preview.json()) as {
      data: { summary: { measurements: number } };
    };
    expect(data.summary.measurements).toBe(COUNT);

    const { GET: download } =
      await import("@/app/api/admin/backups/[id]/download/route");
    const file = await download(new Request("http://x") as never, params);
    expect(file.status).toBe(200);
    const text = await file.text();
    expect(Number(file.headers.get("content-length"))).toBe(
      Buffer.byteLength(text),
    );
    expect(text).toBe(await readStoredBackup(getPrismaClient(), id));
    expect(JSON.parse(text).measurements).toHaveLength(COUNT);
  });

  it("lists the size the copy takes in the database, in either form", async () => {
    const user = await seedAccount();
    const prisma = getPrismaClient();
    const { id, bytes } = await weeklyCopy(user.id);
    const legacy = await prisma.dataBackup.create({
      data: {
        userId: user.id,
        type: "MANUAL_UPLOAD_1",
        data: await legacyStreamedBlobFrom((write) =>
          streamFullBackupJson(prisma, user.id, write, {
            purpose: "disaster-recovery",
          }),
        ),
      },
    });

    const { GET } = await import("@/app/api/admin/backups/route");
    const res = await GET();
    const { data } = (await res.json()) as {
      data: { rows: Array<{ id: string; sizeBytes: number }> };
    };
    const sizes = new Map(data.rows.map((b) => [b.id, b.sizeBytes]));
    expect(sizes.get(id)).toBe(bytes);
    expect(sizes.get(legacy.id)).toBe(legacy.data!.length);
  });
});

describe("a stored copy whose pieces do not add up is refused before anything is deleted", () => {
  type Tamper = (backupId: string) => Promise<void>;
  const prisma = () => getPrismaClient();

  const cases: Array<[string, Tamper]> = [
    [
      "a piece dropped from the middle",
      async (backupId) => {
        await prisma().dataBackupChunk.deleteMany({
          where: { backupId, seq: 2 },
        });
      },
    ],
    [
      "two pieces swapped",
      async (backupId) => {
        const [a, b] = [
          await prisma().dataBackupChunk.findUniqueOrThrow({
            where: { backupId_seq: { backupId, seq: 1 } },
          }),
          await prisma().dataBackupChunk.findUniqueOrThrow({
            where: { backupId_seq: { backupId, seq: 2 } },
          }),
        ];
        await prisma().dataBackupChunk.update({
          where: { id: a.id },
          data: { data: b.data },
        });
        await prisma().dataBackupChunk.update({
          where: { id: b.id },
          data: { data: a.data },
        });
      },
    ],
    [
      "one byte of a piece altered",
      async (backupId) => {
        const piece = await prisma().dataBackupChunk.findUniqueOrThrow({
          where: { backupId_seq: { backupId, seq: 3 } },
        });
        const altered = new Uint8Array(piece.data);
        altered[altered.byteLength - 20]! ^= 0x01;
        await prisma().dataBackupChunk.update({
          where: { id: piece.id },
          data: { data: altered },
        });
      },
    ],
    [
      "the last piece cut off, and the count lowered to match",
      async (backupId) => {
        const row = await prisma().dataBackup.findUniqueOrThrow({
          where: { id: backupId },
        });
        const last = row.chunkCount! - 1;
        await prisma().dataBackupChunk.deleteMany({
          where: { backupId, seq: last },
        });
        await prisma().dataBackup.update({
          where: { id: backupId },
          data: { chunkCount: last },
        });
      },
    ],
  ];

  for (const [name, tamper] of cases) {
    it(`${name}: the route refuses, the job refuses, nothing changes`, async () => {
      const user = await seedAccount();
      const { id } = await weeklyCopy(user.id);
      await tamper(id);
      const before = await measurementsOf(user.id);
      expect(before).toHaveLength(COUNT);

      const res = await restoreRoute(id);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { meta?: { errorCode?: string } };
      expect(body.meta?.errorCode).toBe("backup.payload.undecryptable");

      // The job refuses on its own too, for a copy tampered with after the
      // route admitted it.
      const outcome = await restoreDirect(id, user.id);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok)
        expect(outcome.code).toBe("backup.payload.undecryptable");

      expect(await measurementsOf(user.id)).toEqual(before);
    });
  }

  it("a piece from another account's copy put in its place", async () => {
    const user = await seedAccount();
    const other = await getPrismaClient().user.create({
      data: { username: "other", email: "other@example.test" },
    });
    await getPrismaClient().measurement.createMany({
      data: Array.from({ length: COUNT }, (_, i) => ({
        userId: other.id,
        type: "PULSE" as const,
        value: 70,
        unit: "bpm",
        source: "APPLE_HEALTH" as const,
        measuredAt: new Date(Date.UTC(2025, 0, 1) + i * 60_000),
      })),
    });
    const mine = await weeklyCopy(user.id);
    const theirs = await weeklyCopy(other.id);
    const foreign = await getPrismaClient().dataBackupChunk.findUniqueOrThrow({
      where: { backupId_seq: { backupId: theirs.id, seq: 1 } },
    });
    await getPrismaClient().dataBackupChunk.update({
      where: { backupId_seq: { backupId: mine.id, seq: 1 } },
      data: { data: foreign.data },
    });
    const before = await measurementsOf(user.id);

    expect((await restoreRoute(mine.id)).status).toBe(422);
    const outcome = await restoreDirect(mine.id, user.id);
    expect(outcome.ok).toBe(false);
    expect(await measurementsOf(user.id)).toEqual(before);
  });

  it("the preview and the download refuse the same copy with the same answer", async () => {
    const user = await seedAccount();
    const { id } = await weeklyCopy(user.id);
    await getPrismaClient().dataBackupChunk.deleteMany({
      where: { backupId: id, seq: 1 },
    });
    const params = { params: Promise.resolve({ id }) };
    const { GET: summary } =
      await import("@/app/api/admin/backups/[id]/summary/route");
    const { GET: download } =
      await import("@/app/api/admin/backups/[id]/download/route");
    for (const res of [
      await summary(new Request("http://x") as never, params),
      await download(new Request("http://x") as never, params),
    ]) {
      expect(res.status).toBe(422);
      const body = (await res.json()) as { meta?: { errorCode?: string } };
      expect(body.meta?.errorCode).toBe("backup.payload.undecryptable");
    }
  });
});

describe("an uploaded backup file", () => {
  it("is stored in pieces under the account the file names, not the admin who sent it", async () => {
    const admin = await seedAccount();
    const prisma = getPrismaClient();
    const owner = await prisma.user.create({
      data: { username: "file-owner", email: "file-owner@example.test" },
    });
    await prisma.measurement.create({
      data: {
        userId: owner.id,
        type: "WEIGHT",
        value: 71.5,
        unit: "kg",
        source: "MANUAL",
        measuredAt: new Date(Date.UTC(2025, 5, 1)),
      },
    });
    const weekly = await weeklyCopy(owner.id);
    const file = await readStoredBackup(prisma, weekly.id);

    const { POST: upload } =
      await import("@/app/api/admin/backups/upload/route");
    const res = await upload(
      new Request("http://localhost/api/admin/backups/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: file,
      }) as never,
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const row = await prisma.dataBackup.findUniqueOrThrow({
      where: { id: data.id },
    });
    expect(row.userId).toBe(owner.id);
    expect(row.userId).not.toBe(admin.id);
    expect(row.data).toBeNull();
    expect(await readStoredBackup(prisma, data.id)).toBe(file);
  });
});

describe("a copy stored in one value by an earlier release", () => {
  it("still restores exactly", async () => {
    const user = await seedAccount();
    const prisma = getPrismaClient();
    const before = await measurementsOf(user.id);
    const legacy = await prisma.dataBackup.create({
      data: {
        userId: user.id,
        type: "WEEKLY_AUTO",
        data: await legacyStreamedBlobFrom((write) =>
          streamFullBackupJson(prisma, user.id, write, {
            purpose: "disaster-recovery",
          }),
        ),
      },
    });
    await prisma.measurement.deleteMany({ where: { userId: user.id } });

    expect((await restoreRoute(legacy.id)).status).toBe(200);
    expect(await measurementsOf(user.id)).toEqual(before);
  });

  it("is replaced in pieces by the next weekly run", async () => {
    const user = await seedAccount();
    const prisma = getPrismaClient();
    const legacy = await prisma.dataBackup.create({
      data: {
        userId: user.id,
        type: "WEEKLY_AUTO",
        data: await legacyStreamedBlobFrom(async (write) => {
          await write("{}");
        }),
      },
    });
    const { id, chunks } = await weeklyCopy(user.id);
    expect(id).toBe(legacy.id);
    const row = await prisma.dataBackup.findUniqueOrThrow({ where: { id } });
    expect(row.data).toBeNull();
    expect(row.chunkCount).toBe(chunks);
  });
});

describe("a restore queued against a copy that is then replaced", () => {
  it("is refused as backup_changed, and nothing is deleted", async () => {
    const user = await seedAccount();
    const { id } = await weeklyCopy(user.id);
    const { acceptingBoss } = await import("./restore-job-driver");
    const { POST: queueRestore } =
      await import("@/app/api/admin/backups/[id]/restore/route");
    const { getGlobalBoss, setGlobalBoss } =
      await import("@/lib/jobs/boss-instance");
    const { readBackupRestoreJob, runBackupRestoreJob } =
      await import("@/lib/jobs/backup-restore");

    const previous = getGlobalBoss();
    setGlobalBoss(acceptingBoss);
    let queued: Response;
    try {
      queued = await queueRestore(
        new Request(`http://localhost/api/admin/backups/${id}/restore`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: "RESTORE" }),
        }) as never,
        { params: Promise.resolve({ id }) },
      );
    } finally {
      setGlobalBoss(previous);
    }
    expect(queued.status).toBe(202);
    const { data } = (await queued.json()) as { data: { jobId: string } };

    // The next weekly run writes a new copy into the same row.
    await weeklyCopy(user.id);
    const before = await measurementsOf(user.id);
    await runBackupRestoreJob(data.jobId).catch(() => undefined);
    const job = await readBackupRestoreJob(data.jobId);
    expect(job?.failure?.code).toBe("backup_changed");
    expect(await measurementsOf(user.id)).toEqual(before);
  });
});

describe("writing and removing copies", () => {
  it("keeps the previous copy whole when a run fails after writing pieces", async () => {
    const user = await seedAccount();
    const prisma = getPrismaClient();
    const first = await weeklyCopy(user.id);
    const before = await prisma.dataBackup.findUniqueOrThrow({
      where: { id: first.id },
    });
    const text = await readStoredBackup(prisma, first.id);

    let written = 0;
    await expect(
      storeBackupBlob(
        prisma,
        { userId: user.id, type: "WEEKLY_AUTO" },
        async (write) => {
          await streamFullBackupJson(
            prisma,
            user.id,
            async (chunk) => {
              await write(chunk);
              written += chunk.length;
              if (written > 200 * 1024) throw new Error("read failed halfway");
            },
            { purpose: "disaster-recovery" },
          );
        },
        SMALL,
      ),
    ).rejects.toThrow("read failed halfway");

    const after = await prisma.dataBackup.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(after.chunkStreamId).toBe(before.chunkStreamId);
    expect(after.chunkCount).toBe(before.chunkCount);
    expect(after.createdAt).toEqual(before.createdAt);
    expect(await chunksOf(first.id)).toHaveLength(first.chunks);
    expect(await readStoredBackup(prisma, first.id)).toBe(text);
  });

  it("stops at the stored-copy limit and keeps the previous copy", async () => {
    const user = await seedAccount();
    const first = await weeklyCopy(user.id);
    await expect(
      weeklyCopy(user.id, { ...SMALL, maxBytes: 16 * 1024 }),
    ).rejects.toThrow(/BACKUP_MAX_STORED_MB/);
    expect(await chunksOf(first.id)).toHaveLength(first.chunks);
  });

  it("replacing a copy leaves only the new copy's pieces", async () => {
    const user = await seedAccount();
    const prisma = getPrismaClient();
    const first = await weeklyCopy(user.id);
    const second = await weeklyCopy(user.id);
    expect(second.id).toBe(first.id);
    expect(await prisma.dataBackupChunk.count()).toBe(second.chunks);
  });

  it("wiping the account's data and deleting the account take the pieces with them", async () => {
    const user = await seedAccount();
    const prisma = getPrismaClient();
    await weeklyCopy(user.id);
    expect(await prisma.dataBackupChunk.count()).toBeGreaterThan(0);
    // The wipe deletes `DataBackup` by owner; the pieces follow by cascade.
    await prisma.dataBackup.deleteMany({ where: { userId: user.id } });
    expect(await prisma.dataBackupChunk.count()).toBe(0);

    await weeklyCopy(user.id);
    await prisma.user.delete({ where: { id: user.id } });
    expect(await prisma.dataBackupChunk.count()).toBe(0);
  });
});
