import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
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

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 59,
    resetAt: Date.now() + 60_000,
  }),
  rateLimitHeaders: () => ({}),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, PATCH } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit } from "@/lib/rate-limit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

function mkPatch(body: unknown): Request {
  return new Request("http://localhost/api/auth/me/disable-coach", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/auth/me/disable-coach", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/disable-coach"),
    );
    expect(res.status).toBe(401);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns false for a fresh user", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      disableCoach: false,
    } as never);

    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/disable-coach"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: { disableCoach: boolean } };
    expect(env.data.disableCoach).toBe(false);
  });

  it("returns true for an opted-out user", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      disableCoach: true,
    } as never);

    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/disable-coach"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: { disableCoach: boolean } };
    expect(env.data.disableCoach).toBe(true);
  });

  it("returns false when the column is missing (partial-deploy rollback)", async () => {
    // Defensive default — the API surface tolerates a `findUnique`
    // result that doesn't contain the column. Belt-and-braces with the
    // schema-level NOT NULL default; both layers keep the Coach
    // visible by default for users who never opted out.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({} as never);

    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/disable-coach"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: { disableCoach: boolean } };
    expect(env.data.disableCoach).toBe(false);
  });
});

describe("PATCH /api/auth/me/disable-coach", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ disableCoach: true }),
    );
    expect(res.status).toBe(401);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("flips the column on and writes the enable audit row", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      disableCoach: false,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ disableCoach: true }),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: { disableCoach: boolean } };
    expect(env.data.disableCoach).toBe(true);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { disableCoach: true },
    });

    expect(auditLog).toHaveBeenCalledWith(
      "user.disable-coach.enable",
      expect.objectContaining({
        userId: "user-1",
        details: expect.objectContaining({
          previous: false,
          next: true,
        }),
      }),
    );
  });

  it("flips the column off and writes the disable audit row", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      disableCoach: true,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ disableCoach: false }),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: { disableCoach: boolean } };
    expect(env.data.disableCoach).toBe(false);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { disableCoach: false },
    });

    expect(auditLog).toHaveBeenCalledWith(
      "user.disable-coach.disable",
      expect.objectContaining({
        userId: "user-1",
        details: expect.objectContaining({
          previous: true,
          next: false,
        }),
      }),
    );
  });

  it("rejects a missing disableCoach field with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ otherField: "ignored" }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean disableCoach field with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ disableCoach: "true" }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const req = new Request("http://localhost/api/auth/me/disable-coach", {
      method: "PATCH",
      body: "{ not valid json",
      headers: { "Content-Type": "application/json" },
    });

    const res = await (PATCH as (r: Request) => Promise<Response>)(req);
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("is idempotent when the column already holds the requested value", async () => {
    // Toggling a column from true→true (or false→false) still writes
    // through so the audit row exists. Matches the research-mode
    // route's "always write" posture.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      disableCoach: true,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ disableCoach: true }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledTimes(1);
  });

  it("returns 429 when the per-user rate-limit fires", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 30_000,
    });

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ disableCoach: true }),
    );
    expect(res.status).toBe(429);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
