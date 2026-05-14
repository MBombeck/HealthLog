import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    appSettings: { findUnique: vi.fn() },
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

import { PUT } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

function mkReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/auth/me/timezone", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PUT /api/auth/me/timezone", () => {
  it("rejects unauthenticated requests with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await PUT(mkReq({ timezone: "Europe/Berlin" }));
    expect(res.status).toBe(401);
  });

  it("accepts a valid IANA zone and writes it to the user", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      timezone: "Europe/Berlin",
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({
      timezone: "Pacific/Auckland",
    } as never);

    const res = await PUT(mkReq({ timezone: "Pacific/Auckland" }));
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { timezone: "Pacific/Auckland" },
    });
  });

  it("rejects an invalid timezone with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await PUT(mkReq({ timezone: "Mars/Olympus" }));
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects an empty timezone with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await PUT(mkReq({ timezone: "" }));
    expect(res.status).toBe(422);
  });

  it("rejects a missing timezone field with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await PUT(mkReq({}));
    expect(res.status).toBe(422);
  });

  it("trims whitespace before validating", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      timezone: "Europe/Berlin",
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({
      timezone: "Asia/Tokyo",
    } as never);
    const res = await PUT(mkReq({ timezone: "  Asia/Tokyo  " }));
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { timezone: "Asia/Tokyo" },
    });
  });
});
