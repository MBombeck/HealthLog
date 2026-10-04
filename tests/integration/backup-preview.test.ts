/**
 * The restore preview is worked out while a copy is written and answered from
 * the row, without opening the copy (#1031).
 *
 * Both ends and the pipe: the copies are written by the real weekly job and
 * the real upload route, the preview route reads them back, and what it
 * answers is held against a full read of the stored copy, which is how the
 * preview used to be taken. A copy from before previews is read whole once
 * and its preview kept; a key dropped after the copy was written is still
 * named, because the verdict is taken again at every read.
 *
 * Mutations that must turn this red: drop the `preview` the weekly job or
 * the upload route hands `storeBackupBlob` (no preview on the row, the route
 * opens the copy), or
 * answer from the stored verdict instead of taking it again (the dropped key
 * is not named).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetCryptoCacheForTests, encrypt } from "@/lib/crypto";
import { Prisma } from "@/generated/prisma/client";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { readStoredBackup } from "./stored-backup-read";

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

const opened = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/export/stored-backup", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/export/stored-backup")>();
  return {
    ...actual,
    openStoredBackup: (...a: Parameters<typeof actual.openStoredBackup>) => {
      opened.count += 1;
      return actual.openStoredBackup(...a);
    },
  };
});

const saved = {
  key: process.env.ENCRYPTION_KEY,
  keys: process.env.ENCRYPTION_KEYS,
  active: process.env.ENCRYPTION_ACTIVE_KEY_ID,
};

function useKeys(keys: Record<string, string>, active: string) {
  process.env.ENCRYPTION_KEY = "";
  process.env.ENCRYPTION_KEYS = JSON.stringify(keys);
  process.env.ENCRYPTION_ACTIVE_KEY_ID = active;
  _resetCryptoCacheForTests();
}
const OLD = "11".repeat(32);
const CUR = "22".repeat(32);

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  opened.count = 0;
  useKeys({ old: OLD, cur: CUR }, "cur");
});

afterEach(() => {
  process.env.ENCRYPTION_KEY = saved.key ?? "";
  process.env.ENCRYPTION_KEYS = saved.keys ?? "";
  process.env.ENCRYPTION_ACTIVE_KEY_ID = saved.active ?? "";
  _resetCryptoCacheForTests();
});

async function seedAdmin() {
  const prisma = getPrismaClient();
  const admin = await prisma.user.create({
    data: {
      username: "preview-admin",
      email: "preview-admin@example.test",
      role: "ADMIN",
    },
  });
  const session = await prisma.session.create({
    data: { userId: admin.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return admin;
}

async function preview(id: string) {
  const { GET } = await import("@/app/api/admin/backups/[id]/summary/route");
  const res = await GET(
    new Request(`http://localhost/api/admin/backups/${id}/summary`) as never,
    { params: Promise.resolve({ id }) },
  );
  return {
    status: res.status,
    body: (await res.json()) as {
      data: { summary: Record<string, unknown> } | null;
      error: string | null;
      meta?: { errorCode?: string; keyIds?: string[] };
    },
  };
}

/** The counts a full read of the stored copy gives: the old preview. */
async function fullReadSummary(id: string) {
  const { parseBackupPayload, summarizeBackup } =
    await import("@/lib/validations/backup");
  const opensBefore = opened.count;
  const payload = parseBackupPayload(
    JSON.parse(await readStoredBackup(getPrismaClient(), id)),
  );
  opened.count = opensBefore;
  return summarizeBackup(payload);
}

describe("restore preview kept with the copy", () => {
  it("the weekly backup writes it, and the preview answers from it", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdmin();
    await prisma.measurement.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({
        userId: admin.id,
        type: "PULSE" as const,
        value: 60 + i,
        unit: "bpm",
        measuredAt: new Date(Date.UTC(2026, 8, 1, 0, i)),
        source: "MANUAL" as const,
      })),
    });

    const { handleDataBackup } =
      await import("@/lib/jobs/reminder/backup-handlers");
    await handleDataBackup([]);
    const row = await prisma.dataBackup.findFirstOrThrow({
      where: { userId: admin.id, type: "WEEKLY_AUTO" },
    });
    expect(row.preview).toMatchObject({
      version: 1,
      copy: `chunks:${row.chunkStreamId}:${row.chunkCount}`,
      summary: { measurements: 25 },
    });

    const res = await preview(row.id);
    expect(res.status).toBe(200);
    expect(opened.count).toBe(0);
    expect(res.body.data!.summary).toEqual(await fullReadSummary(row.id));
    expect(res.body.data!.summary.measurements).toBe(25);
  });

  it("an upload writes it, and a key dropped later is still named", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdmin();
    // A note written under `old`, as a copy taken before a rotation carries.
    useKeys({ old: OLD, cur: CUR }, "old");
    const note = Buffer.from(encrypt("before"), "utf8").toString("base64");
    useKeys({ old: OLD, cur: CUR }, "cur");
    const file = JSON.stringify({
      schemaVersion: "2",
      exportedAt: "2026-09-20T00:00:00.000Z",
      userId: admin.id,
      measurements: Array.from({ length: 30 }, (_, i) => ({
        id: `m-${i}`,
        type: "PULSE",
        value: 60 + (i % 30),
        unit: "bpm",
        measuredAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
        source: "MANUAL",
        ...(i === 3 ? { notesEncrypted: note } : {}),
      })),
    });

    const { POST } = await import("@/app/api/admin/backups/upload/route");
    const uploaded = await POST(
      new Request("http://localhost/api/admin/backups/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: file,
      }) as never,
    );
    expect(uploaded.status).toBe(201);
    const { data: upload } = (await uploaded.json()) as {
      data: { id: string; summary: Record<string, unknown> };
    };
    const row = await prisma.dataBackup.findUniqueOrThrow({
      where: { id: upload.id },
    });
    expect(row.preview).toMatchObject({ summary: { measurements: 30 } });

    const res = await preview(upload.id);
    expect(res.status).toBe(200);
    expect(opened.count).toBe(0);
    expect(res.body.data!.summary).toEqual(upload.summary);
    expect(res.body.data!.summary).toEqual(await fullReadSummary(upload.id));

    // The operator drops `old` after the copy was written.
    useKeys({ cur: CUR }, "cur");
    const refused = await preview(upload.id);
    expect(refused.status).toBe(422);
    expect(refused.body.meta).toMatchObject({
      errorCode: "backup.key.missing",
      keyIds: ["old"],
    });
    expect(opened.count).toBe(0);
  });

  it("a copy from before previews is read whole once, then answered from the row", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdmin();
    await prisma.measurement.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        userId: admin.id,
        type: "PULSE" as const,
        value: 60 + i,
        unit: "bpm",
        measuredAt: new Date(Date.UTC(2026, 8, 1, 0, i)),
        source: "MANUAL" as const,
      })),
    });
    const { handleDataBackup } =
      await import("@/lib/jobs/reminder/backup-handlers");
    await handleDataBackup([]);
    const row = await prisma.dataBackup.findFirstOrThrow({
      where: { userId: admin.id },
    });
    // As an earlier release left it.
    await prisma.dataBackup.update({
      where: { id: row.id },
      data: { preview: Prisma.DbNull },
    });

    const first = await preview(row.id);
    expect(first.status).toBe(200);
    expect(opened.count).toBe(1);
    expect(first.body.data!.summary.measurements).toBe(5);
    await vi.waitFor(async () => {
      const kept = await prisma.dataBackup.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(kept.preview).toMatchObject({ summary: { measurements: 5 } });
    });

    const second = await preview(row.id);
    expect(second.status).toBe(200);
    expect(opened.count).toBe(1);
    expect(second.body.data!.summary).toEqual(first.body.data!.summary);
  });

  it("a replaced copy is described by its own preview", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdmin();
    const { handleDataBackup } =
      await import("@/lib/jobs/reminder/backup-handlers");
    await handleDataBackup([]);
    await prisma.measurement.create({
      data: {
        userId: admin.id,
        type: "PULSE",
        value: 61,
        unit: "bpm",
        measuredAt: new Date(Date.UTC(2026, 8, 2)),
        source: "MANUAL",
      },
    });
    await handleDataBackup([]);
    const row = await prisma.dataBackup.findFirstOrThrow({
      where: { userId: admin.id },
    });
    expect(row.preview).toMatchObject({
      copy: `chunks:${row.chunkStreamId}:${row.chunkCount}`,
      summary: { measurements: 1 },
    });
    const res = await preview(row.id);
    expect(res.body.data!.summary.measurements).toBe(1);
    expect(opened.count).toBe(0);
  });

  it("a single stored value keeps its preview when it is converted to pieces", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdmin();
    // The oldest stored form: the whole file as one encrypted value.
    const row = await prisma.dataBackup.create({
      data: {
        userId: admin.id,
        type: "MANUAL_UPLOAD_1",
        data: encrypt(
          JSON.stringify({
            schemaVersion: "1",
            exportedAt: "2026-05-09T10:00:00.000Z",
            userId: admin.id,
            measurements: [
              {
                type: "WEIGHT",
                value: 80,
                unit: "kg",
                measuredAt: "2026-05-08T07:00:00.000Z",
                source: "MANUAL",
              },
            ],
          }),
        ),
      },
    });

    const first = await preview(row.id);
    expect(first.status).toBe(200);
    expect(opened.count).toBe(1);
    await vi.waitFor(async () => {
      const kept = await prisma.dataBackup.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(kept.preview).toMatchObject({ summary: { measurements: 1 } });
    });

    const { convertSingleValueBackup } =
      await import("@/lib/export/store-backup-blob");
    expect(await convertSingleValueBackup(prisma, row.id)).toBe("converted");
    const converted = await prisma.dataBackup.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(converted.preview).toMatchObject({
      copy: `chunks:${converted.chunkStreamId}:${converted.chunkCount}`,
      summary: { measurements: 1 },
    });

    const second = await preview(row.id);
    expect(second.status).toBe(200);
    expect(opened.count).toBe(1);
    expect(second.body.data!.summary).toEqual(first.body.data!.summary);
  });
});
