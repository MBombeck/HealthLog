import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

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

function req(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/measurements/series?${query}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
});

describe("GET /api/measurements/series", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await GET(req("kind=weight"));
    expect(res.status).toBe(401);
  });

  it("returns 422 for invalid kind", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(req("kind=garbage"));
    expect(res.status).toBe(422);
  });

  it("returns paired BP series with sys + dia", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const t = new Date("2026-05-01T10:00:00.000Z");
    const findManyMock = vi.mocked(prisma.measurement.findMany);
    findManyMock.mockImplementation(((args: unknown) => {
      const a = args as { where: { type: string } };
      if (a.where.type === "BLOOD_PRESSURE_SYS") {
        return Promise.resolve([
          { id: "s1", value: 126, measuredAt: t },
        ]) as never;
      }
      if (a.where.type === "BLOOD_PRESSURE_DIA") {
        return Promise.resolve([
          {
            id: "d1",
            value: 82,
            measuredAt: new Date(t.getTime() + 60_000),
          },
        ]) as never;
      }
      return Promise.resolve([]) as never;
    }) as never);
    const res = await GET(req("kind=bloodPressure&days=30"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        kind: string;
        points: Array<{ value: number; secondary: number | null }>;
        stats: { count: number };
      };
    };
    expect(body.data.kind).toBe("bloodPressure");
    expect(body.data.points).toHaveLength(1);
    expect(body.data.points[0].value).toBe(126);
    expect(body.data.points[0].secondary).toBe(82);
    expect(body.data.stats.count).toBe(1);
  });

  it("returns single-value series for kind=weight", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { id: "w1", value: 78.4, measuredAt: new Date() },
    ] as never);
    const res = await GET(req("kind=weight&days=7"));
    const body = (await res.json()) as {
      data: { points: Array<{ secondary: number | null }> };
    };
    expect(body.data.points[0].secondary).toBeNull();
  });
});

describe("GET /api/measurements/series — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // bad `kind` (invalid enum) + `days=0` (below min 1).
    const res = await GET(req("kind=garbage&days=0"));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces multiple simultaneous validation errors (≥2)", async () => {
    // The series schema has only two knobs (kind + days), so a strict
    // 3-issue case is not natural. We pin the multi-issue contract on
    // ≥ 2 here — the helper's 3-issue path is exhaustively covered by
    // `src/lib/__tests__/api-response-zod.test.ts` and the routes with
    // wider schemas (measurements, devices, mood-entries).
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(req("kind=junk&days=-999"));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string }> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("writes a measurements.series.validation-failed audit row", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(req("kind=garbage&days=0"));
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { userId: string; action: string };
    };
    expect(call.data.userId).toBe("user-1");
    expect(call.data.action).toBe("measurements.series.validation-failed");
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
      new Error("db down"),
    );
    const res = await GET(req("kind=garbage&days=0"));
    expect(res.status).toBe(422);
  });
});
