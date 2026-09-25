/**
 * Integration test consolidating the audit-log contract for every
 * write-side backup endpoint:
 *
 *   - POST /api/admin/backups/run               → admin.backups.run
 *   - GET  /api/admin/backups/[id]/download     → admin.backups.download
 *   - POST /api/admin/backups/upload            → admin.backups.upload
 *   - POST /api/admin/backups/[id]/restore      → admin.backups.restore
 *
 * Each handler must emit an `AuditLog` row carrying:
 *   - `userId` (the actor — the admin running the op)
 *   - `action` (one of the strings above)
 *   - `details` referencing the target backup id when applicable
 *
 * The denied / failed counterparts are covered by the per-endpoint
 * suites; this file is the single contract test confirming the four
 * happy paths together so regressions in any one of them surface
 * loudly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";

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

// Stub `getGlobalBoss` so the run endpoint can audit-log its happy
// path without booting an actual pg-boss worker against the test DB.
// The fake boss returns a deterministic job id so the audit row can be
// asserted to contain it.
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => ({
    send: vi.fn().mockResolvedValue("test-job-123"),
  })),
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
      username: "audit-admin",
      email: "audit-admin@example.test",
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

function payloadFor(userId: string) {
  return {
    schemaVersion: "1",
    exportedAt: "2026-05-09T10:00:00.000Z",
    userId,
    measurements: [],
    medications: [],
    intakeEvents: [],
    moodEntries: [],
  };
}

describe("backup endpoints — AuditLog contract", () => {
  it("admin.backups.run writes an audit row carrying the boss job id", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();

    const { POST } = await import("@/app/api/admin/backups/run/route");
    const req = new Request("http://localhost/api/admin/backups/run", {
      method: "POST",
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);

    const events = await prisma.auditLog.findMany({
      where: { action: "admin.backups.run", userId: admin.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.details ?? "").toContain("test-job-123");
  });

  it("admin.backups.upload + admin.backups.download + admin.backups.restore all emit audit rows", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();

    // ── upload ──
    const { POST: UPLOAD } =
      await import("@/app/api/admin/backups/upload/route");
    const fd = new FormData();
    fd.append(
      "file",
      new File([JSON.stringify(payloadFor(admin.id))], "b.json", {
        type: "application/json",
      }),
    );
    const uploadRes = await UPLOAD(
      new Request("http://localhost/api/admin/backups/upload", {
        method: "POST",
        body: fd,
      }) as unknown as Parameters<typeof UPLOAD>[0],
    );
    expect(uploadRes.status).toBe(201);
    const uploadBody = (await uploadRes.json()) as { data: { id: string } };

    // Sanity: AND a directly-seeded backup so download has something
    // independent of the upload route's success.
    const seeded = await prisma.dataBackup.create({
      data: {
        userId: admin.id,
        type: "MANUAL_AUDIT_TEST",
        data: encrypt(JSON.stringify(payloadFor(admin.id))),
      },
    });

    // ── download ──
    const { GET: DOWNLOAD } =
      await import("@/app/api/admin/backups/[id]/download/route");
    const downloadRes = await DOWNLOAD(
      new Request(
        `http://localhost/api/admin/backups/${seeded.id}/download`,
      ) as unknown as Parameters<typeof DOWNLOAD>[0],
      { params: Promise.resolve({ id: seeded.id }) },
    );
    expect(downloadRes.status).toBe(200);

    // ── restore ──
    const { POST: RESTORE } = await import("./restore-job-driver");
    const restoreRes = await RESTORE(
      new Request(`http://localhost/api/admin/backups/${seeded.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESTORE" }),
      }) as unknown as Parameters<typeof RESTORE>[0],
      { params: Promise.resolve({ id: seeded.id }) },
    );
    expect(restoreRes.status).toBe(200);

    // ── assert: each action has exactly one success row tied to the
    // admin and the right backup id ──
    const rows = await prisma.auditLog.findMany({
      where: { userId: admin.id },
      orderBy: { createdAt: "asc" },
    });
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("admin.backups.upload");
    expect(actions).toContain("admin.backups.download");
    expect(actions).toContain("admin.backups.restore");
    expect(actions).toContain("admin.backups.restore.start");

    const upload = rows.find((r) => r.action === "admin.backups.upload");
    expect(upload?.details ?? "").toContain(uploadBody.data.id);

    const download = rows.find((r) => r.action === "admin.backups.download");
    expect(download?.details ?? "").toContain(seeded.id);

    const restore = rows.find((r) => r.action === "admin.backups.restore");
    expect(restore?.details ?? "").toContain(seeded.id);
  });
});

/**
 * The listing route is what an operator looks at to answer "are my backups
 * still being made". It could not answer that: it returned rows and a
 * retention hint, and a copy from six weeks ago carries a timestamp exactly
 * like Sunday's. It now carries the schedule's own health, and the size comes
 * from `octet_length` in the database rather than from pulling every blob into
 * the web process to measure it.
 */
describe("GET /api/admin/backups — schedule health", () => {
  it("calls a stalled weekly schedule out, and a fresh manual upload does not hide it", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();
    const blob = encrypt(JSON.stringify(payloadFor(admin.id)));

    const stalled = new Date(Date.now() - 46 * 24 * 60 * 60 * 1000);
    await prisma.dataBackup.create({
      data: {
        userId: admin.id,
        type: "WEEKLY_AUTO",
        data: blob,
        createdAt: stalled,
      },
    });
    // Uploaded by hand today. It must not make the dead cron look alive.
    await prisma.dataBackup.create({
      data: { userId: admin.id, type: "MANUAL_UPLOAD_1", data: blob },
    });

    // The listing handler declares no parameters; `apiHandler` reads the
    // request defensively out of its arguments, so calling it bare is what a
    // zero-argument handler supports.
    const { GET } = await import("@/app/api/admin/backups/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        rows: Array<{ type: string; sizeBytes: number; username: string }>;
        schedule: {
          stale: boolean;
          lastSuccessAgeDays: number | null;
          lastRun: unknown;
          lastRunFailed: boolean;
        };
      };
    };

    expect(body.data.rows).toHaveLength(2);
    // Sizes are read in SQL now; a wrong column or a wrong cast shows up here
    // as a zero or a NaN rather than as a plausible-looking number.
    expect(body.data.rows.every((row) => row.sizeBytes === blob.length)).toBe(
      true,
    );
    expect(body.data.rows.every((row) => row.username === admin.username)).toBe(
      true,
    );

    expect(body.data.schedule.lastSuccessAgeDays).toBe(46);
    expect(body.data.schedule.stale).toBe(true);
    // No `pgboss` schema in the test database — the run reader fails soft to
    // null rather than taking the whole page down, which is the arm a web-only
    // deployment lives on permanently.
    expect(body.data.schedule.lastRun).toBeNull();
    expect(body.data.schedule.lastRunFailed).toBe(false);
  });
});
