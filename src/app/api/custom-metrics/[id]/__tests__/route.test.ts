import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    customMetric: { findFirst: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, PATCH, DELETE } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "u", role: "USER" as const, locale: "en" },
};

const EXISTING = {
  id: "cm-1",
  userId: "user-1",
  name: "Grip strength",
  unit: "kg",
  targetLow: 10,
  targetHigh: 60,
  decimals: 1,
  description: null,
  correlationEnabled: false,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  deletedAt: null,
};

/**
 * The row as the reads load it: with the newest live entry and the live entry
 * count joined on, which the published row carries as `latest` and
 * `entryCount`.
 */
const JOINS = {
  entries: [
    {
      value: 42.5,
      unit: "kg",
      measuredAt: new Date("2026-06-03T07:00:00.000Z"),
    },
  ],
  _count: { entries: 7 },
};

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function patchReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/custom-metrics/cm-1", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function delReq(): NextRequest {
  return new NextRequest("http://localhost/api/custom-metrics/cm-1", {
    method: "DELETE",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
});

describe("GET /api/custom-metrics/[id]", () => {
  it("returns the metric for its owner", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue({
      ...EXISTING,
      ...JOINS,
    } as never);

    const res = await GET(
      new NextRequest("http://localhost/api/custom-metrics/cm-1"),
      params("cm-1"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        name: string;
        latest: { value: number; measuredAt: string } | null;
        entryCount: number;
      } | null;
    };
    expect(body.data?.name).toBe("Grip strength");
    // The published row carries the latest value and the count on its own,
    // as it does in the catalogue; the read asks for both joins.
    expect(body.data?.latest).toEqual({
      value: 42.5,
      unit: "kg",
      measuredAt: "2026-06-03T07:00:00.000Z",
    });
    expect(body.data?.entryCount).toBe(7);
    const findCall = vi.mocked(prisma.customMetric.findFirst).mock
      .calls[0][0] as { include?: Record<string, unknown> };
    expect(Object.keys(findCall.include ?? {})).toEqual(["entries", "_count"]);
  });

  it("answers latest null and a zero count for a metric with no entries", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue({
      ...EXISTING,
      entries: [],
      _count: { entries: 0 },
    } as never);

    const res = await GET(
      new NextRequest("http://localhost/api/custom-metrics/cm-1"),
      params("cm-1"),
    );
    const body = (await res.json()) as {
      data: { latest: unknown; entryCount: number };
    };
    expect(body.data.latest).toBeNull();
    expect(body.data.entryCount).toBe(0);
  });

  it("404s a cross-user metric", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue({
      ...EXISTING,
      userId: "other-user",
    } as never);

    const res = await GET(
      new NextRequest("http://localhost/api/custom-metrics/cm-1"),
      params("cm-1"),
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/custom-metrics/[id]", () => {
  it("persists an updated target window", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue(
      EXISTING as never,
    );
    vi.mocked(prisma.customMetric.update).mockResolvedValue({
      ...EXISTING,
      ...JOINS,
      targetLow: 20,
      targetHigh: 50,
    } as never);

    const res = await PATCH(
      patchReq({ targetLow: 20, targetHigh: 50 }),
      params("cm-1"),
    );
    expect(res.status).toBe(200);
    const updateCall = vi.mocked(prisma.customMetric.update).mock
      .calls[0][0] as { data: Record<string, unknown> };
    expect(updateCall.data.targetLow).toBe(20);
    expect(updateCall.data.targetHigh).toBe(50);
    // The edit echo is the same published row as the read.
    const body = (await res.json()) as {
      data: { entryCount: number; latest: { value: number } | null };
    };
    expect(body.data.entryCount).toBe(7);
    expect(body.data.latest?.value).toBe(42.5);
  });

  it("persists only the explicit correlation opt-in field", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue(
      EXISTING as never,
    );
    vi.mocked(prisma.customMetric.update).mockResolvedValue({
      ...EXISTING,
      ...JOINS,
      correlationEnabled: true,
    } as never);

    const res = await PATCH(
      patchReq({ correlationEnabled: true }),
      params("cm-1"),
    );
    expect(res.status).toBe(200);
    const updateCall = vi.mocked(prisma.customMetric.update).mock
      .calls[0][0] as { data: Record<string, unknown> };
    expect(updateCall.data).toEqual({ correlationEnabled: true });
  });

  it("422s an inverted partial bound update without updating", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // existing.targetHigh is 60; moving the low bound above it inverts.
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue(
      EXISTING as never,
    );

    const res = await PATCH(patchReq({ targetLow: 80 }), params("cm-1"));
    expect(res.status).toBe(422);
    expect(prisma.customMetric.update).not.toHaveBeenCalled();
  });

  it("409s a rename onto another live metric", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst)
      .mockResolvedValueOnce(EXISTING as never)
      .mockResolvedValueOnce({ id: "cm-other" } as never);

    const res = await PATCH(patchReq({ name: "Other" }), params("cm-1"));
    expect(res.status).toBe(409);
    expect((await res.json()).meta.errorCode).toBe("customMetric.name_taken");
    expect(prisma.customMetric.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/custom-metrics/[id]", () => {
  it("soft-deletes by stamping deletedAt", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue(
      EXISTING as never,
    );
    vi.mocked(prisma.customMetric.update).mockResolvedValue(EXISTING as never);

    const res = await DELETE(delReq(), params("cm-1"));
    expect(res.status).toBe(200);
    const updateCall = vi.mocked(prisma.customMetric.update).mock
      .calls[0][0] as { data: { deletedAt: Date } };
    expect(updateCall.data.deletedAt).toBeInstanceOf(Date);
  });

  it("404s a cross-user metric without deleting", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.customMetric.findFirst).mockResolvedValue({
      ...EXISTING,
      userId: "other-user",
    } as never);

    const res = await DELETE(delReq(), params("cm-1"));
    expect(res.status).toBe(404);
    expect(prisma.customMetric.update).not.toHaveBeenCalled();
  });
});
