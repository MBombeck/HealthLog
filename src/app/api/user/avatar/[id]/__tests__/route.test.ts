import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
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

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

// Narrow the `apiHandler` signature for the test fixtures (see
// disable-coach/__tests__/route.test.ts for the precedent).
type RouteCtx = { params: Promise<{ id: string }> };
const get = GET as (r: Request, ctx: RouteCtx) => Promise<Response>;

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function mkRequest() {
  return new Request("http://localhost/api/user/avatar/user-1");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/user/avatar/{id}", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await get(mkRequest(), ctx("user-1"));
    expect(res.status).toBe(401);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("refuses cross-user reads with 403", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const res = await get(mkRequest(), ctx("someone-else"));
    expect(res.status).toBe(403);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 when the user has no avatar", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      avatarBytes: null,
      avatarContentType: null,
      avatarUpdatedAt: null,
    } as never);

    const res = await get(mkRequest(), ctx("user-1"));
    expect(res.status).toBe(404);
  });

  it("returns the bytes with the persisted content-type", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      avatarBytes: bytes,
      avatarContentType: "image/jpeg",
      avatarUpdatedAt: new Date(),
    } as never);

    const res = await get(mkRequest(), ctx("user-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toContain("immutable");

    const echoed = Buffer.from(await res.arrayBuffer());
    expect(echoed.equals(bytes)).toBe(true);
  });
});
