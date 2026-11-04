/**
 * v1.37.20 — custom-metric entries move from hard delete to the
 * tombstone + Undo contract every peer entry surface carries.
 *
 * Watched red: before the conversion the DELETE verb called
 * `customMetricEntry.delete` and no restore route existed — the first two
 * suites below fail against that state (no `update` with a `deletedAt`
 * stamp; module not found), which is the proof the assertions bite.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    customMetricEntry: {
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserCorrelationPatterns: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { DELETE } from "../[entryId]/route";
import { POST as RESTORE } from "../restore/route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "u", role: "USER" as const, locale: "en" },
};

const ENTRY = {
  id: "e-1",
  userId: "user-1",
  customMetricId: "cm-1",
  value: 42,
  unit: "kg",
  measuredAt: new Date("2026-06-10T00:00:00.000Z"),
  note: null,
  createdAt: new Date("2026-06-10T00:00:00.000Z"),
  deletedAt: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
});

describe("DELETE /api/custom-metrics/[id]/entries/[entryId]", () => {
  it("tombstones instead of hard-deleting", async () => {
    vi.mocked(prisma.customMetricEntry.findFirst).mockResolvedValue(
      ENTRY as never,
    );
    vi.mocked(prisma.customMetricEntry.update).mockResolvedValue({} as never);

    const res = await DELETE(
      new NextRequest("http://localhost/api/custom-metrics/cm-1/entries/e-1", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "cm-1", entryId: "e-1" }) },
    );

    expect(res.status).toBe(200);
    expect(prisma.customMetricEntry.delete).not.toHaveBeenCalled();
    const call = vi.mocked(prisma.customMetricEntry.update).mock.calls[0][0];
    expect(call.where).toEqual({ id: "e-1" });
    expect(call.data.deletedAt).toBeInstanceOf(Date);
  });

  it("404s an already-tombstoned entry (the lookup filters the tombstone)", async () => {
    vi.mocked(prisma.customMetricEntry.findFirst).mockResolvedValue(null);

    const res = await DELETE(
      new NextRequest("http://localhost/api/custom-metrics/cm-1/entries/e-1", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "cm-1", entryId: "e-1" }) },
    );

    expect(res.status).toBe(404);
    const where = vi.mocked(prisma.customMetricEntry.findFirst).mock
      .calls[0]![0]!.where!;
    expect(where.deletedAt).toBeNull();
    expect(prisma.customMetricEntry.update).not.toHaveBeenCalled();
  });
});

describe("POST /api/custom-metrics/[id]/entries/restore", () => {
  function restoreRequest(body: unknown): NextRequest {
    return new NextRequest(
      "http://localhost/api/custom-metrics/cm-1/entries/restore",
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      },
    );
  }

  it("clears the tombstone scoped to owner + parent metric", async () => {
    vi.mocked(prisma.customMetricEntry.updateMany).mockResolvedValue({
      count: 1,
    } as never);

    const res = await RESTORE(restoreRequest({ ids: ["e-1"] }), {
      params: Promise.resolve({ id: "cm-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ restored: 1 });
    const call = vi.mocked(prisma.customMetricEntry.updateMany).mock
      .calls[0][0];
    expect(call.where).toEqual({
      id: { in: ["e-1"] },
      userId: "user-1",
      customMetricId: "cm-1",
      deletedAt: { not: null },
    });
    expect(call.data).toEqual({ deletedAt: null });
  });

  it("answers restored: 0 for foreign / live ids — a silent no-op, not a leak", async () => {
    vi.mocked(prisma.customMetricEntry.updateMany).mockResolvedValue({
      count: 0,
    } as never);

    const res = await RESTORE(restoreRequest({ ids: ["not-mine"] }), {
      params: Promise.resolve({ id: "cm-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ restored: 0 });
  });

  it("422s an empty id list", async () => {
    const res = await RESTORE(restoreRequest({ ids: [] }), {
      params: Promise.resolve({ id: "cm-1" }),
    });
    expect(res.status).toBe(422);
    expect(prisma.customMetricEntry.updateMany).not.toHaveBeenCalled();
  });
});
