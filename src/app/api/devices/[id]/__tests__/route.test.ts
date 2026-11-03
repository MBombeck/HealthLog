import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    device: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    refreshToken: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    apiToken: {
      updateMany: vi.fn(),
    },
    // v1.4.23 — the cascade now runs through `prisma.$transaction`
    // (HIGH 6 fix). The mock returns the resolved batch payload so the
    // route handler walks past the transaction step.
    $transaction: vi.fn().mockResolvedValue([] as never),
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

import { DELETE } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function req(): NextRequest {
  return new NextRequest("http://localhost/api/devices/dev-x", {
    method: "DELETE",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.refreshToken.findMany).mockResolvedValue([]);
  vi.mocked(prisma.refreshToken.updateMany).mockResolvedValue({
    count: 0,
  } as never);
  vi.mocked(prisma.apiToken.updateMany).mockResolvedValue({
    count: 0,
  } as never);
  vi.mocked(prisma.$transaction).mockResolvedValue([] as never);
});

describe("DELETE /api/devices/[id] (iOS token-rotation endpoint)", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await DELETE(req(), {
      params: Promise.resolve({ id: "dev-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 on cross-user attempt", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.device.findUnique).mockResolvedValue({
      id: "dev-x",
      userId: "user-2",
      model: "iPhone",
      bundleId: "io.healthlog.app",
    } as never);
    const res = await DELETE(req(), {
      params: Promise.resolve({ id: "dev-x" }),
    });
    expect(res.status).toBe(404);
  });

  it("revokes the device + paired tokens", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.device.findUnique).mockResolvedValue({
      id: "dev-1",
      userId: "user-1",
      model: "iPhone",
      bundleId: "io.healthlog.app",
    } as never);
    vi.mocked(prisma.refreshToken.findMany).mockResolvedValue([
      { accessTokenHash: "hash:a1" },
    ] as never);
    vi.mocked(prisma.device.delete).mockResolvedValue({ id: "dev-1" } as never);

    const res = await DELETE(req(), {
      params: Promise.resolve({ id: "dev-1" }),
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(prisma.device.delete)).toHaveBeenCalled();
  });
});
