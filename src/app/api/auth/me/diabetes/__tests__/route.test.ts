import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The declared diabetes flag is the one preference that switches every
 * glucose surface from the general normal bands to the ADA glycemic goal
 * bands and reaches the Coach snapshot. The web toggle in the thresholds
 * section rides this route, so the round trip has to hold: a PATCH writes
 * the column and echoes the resolved state, and a GET reads it back.
 */

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
    limit: 60,
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
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function mkGet(): Request {
  return new Request("http://localhost/api/auth/me/diabetes");
}

function mkPatch(body: unknown): Request {
  return new Request("http://localhost/api/auth/me/diabetes", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/auth/me/diabetes", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await (GET as (r: Request) => Promise<Response>)(mkGet());
    expect(res.status).toBe(401);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns false for a user who never declared the flag", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      hasDiabetes: false,
    } as never);

    const res = await (GET as (r: Request) => Promise<Response>)(mkGet());
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: { hasDiabetes: boolean } };
    expect(env.data.hasDiabetes).toBe(false);
  });

  it("returns true after the flag was declared", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      hasDiabetes: true,
    } as never);

    const res = await (GET as (r: Request) => Promise<Response>)(mkGet());
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: { hasDiabetes: boolean } };
    expect(env.data.hasDiabetes).toBe(true);
  });
});

describe("PATCH /api/auth/me/diabetes", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ hasDiabetes: true }),
    );
    expect(res.status).toBe(401);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("writes the flag on, echoes it back, and audits the transition", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      hasDiabetes: false,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ hasDiabetes: true }),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: { hasDiabetes: boolean } };
    expect(env.data.hasDiabetes).toBe(true);

    // The write must actually land, scoped to the caller, field-by-field.
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { hasDiabetes: true },
    });

    expect(auditLog).toHaveBeenCalledWith(
      "user.diabetes.update",
      expect.objectContaining({
        userId: "user-1",
        details: expect.objectContaining({ previous: false, next: true }),
      }),
    );
  });

  it("writes the flag off and echoes the resolved state", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      hasDiabetes: true,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ hasDiabetes: false }),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: { hasDiabetes: boolean } };
    expect(env.data.hasDiabetes).toBe(false);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { hasDiabetes: false },
    });
  });

  it("rejects a missing hasDiabetes field with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ otherField: true }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean hasDiabetes field with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ hasDiabetes: "true" }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("returns 429 when the per-user rate-limit fires", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 30_000,
    });

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ hasDiabetes: true }),
    );
    expect(res.status).toBe(429);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
