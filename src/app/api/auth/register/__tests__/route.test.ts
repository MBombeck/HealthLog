/**
 * v1.4.43 W6 — multi-issue 422 envelope on POST /api/auth/register.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      count: vi.fn().mockResolvedValue(1),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    appSettings: {
      findUnique: vi.fn().mockResolvedValue({ registrationEnabled: true }),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({
  createSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/password", () => ({
  hashPassword: vi.fn().mockResolvedValue("hashed"),
  checkPasswordStrength: vi.fn().mockReturnValue({ isAcceptable: true, feedback: [] }),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  checkAuthSurfaceRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
}));

vi.mock("@/lib/i18n/server-locale", () => ({
  resolveServerLocale: vi.fn().mockResolvedValue("en"),
}));

vi.mock("@/lib/tz/resolver", () => ({
  isValidTimezone: vi.fn().mockReturnValue(true),
  resolveServerDefaultTimezone: vi.fn().mockResolvedValue("Europe/Berlin"),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
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

import { POST } from "../route";
import { checkRateLimit, checkAuthSurfaceRateLimit } from "@/lib/rate-limit";

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
    allowed: true,
    ip: "1.2.3.4",
  } as never);
});

describe("POST /api/auth/register — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // Bad email + too-short username.
    const res = await postPathThrough({ email: "not-an-email", username: "x" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces THREE simultaneous validation errors", async () => {
    // Bad email + bad username + bad password.
    const res = await postPathThrough({
      email: "not-an-email",
      username: "x",
      password: "weak",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });
});

async function postPathThrough(body: unknown): Promise<Response> {
  return POST(postReq(body));
}
