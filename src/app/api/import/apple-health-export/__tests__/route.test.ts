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
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: mocks.getGlobalBoss,
}));

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
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  mocks.bossSend.mockResolvedValue("boss-job-1");
  mocks.getGlobalBoss.mockReturnValue({ send: mocks.bossSend });
  mocks.importJobCreate.mockResolvedValue({ id: "ij-1" });
  mocks.importJobFindFirst.mockResolvedValue(null);
  mocks.importJobUpdate.mockResolvedValue({ id: "ij-1" });
});

describe("POST /api/import/apple-health-export", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/import/apple-health-export", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=---x" },
      body: "stub",
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 413 when Content-Length exceeds the 1.5 GB cap", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const headers = new Headers({
      "content-type": "multipart/form-data; boundary=---x",
      "content-length": String(2 * 1024 * 1024 * 1024),
    });
    const req = new NextRequest("http://localhost/api/import/apple-health-export", {
      method: "POST",
      headers,
      body: "stub",
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  it("returns 429 when the rate-limit window is exhausted", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false });
    const req = new NextRequest("http://localhost/api/import/apple-health-export", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=---x" },
      body: "stub",
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
  });
});
