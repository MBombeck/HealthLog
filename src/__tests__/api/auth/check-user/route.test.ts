/**
 * v1.4.41 W-IOS-COORD SB-7 follow-up — pin the four-branch discovery
 * contract for `POST /api/auth/check-user`. The iOS onboarding screen
 * branches on `branch` to decide which credential form to render; any
 * regression that drops a branch silently makes the wrong form appear.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 29,
    resetAt: Date.now() + 15 * 60 * 1000,
  }),
  // v1.4.43 W13 M-4 — the route now routes through the auth-surface
  // wrapper. Default to a clean per-IP result.
  checkAuthSurfaceRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 29,
    resetAt: Date.now() + 15 * 60 * 1000,
    ip: "203.0.113.1",
  }),
  rateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/lib/auth/hmac", () => ({
  hashToken: vi.fn(
    (raw: string) =>
      `hash-${Buffer.from(raw, "utf-8")
        .toString("hex")
        .slice(0, 16)
        .padStart(16, "0")}`,
  ),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "@/app/api/auth/check-user/route";
import { prisma } from "@/lib/db";
import {
  checkRateLimit,
  checkAuthSurfaceRateLimit,
} from "@/lib/rate-limit";

interface CheckUserBody {
  data: {
    branch: "not_found" | "passkey_only" | "email_fallback" | "exists";
    hasPasskey: boolean;
    hasPassword: boolean;
  };
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/auth/check-user", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 29,
    resetAt: Date.now() + 15 * 60 * 1000,
  });
  vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 29,
    resetAt: Date.now() + 15 * 60 * 1000,
    ip: "203.0.113.1",
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/auth/check-user", () => {
  it("returns `not_found` when no account matches the identifier", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    const res = await POST(makeRequest({ identifier: "ghost@example.com" }));
    const body = (await res.json()) as CheckUserBody;
    expect(res.status).toBe(200);
    expect(body.data.branch).toBe("not_found");
    expect(body.data.hasPasskey).toBe(false);
    expect(body.data.hasPassword).toBe(false);
  });

  it("returns `passkey_only` when the user has passkeys and no password", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "u1",
      passwordHash: null,
      _count: { passkeys: 2 },
    } as never);
    const res = await POST(makeRequest({ identifier: "marc" }));
    const body = (await res.json()) as CheckUserBody;
    expect(body.data.branch).toBe("passkey_only");
    expect(body.data.hasPasskey).toBe(true);
    expect(body.data.hasPassword).toBe(false);
  });

  it("returns `email_fallback` when the user has a password (regardless of passkey count)", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "u2",
      passwordHash: "argon2id$…",
      _count: { passkeys: 1 },
    } as never);
    const res = await POST(makeRequest({ identifier: "marc" }));
    const body = (await res.json()) as CheckUserBody;
    expect(body.data.branch).toBe("email_fallback");
    expect(body.data.hasPasskey).toBe(true);
    expect(body.data.hasPassword).toBe(true);
  });

  it("returns `exists` when the user has neither passkey nor password (recovery path)", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "u3",
      passwordHash: null,
      _count: { passkeys: 0 },
    } as never);
    const res = await POST(makeRequest({ identifier: "marc" }));
    const body = (await res.json()) as CheckUserBody;
    expect(body.data.branch).toBe("exists");
    expect(body.data.hasPasskey).toBe(false);
    expect(body.data.hasPassword).toBe(false);
  });

  it("422s when identifier is missing or blank", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(422);
  });

  it("queries the identifier exactly as iOS sends it (no case-fold)", async () => {
    // Register stores email + username verbatim (no `.toLowerCase()`
    // transform in `registerSchema`); folding here would route a
    // mixed-case existing account to the sign-up branch.
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    await POST(makeRequest({ identifier: "MixedCase@Example.com" }));
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { username: "MixedCase@Example.com" },
            { email: "MixedCase@Example.com" },
          ],
        },
      }),
    );
  });

  it("returns 429 when the per-IP rate-limit is exhausted", async () => {
    vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 15 * 60 * 1000,
      ip: "203.0.113.1",
    } as never);
    const res = await POST(makeRequest({ identifier: "anyone@example.com" }));
    expect(res.status).toBe(429);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });
});
