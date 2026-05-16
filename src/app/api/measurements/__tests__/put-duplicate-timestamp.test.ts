import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));

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

import { PUT } from "../[id]/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { Prisma } from "@/generated/prisma/client";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

function putRequest(id: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost/api/measurements/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("PUT /api/measurements/[id] — duplicate-timestamp handling", () => {
  it("returns 409 when re-pointing measuredAt onto an existing tuple", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.findUnique).mockResolvedValue({
      id: "m-2",
      userId: "user-1",
      type: "ACTIVITY_STEPS",
      value: 1234,
      measuredAt: new Date("2026-05-10T10:00:00.000Z"),
      source: "MANUAL",
      sleepStage: null,
      notes: null,
      unit: "count",
    } as never);

    // Mirror what Prisma raises on a unique-constraint collision.
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      {
        code: "P2002",
        clientVersion: "x",
        meta: { target: ["userId", "type", "measuredAt", "source", "sleepStage"] },
      },
    );
    vi.mocked(prisma.measurement.update).mockRejectedValue(p2002);

    const res = await PUT(
      putRequest("m-2", { measuredAt: "2026-05-10T09:00:00.000Z" }),
      { params: Promise.resolve({ id: "m-2" }) },
    );

    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; meta?: { errorCode?: string } };
    expect(json.error).toMatch(/already exists|duplicate/i);
    expect(json.meta?.errorCode).toBe("measurement.duplicate_timestamp");
  });

  it("re-throws any non-P2002 Prisma error", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.findUnique).mockResolvedValue({
      id: "m-3",
      userId: "user-1",
      type: "WEIGHT",
      value: 75,
      measuredAt: new Date(),
      source: "MANUAL",
      sleepStage: null,
      notes: null,
      unit: "kg",
    } as never);

    const otherError = new Prisma.PrismaClientKnownRequestError(
      "Record not found",
      { code: "P2025", clientVersion: "x" },
    );
    vi.mocked(prisma.measurement.update).mockRejectedValue(otherError);

    const res = await PUT(
      putRequest("m-3", { value: 76 }),
      { params: Promise.resolve({ id: "m-3" }) },
    );

    // apiHandler converts uncaught errors to 500.
    expect(res.status).toBe(500);
  });

  it("returns 409 on a sport-style measurement edit (FB-B1)", async () => {
    // v1.4.28 FB-B1 — the maintainer's "Sport edit + save → error"
    // report maps onto measurement-typed sport rows (Apple Health
    // ingests workouts as ACTIVE_ENERGY_BURNED / FLIGHTS_CLIMBED /
    // WALKING_RUNNING_DISTANCE samples, all of which route through
    // /api/measurements/[id] for edits). No separate /api/workouts/[id]
    // PUT exists — workouts are ingested via POST /api/workouts/batch
    // only. The 409 handler must therefore fire for sport-typed rows.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.findUnique).mockResolvedValue({
      id: "m-sport",
      userId: "user-1",
      type: "ACTIVE_ENERGY_BURNED",
      value: 320,
      measuredAt: new Date("2026-05-10T10:00:00.000Z"),
      source: "APPLE_HEALTH",
      sleepStage: null,
      notes: null,
      unit: "kcal",
    } as never);

    const p2002 = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      {
        code: "P2002",
        clientVersion: "x",
        meta: { target: ["userId", "type", "measuredAt", "source", "sleepStage"] },
      },
    );
    vi.mocked(prisma.measurement.update).mockRejectedValue(p2002);

    const res = await PUT(
      putRequest("m-sport", { measuredAt: "2026-05-10T09:00:00.000Z" }),
      { params: Promise.resolve({ id: "m-sport" }) },
    );

    expect(res.status).toBe(409);
    const json = (await res.json()) as {
      error: string;
      meta?: { errorCode?: string };
    };
    expect(json.meta?.errorCode).toBe("measurement.duplicate_timestamp");
  });

  it("returns the updated measurement on the 200 happy path", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.findUnique).mockResolvedValue({
      id: "m-4",
      userId: "user-1",
      type: "WEIGHT",
      value: 75,
      measuredAt: new Date("2026-05-10T10:00:00.000Z"),
      source: "MANUAL",
      sleepStage: null,
      notes: null,
      unit: "kg",
    } as never);
    vi.mocked(prisma.measurement.update).mockResolvedValue({
      id: "m-4",
      userId: "user-1",
      type: "WEIGHT",
      value: 76,
      measuredAt: new Date("2026-05-10T10:00:00.000Z"),
      source: "MANUAL",
      sleepStage: null,
      notes: null,
      unit: "kg",
    } as never);

    const res = await PUT(
      putRequest("m-4", { value: 76 }),
      { params: Promise.resolve({ id: "m-4" }) },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { id: string; value: number } };
    expect(json.data.id).toBe("m-4");
    expect(json.data.value).toBe(76);
  });
});
