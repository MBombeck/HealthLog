/**
 * v1.4.48 L5 + L14 — GET /api/withings/connect
 *
 * Pins:
 *   1. Happy path: mints a nonce, creates a `WithingsOAuthState` row,
 *      redirects to the Withings authorize URL with the state cookie
 *      attached.
 *   2. Rate-limit: the 11th call in a 60 s window redirects to
 *      `/settings/integrations?withings=error&reason=rate_limited`
 *      and does not call `prisma.withingsOAuthState.create`.
 *   3. Row-create failure: a Prisma error inside the try/catch
 *      redirects to
 *      `/settings/integrations?withings=error&reason=connect`
 *      instead of bubbling a 500.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({
    user: { id: "u-1" },
    session: { id: "s-1" },
  })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    withingsOAuthState: {
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/withings/credentials", () => ({
  getUserWithingsCredentials: vi.fn(),
}));

vi.mock("@/lib/withings/client", () => ({
  getAuthorizationUrl: vi.fn(
    () => "https://account.withings.com/oauth2_user/authorize2?state=nonce-stub",
  ),
}));

vi.mock("@/lib/withings/oauth-state", () => ({
  WITHINGS_OAUTH_STATE_COOKIE: "withings_oauth_state",
  WITHINGS_OAUTH_STATE_TTL_MS: 10 * 60 * 1000,
  mintWithingsOAuthStateNonce: vi.fn(() => "nonce-stub"),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => ({
    setError: vi.fn(),
    addWarning: vi.fn(),
  })),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { getUserWithingsCredentials } from "@/lib/withings/credentials";

function connectRequest(): NextRequest {
  return new NextRequest("http://localhost/api/withings/connect", {
    method: "GET",
  });
}

beforeEach(() => {
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetAt: Date.now() + 60_000,
  } as never);
  vi.mocked(prisma.withingsOAuthState.create).mockReset();
  vi.mocked(prisma.withingsOAuthState.create).mockResolvedValue(
    {} as never,
  );
  vi.mocked(getUserWithingsCredentials).mockResolvedValue({
    clientId: "client-id",
    clientSecret: "client-secret",
  } as never);
});

describe("GET /api/withings/connect", () => {
  it("redirects to the Withings authorize URL on the happy path", async () => {
    const response = await GET(connectRequest());

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      "account.withings.com/oauth2_user/authorize2",
    );
    expect(prisma.withingsOAuthState.create).toHaveBeenCalledTimes(1);
    expect(checkRateLimit).toHaveBeenCalledWith(
      "withings:connect:u-1",
      10,
      60_000,
    );
  });

  it("redirects to reason=rate_limited when the 11th call within 60 s is rejected", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    } as never);

    const response = await GET(connectRequest());

    expect(response.status).toBe(307);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("/settings/integrations");
    expect(location).toContain("withings=error");
    expect(location).toContain("reason=rate_limited");
    expect(prisma.withingsOAuthState.create).not.toHaveBeenCalled();
  });

  it("redirects to reason=connect when the row create throws", async () => {
    vi.mocked(prisma.withingsOAuthState.create).mockRejectedValueOnce(
      new Error("Prisma transient failure"),
    );

    const response = await GET(connectRequest());

    expect(response.status).toBe(307);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("/settings/integrations");
    expect(location).toContain("withings=error");
    expect(location).toContain("reason=connect");
  });
});
