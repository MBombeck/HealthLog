import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findMany: vi.fn() },
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

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { requireAdmin, HttpError } from "@/lib/api-handler";

const mockUserFindMany = vi.mocked(prisma.user.findMany);
const mockRequireAdmin = vi.mocked(requireAdmin);

describe("GET /api/admin/users", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({
      session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
      user: {
        id: "admin-1",
        username: "admin",
        role: "ADMIN",
      } as never,
    });
    mockUserFindMany.mockResolvedValue([] as never);
  });

  it("rejects with 401 when no session", async () => {
    mockRequireAdmin.mockRejectedValue(new HttpError(401, "Not authenticated"));
    await expect(GET()).rejects.toThrow("Not authenticated");
  });

  it("rejects with 403 when caller is not admin", async () => {
    mockRequireAdmin.mockRejectedValue(
      new HttpError(403, "Admin access required"),
    );
    await expect(GET()).rejects.toThrow("Admin access required");
  });

  it("returns users sorted by createdAt ascending with passkey counts", async () => {
    const created = new Date("2024-01-01T00:00:00Z");
    mockUserFindMany.mockResolvedValue([
      {
        id: "u1",
        username: "alice",
        email: "alice@example.com",
        role: "ADMIN",
        createdAt: created,
        _count: { passkeys: 2 },
      },
      {
        id: "u2",
        username: "bob",
        email: null,
        role: "USER",
        createdAt: created,
        _count: { passkeys: 0 },
      },
    ] as never);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toEqual({
      id: "u1",
      username: "alice",
      email: "alice@example.com",
      role: "ADMIN",
      createdAt: created.toISOString(),
      passkeyCount: 2,
    });
    expect(body.data[1].passkeyCount).toBe(0);
    expect(body.data[1].email).toBeNull();
  });

  it("queries Prisma with the safe select shape (no password / sensitive cols)", async () => {
    await GET();
    expect(mockUserFindMany).toHaveBeenCalledTimes(1);
    const args = mockUserFindMany.mock.calls[0]?.[0] as {
      select: Record<string, unknown>;
      orderBy: { createdAt: "asc" | "desc" };
    };
    // Regression: the route must NOT pull password hash / token columns.
    expect(args.select).toEqual({
      id: true,
      username: true,
      email: true,
      role: true,
      createdAt: true,
      _count: { select: { passkeys: true } },
    });
    expect(args.select).not.toHaveProperty("passwordHash");
    expect(args.orderBy).toEqual({ createdAt: "asc" });
  });
});
