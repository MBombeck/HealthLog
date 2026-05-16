/**
 * Smoke tests for the admin Apple Health import endpoint. Covers the
 * cookie-only `requireAdmin()` gate (Bearer never elevates), the 413
 * size-cap, and the 429 rate-limit path. Multipart streaming + boss
 * enqueue are exercised by the parser + multipart unit suites.
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
  userFindUnique: vi.fn(),
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
    user: {
      findUnique: mocks.userFindUnique,
    },
  },
}));

import { POST } from "../route";
import { getSession } from "@/lib/auth/session";

const ADMIN_SESSION = {
  session: { id: "sess-admin", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "admin-1", username: "marc", role: "ADMIN" as const },
};
const USER_SESSION = {
  session: { id: "sess-user", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-2", username: "alice", role: "USER" as const },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  mocks.bossSend.mockResolvedValue("boss-job-1");
  mocks.getGlobalBoss.mockReturnValue({ send: mocks.bossSend });
  mocks.importJobCreate.mockResolvedValue({ id: "ij-1" });
  mocks.importJobFindFirst.mockResolvedValue(null);
  mocks.importJobUpdate.mockResolvedValue({ id: "ij-1" });
  mocks.userFindUnique.mockResolvedValue({ id: "user-2", username: "alice" });
});

describe("POST /api/admin/import-apple-health-export", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/admin/import-apple-health-export", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=---x" },
      body: "stub",
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 403 when a non-admin cookie session calls the route", async () => {
    vi.mocked(getSession).mockResolvedValue(USER_SESSION as never);
    const req = new NextRequest("http://localhost/api/admin/import-apple-health-export", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=---x" },
      body: "stub",
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("returns 413 when Content-Length exceeds the cap", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_SESSION as never);
    const headers = new Headers({
      "content-type": "multipart/form-data; boundary=---x",
      "content-length": String(2 * 1024 * 1024 * 1024),
    });
    const req = new NextRequest("http://localhost/api/admin/import-apple-health-export", {
      method: "POST",
      headers,
      body: "stub",
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  it("returns 429 on rate-limit exhaustion", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_SESSION as never);
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false });
    const req = new NextRequest("http://localhost/api/admin/import-apple-health-export", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=---x" },
      body: "stub",
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
  });
});
