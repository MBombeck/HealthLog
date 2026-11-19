import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: {
      findMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
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

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/api-handler";

const ADMIN_CTX = {
  authMethod: "cookie" as const,
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "admin-1", username: "admin", role: "ADMIN" } as never,
};

function req(query = ""): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/audit-log${query ? "?" + query : ""}`,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);
  vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
  vi.mocked(prisma.auditLog.count).mockResolvedValue(0);
  vi.mocked(prisma.auditLog.groupBy).mockResolvedValue([]);
  vi.mocked(prisma.user.findMany).mockResolvedValue([]);
});

describe("GET /api/admin/audit-log — extended filters", () => {
  it("supports `page` + `perPage` pagination", async () => {
    await GET(req("page=3&perPage=25"));
    const call = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0]!;
    // skip = (page - 1) * perPage = 50; take = perPage = 25
    expect(call.skip).toBe(50);
    expect(call.take).toBe(25);
  });

  it("clamps perPage to the allowed set {25, 50, 100}", async () => {
    await GET(req("perPage=999"));
    // any out-of-range value falls back to the default 50
    const call = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0]!;
    expect(call.take).toBe(50);
  });

  it("filters by `actor` against userId OR user.username", async () => {
    await GET(req("actor=testuser"));
    const call = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0]!;
    const where = call.where as Record<string, unknown>;
    // Expect an OR clause covering userId + user.username (contains)
    expect(where.OR).toBeDefined();
    const or = where.OR as Array<Record<string, unknown>>;
    const matchesUserId = or.some((c) => c.userId === "testuser");
    const matchesUsername = or.some(
      (c) =>
        typeof c.user === "object" &&
        c.user !== null &&
        // user: { username: { contains: "testuser", mode: "insensitive" } }
        JSON.stringify(c).toLowerCase().includes("testuser"),
    );
    expect(matchesUserId).toBe(true);
    expect(matchesUsername).toBe(true);
  });

  it("filters by `action` exact match", async () => {
    await GET(req("action=auth.login.failed"));
    const call = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0]!;
    const where = call.where as Record<string, unknown>;
    expect(where.action).toBe("auth.login.failed");
  });

  it("filters by `target` (substring on `details` JSON string)", async () => {
    await GET(req("target=measurement-42"));
    const call = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0]!;
    const where = call.where as Record<string, unknown>;
    expect(where.details).toBeDefined();
    expect(JSON.stringify(where.details)).toContain("measurement-42");
  });

  it("filters by `since` and `until` window", async () => {
    const since = "2026-05-01T00:00:00.000Z";
    const until = "2026-05-09T23:59:59.000Z";
    await GET(req(`since=${since}&until=${until}`));
    const call = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0]!;
    const where = call.where as Record<string, unknown>;
    expect(where.createdAt).toEqual({
      gte: new Date(since),
      lte: new Date(until),
    });
  });

  it("returns paginated meta", async () => {
    vi.mocked(prisma.auditLog.count).mockResolvedValue(123);
    const res = await GET(req("page=2&perPage=25"));
    const json = (await res.json()) as {
      data: { meta: { total: number; page: number; perPage: number } };
    };
    expect(json.data.meta.total).toBe(123);
    expect(json.data.meta.page).toBe(2);
    expect(json.data.meta.perPage).toBe(25);
  });

  it("preserves the legacy `limit`/`offset` shape (back-compat)", async () => {
    await GET(req("limit=10&offset=5"));
    const call = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0]!;
    expect(call.take).toBe(10);
    expect(call.skip).toBe(5);
  });

  it("supports the legacy `filter=auth` shortcut", async () => {
    await GET(req("filter=auth"));
    const call = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0]!;
    const where = call.where as Record<string, unknown>;
    // startsWith "auth." is the legacy contract
    expect(JSON.stringify(where.action)).toContain("auth.");
  });

  it("matches `actor` against the acting account too", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: "guardian-1" },
    ] as never);
    await GET(req("actor=parent"));
    const call = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0]!;
    const or = (call.where as { OR: Array<Record<string, unknown>> }).OR;
    expect(or).toContainEqual({ actorUserId: "parent" });
    expect(or).toContainEqual({ actorUserId: { in: ["guardian-1"] } });
  });
});

describe("GET /api/admin/audit-log — who acted (#1403)", () => {
  const base = {
    ipAddress: null,
    location: null,
    asn: null,
    carrier: null,
    details: null,
    createdAt: new Date("2026-11-19T10:00:00Z"),
  };

  it("selects actorUserId and returns the resolved actor beside the record", async () => {
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([
      {
        ...base,
        id: "a1",
        action: "documents.inbound.store",
        actorUserId: "guardian-1",
        user: { id: "profile-1", username: "managed-1" },
      },
      {
        ...base,
        id: "a2",
        action: "auth.login",
        actorUserId: null,
        user: { id: "admin-1", username: "admin" },
      },
      {
        ...base,
        id: "a3",
        action: "documents.inbound.discard",
        actorUserId: "gone-1",
        user: { id: "profile-1", username: "managed-1" },
      },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: "guardian-1", username: "parent" },
    ] as never);

    const res = await GET(req("filter=all"));
    const select = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0]!
      .select as Record<string, unknown>;
    expect(select.actorUserId).toBe(true);

    const lookup = vi.mocked(prisma.user.findMany).mock.calls[0][0]!;
    expect(lookup.where).toEqual({ id: { in: ["guardian-1", "gone-1"] } });
    expect(lookup.select).toEqual({ id: true, username: true });

    const entries = ((await res.json()) as { data: { entries: unknown[] } })
      .data.entries as Array<Record<string, unknown>>;
    expect(entries[0].actor).toEqual({ id: "guardian-1", username: "parent" });
    expect(entries[0].user).toEqual({ id: "profile-1", username: "managed-1" });
    expect(entries[1].actor).toBeNull();
    // A deleted acting account keeps its id; it never collapses into a
    // self-action.
    expect(entries[2].actor).toEqual({ id: "gone-1", username: null });
    // The raw column does not ride the wire beside the resolved actor.
    expect(entries[0]).not.toHaveProperty("actorUserId");
  });

  it("skips the user lookup when no row has an actor", async () => {
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([
      {
        ...base,
        id: "a2",
        action: "auth.login",
        actorUserId: null,
        user: { id: "admin-1", username: "admin" },
      },
    ] as never);
    await GET(req());
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});
