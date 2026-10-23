import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    customMetric: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    customMetricEntry: { findFirst: vi.fn(), count: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
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

vi.mock("@/lib/idempotency", () => ({
  withIdempotency: (fn: unknown) => fn,
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, POST } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "u", role: "USER" as const, locale: "en" },
};

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/custom-metrics", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const ROW = {
  id: "cm-1",
  userId: "user-1",
  name: "Grip strength",
  unit: "kg",
  targetLow: null,
  targetHigh: null,
  decimals: null,
  description: null,
  correlationEnabled: false,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  deletedAt: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(auditLog).mockResolvedValue(undefined);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
});

describe("GET /api/custom-metrics", () => {
  it("lists the caller's metrics with the latest value", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findMany).mockResolvedValue([
      {
        ...ROW,
        entries: [
          {
            value: 42,
            unit: "kg",
            measuredAt: new Date("2026-06-10T00:00:00.000Z"),
          },
        ],
        _count: { entries: 3 },
      },
    ] as never);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { customMetrics: Array<{ latest: { value: number } | null }> };
    };
    expect(body.data.customMetrics).toHaveLength(1);
    expect(body.data.customMetrics[0].latest?.value).toBe(42);
  });
});

describe("POST /api/custom-metrics", () => {
  it("creates a metric field-by-field", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.customMetric.create).mockResolvedValue(ROW as never);

    const res = await POST(
      postReq({
        name: "Grip strength",
        unit: "kg",
        correlationEnabled: true,
      }),
    );
    expect(res.status).toBe(201);
    const createCall = vi.mocked(prisma.customMetric.create).mock
      .calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createCall.data.userId).toBe("user-1");
    expect(createCall.data.name).toBe("Grip strength");
    expect("userId" in createCall.data).toBe(true);
    expect(createCall.data.correlationEnabled).toBe(true);
  });

  it("409s a duplicate live name without creating", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue({
      id: "cm-existing",
      deletedAt: null,
    } as never);

    const res = await POST(postReq({ name: "Grip strength", unit: "kg" }));
    expect(res.status).toBe(409);
    expect(prisma.customMetric.create).not.toHaveBeenCalled();
  });

  it("revives a soft-deleted metric of the same name", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue({
      id: "cm-old",
      deletedAt: new Date("2026-05-01T00:00:00.000Z"),
    } as never);
    vi.mocked(prisma.customMetric.update).mockResolvedValue({
      ...ROW,
      id: "cm-old",
    } as never);
    vi.mocked(prisma.customMetricEntry.findFirst).mockResolvedValue(
      null as never,
    );
    vi.mocked(prisma.customMetricEntry.count).mockResolvedValue(0 as never);

    const res = await POST(postReq({ name: "Grip strength", unit: "kg" }));
    expect(res.status).toBe(201);
    const updateCall = vi.mocked(prisma.customMetric.update).mock
      .calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateCall.data.deletedAt).toBeNull();
    expect(prisma.customMetric.create).not.toHaveBeenCalled();
  });

  it("422s an inverted target range", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const res = await POST(
      postReq({ name: "X", unit: "kg", targetLow: 80, targetHigh: 20 }),
    );
    expect(res.status).toBe(422);
    expect(prisma.customMetric.create).not.toHaveBeenCalled();
  });
});
