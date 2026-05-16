/**
 * Tests for the polling status endpoint. Covers the canonical envelope
 * shape, the 404 on cross-user access, and the admin-trigger allow-list.
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
  importJobFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    importJob: { findUnique: mocks.importJobFindUnique },
  },
}));

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";

const OWNER_SESSION = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};
const OTHER_SESSION = {
  session: { id: "sess-2", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-99", username: "eve", role: "USER" as const },
};
const ADMIN_SESSION = {
  session: { id: "sess-a", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "admin-1", username: "marc-admin", role: "ADMIN" as const },
};

const NOW = new Date("2026-05-15T10:00:00.000Z");

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "ij-1",
    userId: "user-1",
    triggeredByAdminId: null,
    pgBossJobId: "boss-1",
    status: "parsing",
    failureReason: null,
    uploadBytes: 12345,
    uploadSha256: "abc",
    exportedAt: null,
    startedAt: NOW,
    completedAt: null,
    progress: { currentPhase: "parsing", recordsRead: 100, rowsUpserted: 0,
                 percent: null, elapsedMs: 1500 },
    result: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/import/apple-health-export/[jobId]/status", () => {
  it("returns the row envelope to the owning user", async () => {
    vi.mocked(getSession).mockResolvedValue(OWNER_SESSION as never);
    mocks.importJobFindUnique.mockResolvedValue(makeRow());
    const req = new NextRequest("http://localhost/api/import/apple-health-export/ij-1/status");
    const res = await GET(req, { params: Promise.resolve({ jobId: "ij-1" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string }; error: null };
    expect(body.error).toBeNull();
    expect(body.data.status).toBe("parsing");
  });

  it("returns 404 to a non-owner non-admin user", async () => {
    vi.mocked(getSession).mockResolvedValue(OTHER_SESSION as never);
    mocks.importJobFindUnique.mockResolvedValue(makeRow());
    const req = new NextRequest("http://localhost/api/import/apple-health-export/ij-1/status");
    const res = await GET(req, { params: Promise.resolve({ jobId: "ij-1" }) });
    expect(res.status).toBe(404);
  });

  it("admits the triggering admin even when userId differs", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_SESSION as never);
    mocks.importJobFindUnique.mockResolvedValue(
      makeRow({ triggeredByAdminId: "admin-1" }),
    );
    const req = new NextRequest("http://localhost/api/import/apple-health-export/ij-1/status");
    const res = await GET(req, { params: Promise.resolve({ jobId: "ij-1" }) });
    expect(res.status).toBe(200);
  });

  it("returns 404 when the job row is missing", async () => {
    vi.mocked(getSession).mockResolvedValue(OWNER_SESSION as never);
    mocks.importJobFindUnique.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/import/apple-health-export/ij-1/status");
    const res = await GET(req, { params: Promise.resolve({ jobId: "ij-1" }) });
    expect(res.status).toBe(404);
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/import/apple-health-export/ij-1/status");
    const res = await GET(req, { params: Promise.resolve({ jobId: "ij-1" }) });
    expect(res.status).toBe(401);
  });
});
