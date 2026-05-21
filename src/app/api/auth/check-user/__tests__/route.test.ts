import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// --- Mocks must come before importing the route. ---

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

// The real `hashToken` is an HMAC-SHA256 (one-way + key-dependent); the
// shape only matters here, so a deterministic stand-in keeps the test
// stable without standing up the env-keyed CipherSuite. The PII check
// below asserts the raw identifier never appears in the audit payload.
vi.mock("@/lib/auth/hmac", () => ({
  hashToken: vi.fn(
    (raw: string) =>
      `hash-${Buffer.from(raw, "utf-8")
        .toString("hex")
        .slice(0, 16)
        .padStart(16, "0")}`,
  ),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi
    .fn()
    .mockResolvedValue({ allowed: true, remaining: 30, resetAt: 0 }),
  // v1.4.43 W13 M-4 — `check-user` now routes through the auth-surface
  // wrapper so the trust-violation branch can swap to a tighter global
  // bucket. Default to a clean per-IP result.
  checkAuthSurfaceRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 30,
    resetAt: 0,
    ip: "203.0.113.1",
  }),
  rateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/lib/logging/transports", () => ({
  emitIfSampled: vi.fn(),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { hashToken } from "@/lib/auth/hmac";

function expectedHash(identifier: string): string {
  return (hashToken as unknown as (s: string) => string)(identifier);
}

function makeRequest(body: { identifier: string }): NextRequest {
  return new NextRequest("http://localhost/api/auth/check-user", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(prisma.user.findFirst).mockReset();
  vi.mocked(auditLog).mockReset();
  vi.mocked(auditLog).mockResolvedValue(undefined as never);
});

describe("POST /api/auth/check-user — audit-log row (M-1)", () => {
  it("writes an audit row for the not_found branch with identifier_hash (never raw)", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);

    const res = await POST(makeRequest({ identifier: "ghost@example.com" }));
    expect(res.status).toBe(200);

    expect(auditLog).toHaveBeenCalledTimes(1);
    const args = vi.mocked(auditLog).mock.calls[0];
    expect(args[0]).toBe("auth.check-user");
    expect(args[1]).toEqual({
      ipAddress: "203.0.113.1",
      details: {
        branch: "not_found",
        identifier_hash: expectedHash("ghost@example.com"),
      },
    });
    // The raw identifier must not leak into the details — every other
    // /api/auth/* audit row already hashes; the check-user route follows
    // the same shape.
    const details = args[1]?.details as Record<string, unknown> | undefined;
    expect(details).not.toHaveProperty("identifier");
    expect(JSON.stringify(details)).not.toContain("ghost@example.com");
  });

  it("writes an audit row for the passkey_only branch with userId attached", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user-1",
      passwordHash: null,
      _count: { passkeys: 2 },
    } as never);

    const res = await POST(makeRequest({ identifier: "marc" }));
    expect(res.status).toBe(200);

    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(vi.mocked(auditLog).mock.calls[0][1]).toEqual({
      userId: "user-1",
      ipAddress: "203.0.113.1",
      details: {
        branch: "passkey_only",
        identifier_hash: expectedHash("marc"),
      },
    });
  });

  it("writes an audit row for the email_fallback branch with userId attached", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user-2",
      passwordHash: "$argon2id$...",
      _count: { passkeys: 0 },
    } as never);

    const res = await POST(makeRequest({ identifier: "marc@example.com" }));
    expect(res.status).toBe(200);

    const args = vi.mocked(auditLog).mock.calls[0];
    expect(args[1]?.details).toEqual({
      branch: "email_fallback",
      identifier_hash: expectedHash("marc@example.com"),
    });
    expect(args[1]?.userId).toBe("user-2");
  });

  it("writes an audit row for the exists branch (no passkey + no password)", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user-3",
      passwordHash: null,
      _count: { passkeys: 0 },
    } as never);

    const res = await POST(makeRequest({ identifier: "stub" }));
    expect(res.status).toBe(200);

    const args = vi.mocked(auditLog).mock.calls[0];
    expect(args[1]?.details).toEqual({
      branch: "exists",
      identifier_hash: expectedHash("stub"),
    });
    expect(args[1]?.userId).toBe("user-3");
  });
});
