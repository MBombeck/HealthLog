import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  // The shared single-record write ceiling. Allowed here: this file is about
  // what the handler does with a body it accepted, not about the bucket.
  checkRecordWriteRateLimit: vi.fn(async () => ({
    allowed: true,
    limit: 300,
    remaining: 299,
    resetAt: Date.now() + 60_000,
  })),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    customMetric: { findFirst: vi.fn() },
    customMetricEntry: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
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

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "u", role: "USER" as const, locale: "en" },
};

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const ENTRY = {
  id: "e-1",
  userId: "user-1",
  customMetricId: "cm-1",
  value: 42,
  unit: "kg",
  measuredAt: new Date("2026-06-10T00:00:00.000Z"),
  note: null,
  createdAt: new Date("2026-06-10T00:00:00.000Z"),
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
});

describe("GET /api/custom-metrics/[id]/entries", () => {
  it("paginates the value feed and returns the total", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue({
      id: "cm-1",
    } as never);
    vi.mocked(prisma.customMetricEntry.findMany).mockResolvedValue([
      ENTRY,
    ] as never);
    vi.mocked(prisma.customMetricEntry.count).mockResolvedValue(5 as never);

    const res = await GET(
      new NextRequest(
        "http://localhost/api/custom-metrics/cm-1/entries?limit=1&offset=0&sortDir=desc",
      ),
      params("cm-1"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { entries: unknown[]; meta: { total: number; limit: number } };
    };
    expect(body.data.entries).toHaveLength(1);
    expect(body.data.meta.total).toBe(5);
    expect(body.data.meta.limit).toBe(1);
    const findCall = vi.mocked(prisma.customMetricEntry.findMany).mock
      .calls[0][0] as {
      where: Record<string, unknown>;
      take: number;
      orderBy: unknown;
    };
    expect(findCall.where.userId).toBe("user-1");
    expect(findCall.where.customMetricId).toBe("cm-1");
    expect(findCall.take).toBe(1);
    // `measuredAt` is not unique on a custom metric — a batch of readings can
    // share one instant — so offset paging over it alone can repeat a row on
    // one page and drop another.
    expect(findCall.orderBy).toEqual([{ measuredAt: "desc" }, { id: "desc" }]);
  });

  it("404s a cross-user / unknown metric", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue(null as never);

    const res = await GET(
      new NextRequest("http://localhost/api/custom-metrics/cm-x/entries"),
      params("cm-x"),
    );
    expect(res.status).toBe(404);
    expect(prisma.customMetricEntry.findMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/custom-metrics/[id]/entries", () => {
  it("logs a value, snapshotting the metric's unit", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue({
      id: "cm-1",
      unit: "kg",
    } as never);
    vi.mocked(prisma.customMetricEntry.create).mockResolvedValue(
      ENTRY as never,
    );

    const res = await POST(
      new NextRequest("http://localhost/api/custom-metrics/cm-1/entries", {
        method: "POST",
        body: JSON.stringify({
          value: 42,
          measuredAt: "2026-06-10T00:00:00.000Z",
        }),
        headers: { "content-type": "application/json" },
      }),
      params("cm-1"),
    );
    expect(res.status).toBe(201);
    const createCall = vi.mocked(prisma.customMetricEntry.create).mock
      .calls[0][0] as { data: Record<string, unknown> };
    expect(createCall.data.userId).toBe("user-1");
    expect(createCall.data.customMetricId).toBe("cm-1");
    expect(createCall.data.unit).toBe("kg");
    expect(createCall.data.value).toBe(42);
  });

  it("404s when the parent metric is not the caller's", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue(null as never);

    const res = await POST(
      new NextRequest("http://localhost/api/custom-metrics/cm-x/entries", {
        method: "POST",
        body: JSON.stringify({
          value: 1,
          measuredAt: "2026-06-10T00:00:00.000Z",
        }),
        headers: { "content-type": "application/json" },
      }),
      params("cm-x"),
    );
    expect(res.status).toBe(404);
    expect(prisma.customMetricEntry.create).not.toHaveBeenCalled();
  });
});
