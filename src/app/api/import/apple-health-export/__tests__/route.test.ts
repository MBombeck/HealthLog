/**
 * Smoke / contract tests for the Apple Health import endpoints.
 *
 * Targets the cookie + Bearer auth path, the 413 size-cap, and the
 * 503 worker-not-running path. End-to-end ingest (multipart streaming
 * + parser + worker) is covered separately by the parser unit suite
 * + the integration suite under `tests/integration`.
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
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  bossSend: vi.fn().mockResolvedValue("boss-job-1"),
  getGlobalBoss: vi.fn(),
  importJobCreate: vi.fn(),
  importJobFindFirst: vi.fn().mockResolvedValue(null),
  importJobUpdate: vi.fn(),
  streamToDisk: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
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
  return { ...actual, unlink: mocks.unlink };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    importJob: {
      create: mocks.importJobCreate,
      findFirst: mocks.importJobFindFirst,
      update: mocks.importJobUpdate,
    },
  },
}));

import { POST } from "../route";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

const STAGED_PATH = "/tmp/healthlog-apple-health-import-abc.bin";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  mocks.bossSend.mockResolvedValue("boss-job-1");
  mocks.getGlobalBoss.mockReturnValue({ send: mocks.bossSend });
  mocks.importJobCreate.mockResolvedValue({ id: "ij-1" });
  mocks.importJobFindFirst.mockResolvedValue(null);
  mocks.importJobUpdate.mockResolvedValue({ id: "ij-1" });
  mocks.streamToDisk.mockResolvedValue({
    filePath: STAGED_PATH,
    bytes: 100,
    sha256: "deadbeef",
    originalFilename: "export.zip",
    textFields: {},
  });
  mocks.unlink.mockResolvedValue(undefined);
});

function multipartReq(): NextRequest {
  return new NextRequest("http://localhost/api/import/apple-health-export", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=---x" },
    body: "stub",
  });
}

describe("POST /api/import/apple-health-export", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const req = new NextRequest(
      "http://localhost/api/import/apple-health-export",
      {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=---x" },
        body: "stub",
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 413 when Content-Length exceeds the 1.5 GB cap", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const headers = new Headers({
      "content-type": "multipart/form-data; boundary=---x",
      "content-length": String(2 * 1024 * 1024 * 1024),
    });
    const req = new NextRequest(
      "http://localhost/api/import/apple-health-export",
      {
        method: "POST",
        headers,
        body: "stub",
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  it("returns 429 when the rate-limit window is exhausted", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false });
    const req = new NextRequest(
      "http://localhost/api/import/apple-health-export",
      {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=---x" },
        body: "stub",
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(429);
  });
});

describe("POST /api/import/apple-health-export — dedup by content hash (issue #486)", () => {
  it("re-stages and enqueues when the only prior job for the same bytes is failed", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // The DB holds a FAILED prior job for this sha. The dedup query
    // excludes failed rows, so it returns null and the upload must fall
    // through to a fresh stage + boss.send instead of replaying the dead
    // job's id/failureReason forever.
    mocks.importJobFindFirst.mockImplementation(async (args: unknown) => {
      const where = (args as { where?: { status?: { not?: string } } }).where;
      if (where?.status?.not === "failed") return null;
      return { id: "old-failed-job", status: "failed" };
    });

    const res = await POST(multipartReq());
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.status).toBe("queued");
    expect(body.data.idempotent).toBeUndefined();
    expect(body.data.jobId).not.toBe("old-failed-job");
    expect(mocks.bossSend).toHaveBeenCalledTimes(1);
    expect(mocks.importJobCreate).toHaveBeenCalledTimes(1);
    expect(mocks.importJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ parserRevision: 2 }),
      }),
    );
    expect(mocks.bossSend).toHaveBeenCalledWith(
      "apple-health-import-v2",
      expect.objectContaining({ userId: "user-1" }),
      expect.objectContaining({ retryLimit: 0 }),
    );
    expect(mocks.importJobUpdate).toHaveBeenCalledWith({
      where: { id: "ij-1" },
      data: { pgBossJobId: "boss-job-1" },
    });
    // The dedup lookup must exclude failed rows.
    expect(mocks.importJobFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { not: "failed" },
          parserRevision: 2,
        }),
      }),
    );
    // A fresh job was staged — nothing to unlink on this path.
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it("short-circuits to a viable prior job and unlinks the redundant upload", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    mocks.importJobFindFirst.mockResolvedValue({
      id: "live-job",
      status: "parsing",
    });

    const res = await POST(multipartReq());
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.idempotent).toBe(true);
    expect(body.data.jobId).toBe("live-job");
    expect(mocks.bossSend).not.toHaveBeenCalled();
    expect(mocks.importJobCreate).not.toHaveBeenCalled();
    // The freshly staged upload is redundant and must be cleaned up.
    expect(mocks.unlink).toHaveBeenCalledWith(STAGED_PATH);
    expect(mocks.importJobFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ parserRevision: 2 }),
      }),
    );
  });
});
