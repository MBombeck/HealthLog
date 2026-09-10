/**
 * v1.18.7 — public passphrase-gate verifier (POST /api/c/{token}/unlock).
 *
 * Asserts the load-bearing properties:
 *   - a correct passphrase sets a short-lived, token-scoped httpOnly cookie;
 *   - a wrong passphrase is rejected with a blunt 401, no cookie set;
 *   - an unknown / revoked / expired token (gate null) is the same blunt 401;
 *   - a link with no passphrase set cannot be unlocked;
 *   - the route is rate-limited BEFORE any compare.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const TEST_HMAC_KEY = "test-hmac-key-at-least-32-chars-long-xxxxx";

const cookieSet = vi.fn();
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: cookieSet,
    delete: () => {},
  })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {},
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/clinician-share/resolve-share-token", () => ({
  resolveShareGateState: vi.fn(),
}));
vi.mock("@/lib/clinician-share/passphrase", () => ({
  verifyPassphrase: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkAuthSurfaceRateLimit: vi.fn(),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "../route";
import { resolveShareGateState } from "@/lib/clinician-share/resolve-share-token";
import { verifyPassphrase } from "@/lib/clinician-share/passphrase";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";

const TOKEN = `hls_${"a".repeat(48)}`;
const TOKEN_HASH = "f".repeat(64);

function req(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/c/${TOKEN}/unlock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function call() {
  return POST(req({ passphrase: "ABCD-EFGH-JKMN-PQRS" }), {
    params: Promise.resolve({ token: TOKEN }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("API_TOKEN_HMAC_KEY", TEST_HMAC_KEY);
  vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 9,
    resetAt: Date.now() + 60_000,
    ip: "1.2.3.4",
  });
});

describe("POST /api/c/[token]/unlock", () => {
  it("sets a token-scoped httpOnly cookie on a correct passphrase", async () => {
    vi.mocked(resolveShareGateState).mockResolvedValue({
      tokenHash: TOKEN_HASH,
      passphraseHash: "deadbeef",
    });
    vi.mocked(verifyPassphrase).mockReturnValue(true);

    const res = await call();
    expect(res.status).toBe(200);

    expect(cookieSet).toHaveBeenCalledTimes(1);
    const [name, , opts] = cookieSet.mock.calls[0];
    expect(name).toContain("hls_unlock_");
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("strict");
    // Scoped to THIS token's view path only.
    expect(opts.path).toBe(`/c/${TOKEN}`);
    expect(opts.maxAge).toBeGreaterThan(0);
    expect(opts.maxAge).toBeLessThanOrEqual(30 * 60);
  });

  it("rejects a wrong passphrase with a blunt 401, no cookie", async () => {
    vi.mocked(resolveShareGateState).mockResolvedValue({
      tokenHash: TOKEN_HASH,
      passphraseHash: "deadbeef",
    });
    vi.mocked(verifyPassphrase).mockReturnValue(false);

    const res = await call();
    expect(res.status).toBe(401);
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("rejects an unknown / revoked / expired token (gate null) with 401", async () => {
    vi.mocked(resolveShareGateState).mockResolvedValue(null);

    const res = await call();
    expect(res.status).toBe(401);
    expect(verifyPassphrase).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("cannot unlock a link with no passphrase set", async () => {
    vi.mocked(resolveShareGateState).mockResolvedValue({
      tokenHash: TOKEN_HASH,
      passphraseHash: null,
    });
    // verifyPassphrase returns false for a null stored hash.
    vi.mocked(verifyPassphrase).mockReturnValue(false);

    const res = await call();
    expect(res.status).toBe(401);
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("is rate-limited before any compare", async () => {
    vi.mocked(resolveShareGateState).mockResolvedValue({
      tokenHash: TOKEN_HASH,
      passphraseHash: "deadbeef",
    });
    vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 60_000,
      ip: "1.2.3.4",
    });

    const res = await call();
    expect(res.status).toBe(429);
    expect(verifyPassphrase).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });
});
