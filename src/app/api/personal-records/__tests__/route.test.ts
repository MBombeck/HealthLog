import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    personalRecord: {
      findMany: vi.fn(),
    },
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
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

function req(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.personalRecord.findMany).mockResolvedValue([]);
});

describe("GET /api/personal-records", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await GET(req("http://localhost/api/personal-records"));
    expect(res.status).toBe(401);
  });

  it("returns an empty list for a user with no records", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(req("http://localhost/api/personal-records"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; error: null };
    expect(body.data).toEqual([]);
    expect(body.error).toBeNull();
    expect(prisma.personalRecord.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { achievedAt: "desc" },
      take: 100,
    });
  });

  it("passes through a valid metricType filter", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(
      req("http://localhost/api/personal-records?metricType=VO2_MAX"),
    );
    expect(res.status).toBe(200);
    expect(prisma.personalRecord.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1", metricType: "VO2_MAX" },
      orderBy: { achievedAt: "desc" },
      take: 100,
    });
  });

  it("drops an unknown metricType silently (loose-typed filter contract)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(
      req("http://localhost/api/personal-records?metricType=BOGUS"),
    );
    expect(res.status).toBe(200);
    expect(prisma.personalRecord.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { achievedAt: "desc" },
      take: 100,
    });
  });

  it("honours an explicit ?limit param", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(req("http://localhost/api/personal-records?limit=25"));
    expect(res.status).toBe(200);
    expect(prisma.personalRecord.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { achievedAt: "desc" },
      take: 25,
    });
  });

  it("clamps ?limit to the project-wide ceiling of 500", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(
      req("http://localhost/api/personal-records?limit=999999"),
    );
    expect(res.status).toBe(200);
    expect(prisma.personalRecord.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { achievedAt: "desc" },
      take: 500,
    });
  });

  it("falls back to default on garbage ?limit (defence-in-depth)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(req("http://localhost/api/personal-records?limit=abc"));
    expect(res.status).toBe(200);
    expect(prisma.personalRecord.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { achievedAt: "desc" },
      take: 100,
    });
  });

  it("seeded record round-trips through the response", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const fakeRecord = {
      id: "pr-1",
      userId: "user-1",
      metricType: "VO2_MAX",
      metricSlot: null,
      direction: "MAX",
      value: 47.2,
      unit: "mL/(kg·min)",
      achievedAt: new Date("2026-05-01T07:00:00.000Z"),
      sourceMeasurementId: "m-1",
      source: "APPLE_HEALTH",
      externalId: null,
      createdAt: new Date(),
    };
    vi.mocked(prisma.personalRecord.findMany).mockResolvedValue([
      fakeRecord,
    ] as never);
    const res = await GET(req("http://localhost/api/personal-records"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ value: number; metricType: string }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].value).toBe(47.2);
    expect(body.data[0].metricType).toBe("VO2_MAX");
  });
});
