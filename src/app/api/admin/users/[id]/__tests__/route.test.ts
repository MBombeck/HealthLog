import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return {
    ...actual,
    apiHandler: <T extends (...args: unknown[]) => Promise<Response>>(
      h: T,
    ): T => h,
    requireAdmin: vi.fn(),
  };
});

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
}));

import { PUT } from "../route";
import { prisma } from "@/lib/db";
import { requireAdmin, HttpError } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";

const ADMIN_CTX = {
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "admin-1",
    username: "admin",
    role: "ADMIN",
  } as never,
};

function jsonReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/users/u1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);
});

describe("PUT /api/admin/users/[id]", () => {
  it("rejects with 401 when unauthenticated", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(
      new HttpError(401, "Not authenticated"),
    );
    await expect(
      PUT(jsonReq({ username: "marc" }), params("u1")),
    ).rejects.toThrow("Not authenticated");
  });

  it("rejects with 403 when caller is not admin", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(
      new HttpError(403, "Admin access required"),
    );
    await expect(
      PUT(jsonReq({ username: "marc" }), params("u1")),
    ).rejects.toThrow("Admin access required");
  });

  it("returns 422 when payload fails Zod validation (short username)", async () => {
    const res = await PUT(jsonReq({ username: "ab" }), params("u1"));
    expect(res.status).toBe(422);
    expect(vi.mocked(prisma.user.findUnique)).not.toHaveBeenCalled();
  });

  it("returns 422 when role is unknown", async () => {
    const res = await PUT(jsonReq({ role: "SUPERUSER" }), params("u1"));
    expect(res.status).toBe(422);
  });

  it("returns 404 when target user does not exist", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    const res = await PUT(jsonReq({ username: "marc" }), params("u-missing"));
    expect(res.status).toBe(404);
    expect(vi.mocked(prisma.user.update)).not.toHaveBeenCalled();
  });

  it("forbids demoting the last remaining admin", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "u1",
      role: "ADMIN",
    } as never);
    vi.mocked(prisma.user.count).mockResolvedValue(1);
    const res = await PUT(jsonReq({ role: "USER" }), params("u1"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/last admin/i);
    expect(vi.mocked(prisma.user.update)).not.toHaveBeenCalled();
  });

  it("allows demoting an admin while another admin exists", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "u1",
      role: "ADMIN",
    } as never);
    vi.mocked(prisma.user.count).mockResolvedValue(2);
    vi.mocked(prisma.user.update).mockResolvedValue({
      id: "u1",
      username: "alice",
      email: "a@b.com",
      role: "USER",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    } as never);
    const res = await PUT(jsonReq({ role: "USER" }), params("u1"));
    expect(res.status).toBe(200);
    const updateArgs = vi.mocked(prisma.user.update).mock.calls[0]?.[0];
    expect(updateArgs?.where).toEqual({ id: "u1" });
    expect(updateArgs?.data).toEqual({ role: "USER" });
  });

  it("persists username + email + role and writes an audit-log entry", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "u1",
      role: "USER",
    } as never);
    const updated = {
      id: "u1",
      username: "renamed",
      email: "new@example.com",
      role: "ADMIN" as const,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    };
    vi.mocked(prisma.user.update).mockResolvedValue(updated as never);

    const res = await PUT(
      jsonReq({
        username: "renamed",
        email: "new@example.com",
        role: "ADMIN",
      }),
      params("u1"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.username).toBe("renamed");
    expect(body.data.role).toBe("ADMIN");
    expect(body.data).not.toHaveProperty("passwordHash");

    const updateArgs = vi.mocked(prisma.user.update).mock.calls[0]?.[0];
    expect(updateArgs?.data).toEqual({
      username: "renamed",
      email: "new@example.com",
      role: "ADMIN",
    });
    expect(auditLog).toHaveBeenCalledWith(
      "admin.user.update",
      expect.objectContaining({
        userId: "admin-1",
        details: expect.objectContaining({ targetUserId: "u1" }),
      }),
    );
  });

  it("supports clearing email by passing null", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "u1",
      role: "USER",
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({
      id: "u1",
      username: "alice",
      email: null,
      role: "USER",
      createdAt: new Date(),
    } as never);
    const res = await PUT(jsonReq({ email: null }), params("u1"));
    expect(res.status).toBe(200);
    const updateArgs = vi.mocked(prisma.user.update).mock.calls[0]?.[0];
    expect(updateArgs?.data).toEqual({ email: null });
  });

  it("returns 415 when content-type is not JSON", async () => {
    const r = new NextRequest("http://localhost/api/admin/users/u1", {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    const res = await PUT(r, params("u1"));
    expect(res.status).toBe(415);
  });
});
