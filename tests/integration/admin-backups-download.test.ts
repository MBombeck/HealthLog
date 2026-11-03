/**
 * Integration test for `GET /api/admin/backups/[id]/download`.
 *
 * Verifies:
 *   - 200 + content-type=application/json + content-disposition=attachment
 *   - the streamed body is non-empty and round-trips through
 *     `parseBackupPayload()` (proves we shipped the same shape we'll
 *     accept via the upload route).
 *   - 404 on unknown id (with audit-log denial entry).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Crypto module reads `ENCRYPTION_KEY` at first call. Vitest doesn't load
// the dev `.env`, so seed a deterministic 32-byte test key BEFORE the
// `@/lib/crypto` import below (Node binds module-level imports first, but
// `loadKeys()` is lazy — runs on first `encrypt()` call — so an env set
// here is observed in time).
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";
import { parseBackupPayload } from "@/lib/validations/backup";

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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function seedAdminSession() {
  const prisma = getPrismaClient();
  const admin = await prisma.user.create({
    data: {
      username: "backup-admin",
      email: "backup-admin@example.test",
      role: "ADMIN",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: admin.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return admin;
}

describe("GET /api/admin/backups/[id]/download", () => {
  it("streams a valid backup payload as JSON with Content-Disposition", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();

    const payload = {
      schemaVersion: "1",
      exportedAt: "2026-05-09T10:00:00.000Z",
      userId: admin.id,
      measurements: [
        {
          type: "WEIGHT",
          value: 82.4,
          unit: "kg",
          measuredAt: "2026-05-08T07:00:00.000Z",
          source: "MANUAL",
          notes: null,
        },
      ],
      medications: [],
      intakeEvents: [],
      moodEntries: [],
    };
    const encrypted = encrypt(JSON.stringify(payload));
    const backup = await prisma.dataBackup.create({
      data: {
        userId: admin.id,
        type: "WEEKLY_AUTO",
        data: encrypted,
      },
    });

    const { GET } = await import("@/app/api/admin/backups/[id]/download/route");
    const req = new Request(
      `http://localhost/api/admin/backups/${backup.id}/download`,
    );
    const res = await GET(req as unknown as Parameters<typeof GET>[0], {
      params: Promise.resolve({ id: backup.id }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition") ?? "").toMatch(
      /^attachment;\s*filename=".+\.json"$/i,
    );

    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
    const parsed = parseBackupPayload(text);
    expect(parsed.userId).toBe(admin.id);
    expect(parsed.measurements).toHaveLength(1);

    // Audit trail: a download event must be present.
    const events = await prisma.auditLog.findMany({
      where: { action: "admin.backups.download" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.userId).toBe(admin.id);
  });

  it("returns 404 for an unknown id and audits the denied attempt", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();

    const { GET } = await import("@/app/api/admin/backups/[id]/download/route");
    const req = new Request(
      "http://localhost/api/admin/backups/does-not-exist/download",
    );
    const res = await GET(req as unknown as Parameters<typeof GET>[0], {
      params: Promise.resolve({ id: "does-not-exist" }),
    });

    expect(res.status).toBe(404);

    const denied = await prisma.auditLog.findMany({
      where: { action: "admin.backups.download.denied", userId: admin.id },
    });
    expect(denied).toHaveLength(1);
  });
});
