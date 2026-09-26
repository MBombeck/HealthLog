/**
 * Integration test for `POST /api/admin/backups/upload`.
 *
 * Verifies:
 *   - 201 + a `DataBackup` row with type prefix `MANUAL_UPLOAD_` is
 *     created when the JSON file matches the schema.
 *   - the original payload round-trips through the stored backup envelope.
 *   - 422 when the JSON is malformed.
 *   - 422 when the schema validation fails (missing required field).
 *   - 422 when the userId on the file doesn't exist.
 *   - audit-log entries cover both success and denial paths.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { readStoredBackup } from "./stored-backup-read";

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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function seedAdminSession() {
  const prisma = getPrismaClient();
  const admin = await prisma.user.create({
    data: {
      username: "upload-admin",
      email: "upload-admin@example.test",
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

interface UploadPayloadFixture {
  schemaVersion: string;
  exportedAt: string;
  userId: string;
  measurements: Array<{
    type: string;
    value: number;
    unit: string;
    measuredAt: string;
    source: string;
    notes: null;
  }>;
  medications: Array<{
    name: string;
    dose: string;
    active: boolean;
    schedules: Array<{
      windowStart: string;
      windowEnd: string;
      label: string;
      dose: null;
    }>;
  }>;
  intakeEvents: [];
  moodEntries: [];
}

function buildPayload(userId: string): UploadPayloadFixture {
  return {
    schemaVersion: "1",
    exportedAt: "2026-05-09T10:00:00.000Z",
    userId,
    measurements: [
      {
        type: "WEIGHT",
        value: 80.0,
        unit: "kg",
        measuredAt: "2026-05-08T07:00:00.000Z",
        source: "MANUAL",
        notes: null,
      },
    ],
    medications: [
      {
        name: "Ramipril",
        dose: "5mg",
        active: true,
        schedules: [
          {
            windowStart: "08:00",
            windowEnd: "10:00",
            label: "Morning",
            dose: null,
          },
        ],
      },
    ],
    intakeEvents: [],
    moodEntries: [],
  };
}

function buildMultipart(file: File): Request {
  const fd = new FormData();
  fd.append("file", file);
  return new Request("http://localhost/api/admin/backups/upload", {
    method: "POST",
    body: fd,
  });
}

describe("POST /api/admin/backups/upload", () => {
  it("accepts a valid backup file and persists an encrypted DataBackup row", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();
    const payload = buildPayload(admin.id);
    const file = new File([JSON.stringify(payload)], "backup.json", {
      type: "application/json",
    });

    const { POST } = await import("@/app/api/admin/backups/upload/route");
    const res = await POST(
      buildMultipart(file) as unknown as Parameters<typeof POST>[0],
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; valid: boolean } };
    expect(body.data.valid).toBe(true);

    const row = await prisma.dataBackup.findUnique({
      where: { id: body.data.id },
    });
    expect(row).not.toBeNull();
    expect(row?.type).toMatch(/^MANUAL_UPLOAD_\d+$/);
    expect(row?.userId).toBe(admin.id);

    // Round-trip the stored blob to make sure we kept the same payload we
    // received. Through the envelope rather than through `decrypt` alone: an
    // uploaded file is stored exactly the way the weekly worker stores one, so
    // the restore path reads both without knowing where the row came from.
    const decrypted = JSON.parse(await readStoredBackup(prisma, row!.id));
    expect(decrypted.userId).toBe(admin.id);
    expect(decrypted.measurements).toHaveLength(1);

    const events = await prisma.auditLog.findMany({
      where: { action: "admin.backups.upload", userId: admin.id },
    });
    expect(events).toHaveLength(1);
  });

  it("rejects malformed JSON with 422 + audit-log denial", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();
    const file = new File(["{not-json"], "broken.json", {
      type: "application/json",
    });

    const { POST } = await import("@/app/api/admin/backups/upload/route");
    const res = await POST(
      buildMultipart(file) as unknown as Parameters<typeof POST>[0],
    );

    expect(res.status).toBe(422);
    const denied = await prisma.auditLog.findMany({
      where: { action: "admin.backups.upload.denied", userId: admin.id },
    });
    expect(denied).toHaveLength(1);
  });

  it("rejects schema-invalid JSON with 422 + audit-log denial", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();
    const broken = { schemaVersion: "1", userId: admin.id }; // missing exportedAt
    const file = new File([JSON.stringify(broken)], "missing.json", {
      type: "application/json",
    });

    const { POST } = await import("@/app/api/admin/backups/upload/route");
    const res = await POST(
      buildMultipart(file) as unknown as Parameters<typeof POST>[0],
    );

    expect(res.status).toBe(422);
    const denied = await prisma.auditLog.findMany({
      where: { action: "admin.backups.upload.denied", userId: admin.id },
    });
    expect(denied).toHaveLength(1);
  });

  it("rejects payloads referencing a non-existent owner with 422", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();
    const payload = buildPayload("ghost-user-id");
    const file = new File([JSON.stringify(payload)], "ghost.json", {
      type: "application/json",
    });

    const { POST } = await import("@/app/api/admin/backups/upload/route");
    const res = await POST(
      buildMultipart(file) as unknown as Parameters<typeof POST>[0],
    );

    expect(res.status).toBe(422);
    const denied = await prisma.auditLog.findMany({
      where: { action: "admin.backups.upload.denied", userId: admin.id },
    });
    expect(denied).toHaveLength(1);
    expect(denied[0]?.details ?? "").toContain("owner_not_found");
  });

  it.each([
    [
      "measurement type",
      (payload: UploadPayloadFixture) => {
        payload.measurements[0]!.type = "NOT_A_MEASUREMENT";
      },
    ],
    [
      "measurement source",
      (payload: UploadPayloadFixture) => {
        payload.measurements[0]!.source = "NOT_A_SOURCE";
      },
    ],
  ])(
    "rejects an invalid %s with 422 and zero backup writes",
    async (_label, mutate) => {
      const prisma = getPrismaClient();
      const admin = await seedAdminSession();
      const payload = buildPayload(admin.id);
      mutate(payload);
      const file = new File([JSON.stringify(payload)], "invalid-enum.json", {
        type: "application/json",
      });

      const { POST } = await import("@/app/api/admin/backups/upload/route");
      const res = await POST(
        buildMultipart(file) as unknown as Parameters<typeof POST>[0],
      );

      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({
        data: null,
        error: "Backup payload failed schema validation",
        meta: { issues: expect.any(Array) },
      });
      expect(await prisma.dataBackup.count()).toBe(0);
    },
  );

  it("rejects an incompatible schemaVersion with 422", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();
    const payload = { ...buildPayload(admin.id), schemaVersion: "999" };
    const file = new File([JSON.stringify(payload)], "future.json", {
      type: "application/json",
    });

    const { POST } = await import("@/app/api/admin/backups/upload/route");
    const res = await POST(
      buildMultipart(file) as unknown as Parameters<typeof POST>[0],
    );

    expect(await res.json()).toMatchObject({
      data: null,
      error: expect.stringContaining("not supported"),
    });
    expect(await prisma.dataBackup.count()).toBe(0);
    expect(res.status).toBe(422);
    const denied = await prisma.auditLog.findMany({
      where: { action: "admin.backups.upload.denied", userId: admin.id },
    });
    expect(denied).toHaveLength(1);
  });
});
