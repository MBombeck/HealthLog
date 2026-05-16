import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { create: vi.fn() },
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

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

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

beforeEach(() => {
  vi.resetAllMocks();
  // v1.4.31 — default to an all-on flag set so existing assertions
  // ride through unchanged. Tests that need the gate-off path set
  // their own findUnique resolution.
  (prisma.appSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
    null,
  );
});

const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeReq(): NextRequest {
  return new NextRequest("http://localhost/api/insights/correlations");
}

describe("GET /api/insights/correlations", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(makeReq());
    expect(res.status).toBe(401);
  });

  it("returns an empty array as the placeholder", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it("writes the empty-state audit log", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    await callGet(makeReq());
    expect(auditLog).toHaveBeenCalledWith(
      "insights.correlations.empty",
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("returns 403 + errorCode when the correlations flag is off", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    (
      prisma.appSettings.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      assistantEnabled: true,
      assistantCoachEnabled: true,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: true,
      assistantCorrelationsEnabled: false,
      assistantHealthScoreExplainerEnabled: true,
    });
    const res = await callGet(makeReq());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("assistant.disabled.correlations");
  });

  it("returns 403 when the master flag is off (sub-flag forced)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    (
      prisma.appSettings.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      assistantEnabled: false,
      assistantCoachEnabled: true,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: true,
      assistantCorrelationsEnabled: true,
      assistantHealthScoreExplainerEnabled: true,
    });
    const res = await callGet(makeReq());
    expect(res.status).toBe(403);
  });
});
