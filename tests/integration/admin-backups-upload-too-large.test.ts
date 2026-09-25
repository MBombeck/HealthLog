/**
 * An upload whose encrypted copy is too large to store is a 413, not a 500.
 *
 * One stored backup may take a fifth of the process's heap limit
 * (`defaultBackupBlobLimit`); past it the packer stops with
 * `BackupBlobTooLargeError`. The upload route let that escape as a server
 * fault, so the operator saw "internal error" and the error reporter was
 * paged for a file that is simply too large for this host. The limit is
 * lowered here through the store's own option so a small file crosses it,
 * and everything else runs as it does in production.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
vi.mock("@/lib/export/store-backup-blob", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/export/store-backup-blob")>();
  return {
    ...actual,
    storeBackupBlob: ((prisma, input, producer) =>
      actual.storeBackupBlob(prisma, input, producer, {
        maxBytes: 256,
      })) as typeof actual.storeBackupBlob,
  };
});

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("POST /api/admin/backups/upload — a copy too large to store", () => {
  it("answers 413 with the reason and stores nothing", async () => {
    const prisma = getPrismaClient();
    const admin = await prisma.user.create({
      data: {
        username: "upload-large-admin",
        email: "upload-large-admin@example.test",
        role: "ADMIN",
      },
    });
    const session = await prisma.session.create({
      data: { userId: admin.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);

    const file = JSON.stringify({
      schemaVersion: "2",
      exportedAt: "2026-09-20T00:00:00.000Z",
      userId: admin.id,
      measurements: Array.from({ length: 200 }, (_, i) => ({
        id: `m-${i}`,
        type: "PULSE",
        value: 60 + (i % 30),
        unit: "bpm",
        measuredAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
        source: "MANUAL",
      })),
    });

    const { POST } = await import("@/app/api/admin/backups/upload/route");
    const res = await POST(
      new Request("http://localhost/api/admin/backups/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: file,
      }) as never,
    );

    expect(res.status).toBe(413);
    const body = (await res.json()) as {
      error: string;
      meta?: { errorCode?: string };
    };
    expect(body.error).toContain("too large to store");
    expect(body.meta?.errorCode).toBe("backup.upload.too_large");
    expect(await prisma.dataBackup.count()).toBe(0);
    const denied = await prisma.auditLog.findFirstOrThrow({
      where: { action: "admin.backups.upload.denied" },
    });
    expect(JSON.parse(denied.details ?? "{}").reason).toBe(
      "stored_copy_too_large",
    );
  });
});
