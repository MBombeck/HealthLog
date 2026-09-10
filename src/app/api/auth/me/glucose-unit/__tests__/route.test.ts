import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The blood-glucose display unit — the writer the column never had.
 *
 * `User.glucoseUnit` shipped in v1.2 and about thirty surfaces read it, but
 * no route, form or schema could ever set it, so every account stayed on the
 * mg/dL default and the mmol/L half of the app was dead code. This pins the
 * missing end: a PATCH writes the column and echoes the resolved state, a GET
 * reads it back, and an unrecognised unit is refused rather than stored —
 * a stray string in that column would resolve to mg/dL and quietly put every
 * mmol/L reader back on the wrong number.
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
  return new Request("http://localhost/api/auth/me/glucose-unit");
}

function mkPatch(body: unknown): Request {
  return new Request("http://localhost/api/auth/me/glucose-unit", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/auth/me/glucose-unit", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await (GET as (r: Request) => Promise<Response>)(mkGet());
    expect(res.status).toBe(401);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("resolves an account that never chose to mg/dL", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      glucoseUnit: null,
    } as never);

    const res = await (GET as (r: Request) => Promise<Response>)(mkGet());
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: { glucoseUnit: string } };
    expect(env.data.glucoseUnit).toBe("mg/dL");
  });

  it("reads back the unit the account chose", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      glucoseUnit: "mmol/L",
    } as never);

    const res = await (GET as (r: Request) => Promise<Response>)(mkGet());
    const env = (await res.json()) as { data: { glucoseUnit: string } };
    expect(env.data.glucoseUnit).toBe("mmol/L");
  });
});

describe("PATCH /api/auth/me/glucose-unit", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ glucoseUnit: "mmol/L" }),
    );
    expect(res.status).toBe(401);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("moves an account to mmol/L, echoes it, and audits the transition", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      glucoseUnit: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ glucoseUnit: "mmol/L" }),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: { glucoseUnit: string } };
    expect(env.data.glucoseUnit).toBe("mmol/L");

    // The write must actually land, scoped to the caller, field-by-field.
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { glucoseUnit: "mmol/L" },
    });

    expect(auditLog).toHaveBeenCalledWith(
      "user.glucose-unit.update",
      expect.objectContaining({
        userId: "user-1",
        details: expect.objectContaining({
          previous: "mg/dL",
          next: "mmol/L",
        }),
      }),
    );
  });

  it("moves an account back to mg/dL", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      glucoseUnit: "mmol/L",
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ glucoseUnit: "mg/dL" }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { glucoseUnit: "mg/dL" },
    });
  });

  it("refuses a unit outside the two the app renders", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    for (const bad of ["mmol/l", "mgdl", "imperial", "", 1]) {
      const res = await (PATCH as (r: Request) => Promise<Response>)(
        mkPatch({ glucoseUnit: bad }),
      );
      expect(res.status).toBe(422);
    }
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects a missing glucoseUnit field with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ otherField: "mmol/L" }),
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
      mkPatch({ glucoseUnit: "mmol/L" }),
    );
    expect(res.status).toBe(429);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
