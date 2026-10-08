/**
 * The Health Connect upload and status routes: the size cap, the staging
 * name the sweep knows, the job's `kind`, the content-hash dedupe, the one
 * import per account rule and the status of the account's latest job.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

const mocks = vi.hoisted(() => ({
  runningImportFindFirst: vi.fn(async () => null),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  bossSend: vi.fn().mockResolvedValue("boss-job-1"),
  getGlobalBoss: vi.fn(),
  importJobCreate: vi.fn(),
  importJobFindFirst: vi.fn().mockResolvedValue(null),
  importJobUpdate: vi.fn(),
  streamToDisk: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: mocks.getGlobalBoss,
}));

vi.mock("@/lib/multipart/stream-to-disk", () => ({
  streamMultipartToDisk: mocks.streamToDisk,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: mocks.unlink, rm: mocks.rm };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    importJob: {
      create: mocks.importJobCreate,
      findFirst: mocks.importJobFindFirst,
      update: mocks.importJobUpdate,
    },
    // The one-running-import check and the new row, in one transaction.
    // The check finds nothing running unless a test says otherwise.
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        $executeRaw: async () => 0,
        importJob: {
          findFirst: mocks.runningImportFindFirst,
          create: mocks.importJobCreate,
        },
      }),
  },
}));

import { POST } from "../route";
import { GET as STATUS } from "../status/route";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

const STAGED_PATH =
  "/tmp/healthlog-health-connect-import-0b7f3c2a-1d4e-4f5a-9b8c-7d6e5f4a3b2c.bin";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  mocks.bossSend.mockResolvedValue("boss-job-1");
  mocks.getGlobalBoss.mockReturnValue({ send: mocks.bossSend });
  mocks.importJobCreate.mockResolvedValue({ id: "ij-1" });
  mocks.importJobFindFirst.mockResolvedValue(null);
  mocks.runningImportFindFirst.mockResolvedValue(null);
  mocks.importJobUpdate.mockResolvedValue({ id: "ij-1" });
  mocks.streamToDisk.mockResolvedValue({
    filePath: STAGED_PATH,
    bytes: 100,
    sha256: "deadbeef",
    originalFilename: "Health Connect.zip",
    textFields: {},
  });
  mocks.unlink.mockResolvedValue(undefined);
  mocks.rm.mockResolvedValue(undefined);
});

function upload(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/import/health-connect-export", {
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=---x",
      ...headers,
    },
    body: "stub",
  });
}

describe("POST /api/import/health-connect-export", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    expect((await POST(upload())).status).toBe(401);
  });

  it("refuses a declared body above 1 GiB before reading it", async () => {
    const res = await POST(
      upload({ "content-length": String(1024 * 1024 * 1024 + 1) }),
    );
    expect(res.status).toBe(413);
    expect(mocks.streamToDisk).not.toHaveBeenCalled();
  });

  it("caps the streamed body at 1 GiB and stages it under its own name", async () => {
    await POST(upload());
    expect(mocks.streamToDisk).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        maxBytes: 1024 * 1024 * 1024,
        tmpPrefix: "healthlog-health-connect-import",
      }),
    );
  });

  it("creates a health_connect job and queues it on its own queue", async () => {
    const res = await POST(upload());
    expect(res.status).toBe(202);
    expect((await res.json()).data).toEqual({
      jobId: "ij-1",
      status: "queued",
    });
    expect(mocks.importJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          kind: "health_connect",
          uploadSha256: "deadbeef",
        }),
      }),
    );
    expect(mocks.bossSend).toHaveBeenCalledWith(
      "health-connect-import",
      { userId: "user-1", importJobId: "ij-1", uploadPath: STAGED_PATH },
      { retryLimit: 0, expireInSeconds: 21600 },
    );
  });

  it("resolves the same bytes to the earlier job and drops the new copy", async () => {
    mocks.importJobFindFirst.mockResolvedValue({ id: "ij-0", status: "done" });
    const res = await POST(upload());
    expect(res.status).toBe(202);
    expect((await res.json()).data).toEqual({
      jobId: "ij-0",
      status: "done",
      idempotent: true,
    });
    expect(mocks.importJobFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: "health_connect",
          status: { not: "failed" },
        }),
      }),
    );
    expect(mocks.unlink).toHaveBeenCalledWith(STAGED_PATH);
    expect(mocks.bossSend).not.toHaveBeenCalled();
  });

  it("refuses a second import while one runs and discards the upload", async () => {
    mocks.runningImportFindFirst.mockResolvedValue({
      id: "ij-running",
      status: "parsing",
    } as never);
    const res = await POST(upload());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.meta).toMatchObject({
      errorCode: "import.apple_health.busy",
      jobId: "ij-running",
    });
    expect(mocks.rm).toHaveBeenCalledWith(STAGED_PATH, { force: true });
    expect(mocks.bossSend).not.toHaveBeenCalled();
  });

  it("answers 503 and removes the upload when no worker runs", async () => {
    mocks.getGlobalBoss.mockReturnValue(null);
    const res = await POST(upload());
    expect(res.status).toBe(503);
    expect(mocks.rm).toHaveBeenCalledWith(STAGED_PATH, { force: true });
  });
});

describe("GET /api/import/health-connect-export/status", () => {
  it("answers null when the account never imported", async () => {
    const res = await STATUS(
      new NextRequest(
        "http://localhost/api/import/health-connect-export/status",
      ),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ job: null });
  });

  it("answers the account's latest Health Connect job", async () => {
    mocks.importJobFindFirst.mockResolvedValue({
      id: "ij-9",
      status: "done",
      startedAt: new Date("2026-10-01T10:00:00Z"),
      completedAt: new Date("2026-10-01T10:01:00Z"),
      uploadBytes: 1234,
      progress: { rowsUpserted: 5 },
      result: { kind: "health_connect", totals: { rowsUpserted: 5 } },
      failureReason: null,
    });
    const res = await STATUS(
      new NextRequest(
        "http://localhost/api/import/health-connect-export/status",
      ),
    );
    expect((await res.json()).data.job).toMatchObject({
      jobId: "ij-9",
      status: "done",
      completedAt: "2026-10-01T10:01:00.000Z",
    });
    expect(mocks.importJobFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", kind: "health_connect" },
      }),
    );
  });
});
