import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => {
  const prisma = {
    biomarker: {
      findFirst: vi.fn(),
      findMany: vi.fn(async () => []),
      update: vi.fn(),
      delete: vi.fn(),
    },
    // v1.43 — the marker's other spellings, read and replaced with it.
    biomarkerAlias: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    biomarkerMerge: { findFirst: vi.fn(async () => null) },
    labResult: { deleteMany: vi.fn(), findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  // `$transaction` is set in `beforeEach`: the batch form for the delete, the
  // callback form for the edit.
  return { prisma: { ...prisma, $transaction: vi.fn() } };
});

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/labs/biomarker-store", () => ({
  encryptContextToBytes: vi.fn(() => new Uint8Array([1])),
  decryptContextFromBytes: vi.fn(() => "ctx"),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, PUT, DELETE } from "../route";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "u", role: "USER" as const, locale: "en" },
};

const EXISTING = {
  id: "bm-1",
  userId: "user-1",
  name: "LDL",
  unit: "mg/dL",
  lowerBound: 0,
  upperBound: 100,
  panel: null,
  hidden: false,
  contextEncrypted: null,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
};

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function putReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/biomarkers/bm-1", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function delReq(): NextRequest {
  return new NextRequest("http://localhost/api/biomarkers/bm-1", {
    method: "DELETE",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  // v1.37.0 — the 422 breadcrumb goes through `auditLog()` and the route
  // chains `.catch()` on it; `resetAllMocks` clears the factory's resolution.
  vi.mocked(auditLog).mockResolvedValue(undefined as never);
  vi.mocked(prisma.$transaction).mockImplementation((async (arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
      : Promise.all(arg as Promise<unknown>[])) as never);
  vi.mocked(prisma.biomarkerAlias.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.biomarker.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.biomarkerMerge.findFirst).mockResolvedValue(null as never);
});

describe("GET /api/biomarkers/[id] — trend (v1.44)", () => {
  const YEAR_MS = 365.25 * 86_400_000;
  const getReq = () =>
    new NextRequest("http://localhost/api/biomarkers/bm-1", { method: "GET" });

  it("carries the marker's slope over every stored reading", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.biomarker.findFirst).mockResolvedValue(EXISTING as never);
    const t0 = Date.now() - 2 * YEAR_MS;
    vi.mocked(prisma.labResult.findMany).mockResolvedValue([
      { takenAt: new Date(t0), value: 60 },
      { takenAt: new Date(t0 + YEAR_MS), value: 70 },
      { takenAt: new Date(t0 + 2 * YEAR_MS), value: 80 },
    ] as never);
    const res = await GET(getReq(), params("bm-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe("LDL");
    expect(body.data.trend).toMatchObject({
      status: "ok",
      n: 3,
      slopePerYear: 10,
      projection: "exits",
      exitBound: "high",
    });
    expect(prisma.labResult.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          biomarkerId: "bm-1",
          deletedAt: null,
        }),
      }),
    );
  });

  it("answers insufficient below three readings", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.biomarker.findFirst).mockResolvedValue(EXISTING as never);
    vi.mocked(prisma.labResult.findMany).mockResolvedValue([] as never);
    const body = await (await GET(getReq(), params("bm-1"))).json();
    expect(body.data.trend).toEqual({
      status: "insufficient",
      reason: "too_few_values",
      n: 0,
      spanDays: 0,
    });
  });
});

describe("DELETE /api/biomarkers/[id]", () => {
  it("drops the marker and its readings in one userId-narrowed transaction", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.biomarker.findFirst).mockResolvedValue(EXISTING as never);
    vi.mocked(prisma.labResult.deleteMany).mockResolvedValue({
      count: 3,
    } as never);
    vi.mocked(prisma.biomarker.delete).mockResolvedValue(EXISTING as never);

    const res = await DELETE(delReq(), params("bm-1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deleted: boolean } | null };
    expect(body.data?.deleted).toBe(true);

    expect(prisma.labResult.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", biomarkerId: "bm-1" },
    });
    expect(prisma.biomarker.delete).toHaveBeenCalledWith({
      where: { id: "bm-1" },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("404s a cross-user marker without deleting anything", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.biomarker.findFirst).mockResolvedValue({
      ...EXISTING,
      userId: "other-user",
    } as never);

    const res = await DELETE(delReq(), params("bm-1"));
    expect(res.status).toBe(404);
    expect(prisma.labResult.deleteMany).not.toHaveBeenCalled();
    expect(prisma.biomarker.delete).not.toHaveBeenCalled();
  });
});

describe("PUT /api/biomarkers/[id] — target range", () => {
  it("persists an updated reference window", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.biomarker.findFirst).mockResolvedValue(EXISTING as never);
    vi.mocked(prisma.biomarker.update).mockResolvedValue({
      ...EXISTING,
      lowerBound: 10,
      upperBound: 50,
    } as never);

    const res = await PUT(
      putReq({ lowerBound: 10, upperBound: 50 }),
      params("bm-1"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { lowerBound: number; upperBound: number } | null;
    };
    expect(body.data?.lowerBound).toBe(10);
    expect(body.data?.upperBound).toBe(50);

    const updateCall = vi.mocked(prisma.biomarker.update).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateCall.data.lowerBound).toBe(10);
    expect(updateCall.data.upperBound).toBe(50);
  });

  it("422s an inverted target range without updating", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.biomarker.findFirst).mockResolvedValue(EXISTING as never);

    const res = await PUT(
      putReq({ lowerBound: 80, upperBound: 20 }),
      params("bm-1"),
    );
    expect(res.status).toBe(422);
    expect(prisma.biomarker.update).not.toHaveBeenCalled();
  });
});
