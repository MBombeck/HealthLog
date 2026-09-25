/**
 * #1031 — an account too large to export or restore.
 *
 * For an account of 1.25 million measurements the full export took the app
 * down, and its weekly backup could not be restored, downloaded or summarised
 * at all: the backup's JSON (662 MB) is longer than any string V8 can hold,
 * and every reader turned the file into one string first. Measured on a
 * seeded account of that size in a 1 GB container, the streamed paths now
 * export in 25 s, upload in under 20 s and restore in 94 s, and the restored
 * rows match the file exactly.
 *
 * A million rows do not fit a test run. This file runs the same paths at a
 * size that spans many pages and batches, and checks the rows come back
 * exactly: the export streamed into the response, uploaded as gzip through
 * the raw-body path, and restored through the streamed two-pass reader; and a
 * weekly backup restored the same way, every column intact, with a personal
 * record still pointing at the measurement it was found in.
 */
import { gzipSync } from "node:zlib";

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";
import { storeBackupBlob } from "@/lib/export/store-backup-blob";
import { encryptNote } from "@/lib/crypto/note-cipher";

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

const COUNT = 7_300; // more than one read page and several write batches

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function seedAccount() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "large-account",
      email: "large-account@example.test",
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
      type: i % 3 === 0 ? ("PULSE" as const) : ("SLEEP_DURATION" as const),
      value: 50 + (i % 40) + 0.25,
      valueMax: i % 3 === 0 ? 120 : null,
      unit: i % 3 === 0 ? "bpm" : "minutes",
      source: "APPLE_HEALTH" as const,
      measuredAt: new Date(start + i * 300_000),
      externalId: `hk-${i}`,
      sleepStage: i % 3 === 0 ? null : ("CORE" as const),
      deviceType: "watch",
      syncVersion: 1 + (i % 4),
      notesEncrypted: i === 17 ? encryptNote("after the long run") : null,
      deletedAt: i % 97 === 0 ? new Date(start) : null,
    })),
  });
  await prisma.personalRecord.create({
    data: {
      userId: user.id,
      metricType: "PULSE",
      direction: "MAX",
      value: 89.25,
      unit: "bpm",
      achievedAt: new Date(start + 3 * 300_000),
      sourceMeasurementId: "m-00003",
    },
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

async function restore(id: string) {
  const { POST } = await import("./restore-job-driver");
  const res = await POST(
    new Request(`http://localhost/api/admin/backups/${id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "RESTORE" }),
    }) as never,
    { params: Promise.resolve({ id }) },
  );
  return res;
}

describe("large backups round-trip through the streamed paths (#1031)", () => {
  it("export → gzip upload → restore gives back every live measurement", async () => {
    const user = await seedAccount();
    const live = (await measurementsOf(user.id)).filter((m) => !m.deletedAt);

    const { GET } = await import("@/app/api/export/full-backup/route");
    const exported = await GET(
      new Request("http://localhost/api/export/full-backup") as never,
    );
    expect(exported.status).toBe(200);
    const file = Buffer.from(await exported.arrayBuffer());
    expect(JSON.parse(file.toString("utf8")).measurements).toHaveLength(
      live.length,
    );

    const { POST: upload } =
      await import("@/app/api/admin/backups/upload/route");
    const uploaded = await upload(
      new Request("http://localhost/api/admin/backups/upload", {
        method: "POST",
        headers: { "content-type": "application/gzip" },
        body: gzipSync(file),
      }) as never,
    );
    expect(uploaded.status).toBe(201);
    const { data } = (await uploaded.json()) as {
      data: { id: string; summary: { measurements: number } };
    };
    expect(data.summary.measurements).toBe(live.length);

    expect((await restore(data.id)).status).toBe(200);
    const restored = await measurementsOf(user.id);
    // A portable file carries the fields a person reads, not the sync
    // bookkeeping, so those are what must come back.
    const readable = (rows: typeof restored) =>
      rows.map((m) => ({
        id: m.id,
        type: m.type,
        value: m.value,
        unit: m.unit,
        measuredAt: m.measuredAt.toISOString(),
        source: m.source,
      }));
    expect(readable(restored)).toEqual(readable(live));
  });

  it("a weekly backup restores every column, and a record's pointer survives", async () => {
    const user = await seedAccount();
    const before = await measurementsOf(user.id);
    const prisma = getPrismaClient();

    const { id } = await storeBackupBlob(
      prisma,
      { userId: user.id, type: "WEEKLY_AUTO" },
      (write) =>
        streamFullBackupJson(prisma, user.id, write, {
          purpose: "disaster-recovery",
        }),
    );

    // Change the account so the restore has something to undo.
    await prisma.measurement.deleteMany({ where: { userId: user.id } });

    const res = await restore(id);
    expect(res.status).toBe(200);
    expect(await measurementsOf(user.id)).toEqual(before);
    const record = await prisma.personalRecord.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(record.sourceMeasurementId).toBe("m-00003");
  });
});
