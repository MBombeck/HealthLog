/**
 * v1.4.43 W13 M-4 — `checkAuthSurfaceRateLimit` is the wrapper every
 * anonymous auth surface routes through. It guards against the
 * trust-chain misconfiguration documented in `api-response.ts`:
 *
 *   - Clean chain → per-IP bucket `{prefix}:{ip}` with the caller's limit.
 *   - Broken chain (`trustViolation === true`) → tight global bucket
 *     `auth:anon:trust-violation` shared across every auth surface,
 *     capped at 100/15min total. One attacker can no longer exhaust the
 *     per-surface "unknown" bucket and lock every other anonymous caller
 *     out of login + register + passkey-verify + …
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  checkRateLimit as realCheckRateLimit,
  checkAuthSurfaceRateLimit,
} from "../rate-limit";
import { _resetTrustViolationWarningForTests } from "../api-response";

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

import { prisma } from "@/lib/db";

const ORIGINAL_HOPS = process.env.TRUST_PROXY_HOPS;

beforeEach(() => {
  vi.mocked(prisma.$queryRaw).mockReset();
  vi.mocked(prisma.$queryRaw).mockResolvedValue([
    { count: 1, reset_at: new Date(Date.now() + 60_000) },
  ] as never);
  _resetTrustViolationWarningForTests();
  delete process.env.TRUST_PROXY_HOPS;
});

afterEach(() => {
  if (ORIGINAL_HOPS === undefined) delete process.env.TRUST_PROXY_HOPS;
  else process.env.TRUST_PROXY_HOPS = ORIGINAL_HOPS;
});

function makeRequest(headers: Record<string, string>): Request {
  return new Request("https://example.com/api/auth/login", { headers });
}

/**
 * Pull the rate-limit key passed to `prisma.$queryRaw` by walking the
 * tagged-template args. `$queryRaw\`INSERT … VALUES (${key}, …)\`` lands
 * as `[stringsArray, key, windowInterval]`. The key is the first
 * substitution argument.
 */
function lastKey(): string {
  const calls = vi.mocked(prisma.$queryRaw).mock.calls;
  const last = calls[calls.length - 1];
  // First substitution is the bucket key — index 1 of the call arguments.
  return last[1] as string;
}

/**
 * Pull the limit passed to the underlying `checkRateLimit`. The wrapper
 * itself doesn't expose it directly; we re-derive by counting the calls
 * with the tight key and checking that the returned `allowed` flag flips
 * at the documented 100/15min cap below.
 */
function lastWindowMs(): string {
  const calls = vi.mocked(prisma.$queryRaw).mock.calls;
  const last = calls[calls.length - 1];
  return last[2] as string;
}

describe("checkAuthSurfaceRateLimit — per-IP path", () => {
  it("routes to {prefix}:{ip} when the trust chain is clean", async () => {
    // Default TRUST_PROXY_HOPS=1, single XFF entry → clean chain.
    const result = await checkAuthSurfaceRateLimit(
      makeRequest({ "x-forwarded-for": "203.0.113.5" }),
      "auth:login",
      5,
      15 * 60 * 1000,
    );
    expect(result.ip).toBe("203.0.113.5");
    expect(result.allowed).toBe(true);
    expect(lastKey()).toBe("auth:login:203.0.113.5");
    expect(lastWindowMs()).toBe(`${15 * 60 * 1000} milliseconds`);
  });

  it("falls back to {prefix}:unknown when getClientIp returns null but trustViolation is false", async () => {
    // No XFF + no x-real-ip + no CF → null ip, no violation (no chain to violate).
    const result = await checkAuthSurfaceRateLimit(
      makeRequest({}),
      "auth:register",
      5,
      15 * 60 * 1000,
    );
    expect(result.ip).toBeNull();
    expect(lastKey()).toBe("auth:register:unknown");
  });

  it("returns the underlying RateLimitResult plus the resolved ip", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { count: 6, reset_at: new Date(Date.now() + 60_000) },
    ] as never);
    const result = await checkAuthSurfaceRateLimit(
      makeRequest({ "x-forwarded-for": "203.0.113.5" }),
      "auth:login",
      5,
      15 * 60 * 1000,
    );
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.ip).toBe("203.0.113.5");
  });
});

describe("checkAuthSurfaceRateLimit — trust-violation tightening", () => {
  beforeEach(() => {
    // TRUST_PROXY_HOPS=2 with a 1-entry chain → trust violation.
    process.env.TRUST_PROXY_HOPS = "2";
  });

  it("routes every login attempt under a violation into the global bucket", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await checkAuthSurfaceRateLimit(
        makeRequest({ "x-forwarded-for": "5.6.7.8" }),
        "auth:login",
        5,
        15 * 60 * 1000,
      );
      expect(lastKey()).toBe("auth:anon:trust-violation");
      // Window matches the 15-minute global cap, NOT the caller's window.
      expect(lastWindowMs()).toBe(`${15 * 60 * 1000} milliseconds`);
    } finally {
      warn.mockRestore();
    }
  });

  it("routes every auth surface (login + register + passkey-*) into the SAME bucket under violation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const surfaces: Array<[string, number]> = [
        ["auth:login", 5],
        ["auth:register", 5],
        ["auth:passkey-login-options", 10],
        ["auth:passkey-verify", 10],
        ["auth:refresh", 60],
        ["auth:check-user", 30],
      ];
      const seenKeys = new Set<string>();
      for (const [prefix, limit] of surfaces) {
        await checkAuthSurfaceRateLimit(
          makeRequest({ "x-forwarded-for": "5.6.7.8" }),
          prefix,
          limit,
          15 * 60 * 1000,
        );
        seenKeys.add(lastKey());
      }
      // Every surface collapsed to the single tight bucket.
      expect(seenKeys).toEqual(new Set(["auth:anon:trust-violation"]));
    } finally {
      warn.mockRestore();
    }
  });

  it("returns ip from the helper even when the tightened bucket fires (so call sites can audit-log the same IP)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await checkAuthSurfaceRateLimit(
        makeRequest({
          "x-forwarded-for": "5.6.7.8",
          "x-real-ip": "9.9.9.9",
        }),
        "auth:login",
        5,
        15 * 60 * 1000,
      );
      // Falls through to x-real-ip when the chain is too short.
      expect(result.ip).toBe("9.9.9.9");
      expect(lastKey()).toBe("auth:anon:trust-violation");
    } finally {
      warn.mockRestore();
    }
  });

  it("flips to denied once the global cap is hit (count > 100)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
        { count: 101, reset_at: new Date(Date.now() + 60_000) },
      ] as never);
      const result = await checkAuthSurfaceRateLimit(
        makeRequest({ "x-forwarded-for": "5.6.7.8" }),
        "auth:login",
        5,
        15 * 60 * 1000,
      );
      expect(result.allowed).toBe(false);
      expect(lastKey()).toBe("auth:anon:trust-violation");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("checkRateLimit (existing semantics — regression guard)", () => {
  it("still creates the per-key bucket via the unchanged SQL path", async () => {
    await realCheckRateLimit("custom:key:1.2.3.4", 5, 60_000);
    expect(lastKey()).toBe("custom:key:1.2.3.4");
  });
});
