/**
 * GET /api/fitbit/connect
 *
 * Pins: happy path mints a nonce + PKCE pair and redirects to the Fitbit
 * consent screen; rate-limit and no-credentials both redirect back to
 * `/settings/integrations?fitbit=error&reason=<tag>` rather than returning
 * JSON — a browser-navigation entry point should never surface an unstyled
 * JSON page.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u-1" } })),
}));

vi.mock("@/lib/db", () => ({
  prisma: { fitbitOAuthState: { create: vi.fn() } },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/fitbit/credentials", () => ({
  getUserFitbitCredentials: vi.fn(),
}));

vi.mock("@/lib/fitbit/oauth", () => ({
  fitbitOAuth: {
    authorizationUrl: vi.fn(
      () => "https://www.fitbit.com/oauth2/authorize?state=nonce-stub",
    ),
  },
}));

vi.mock("@/lib/integrations/oauth-kit/pkce", () => ({
  generatePkcePair: vi.fn(() => ({
    verifier: "verifier-stub",
    challenge: "challenge-stub",
  })),
}));

vi.mock("@/lib/fitbit/oauth-state", () => ({
  FITBIT_OAUTH_STATE_COOKIE: "fitbit_oauth_state",
  FITBIT_OAUTH_STATE_TTL_MS: 10 * 60 * 1000,
  mintFitbitOAuthStateNonce: vi.fn(() => "nonce-stub"),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => ({ setError: vi.fn() })),
}));

vi.mock("@/lib/auth/secure-cookie", () => ({
  shouldEmitSecureCookie: () => true,
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { getUserFitbitCredentials } from "@/lib/fitbit/credentials";
import { isFitbitRetired } from "@/lib/fitbit/retirement";

function connectRequest(): NextRequest {
  return new NextRequest("http://localhost/api/fitbit/connect", {
    method: "GET",
  });
}

beforeEach(() => {
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetAt: Date.now() + 60_000,
  } as never);
  vi.mocked(prisma.fitbitOAuthState.create).mockReset();
  vi.mocked(prisma.fitbitOAuthState.create).mockResolvedValue({} as never);
  vi.mocked(getUserFitbitCredentials).mockResolvedValue({
    clientId: "client-id",
    clientSecret: "client-secret",
  } as never);
});

describe("GET /api/fitbit/connect", () => {
  it("redirects to the Fitbit authorize URL on the happy path", async () => {
    const response = await GET(connectRequest());
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      "www.fitbit.com/oauth2/authorize",
    );
    expect(prisma.fitbitOAuthState.create).toHaveBeenCalledTimes(1);
  });

  it("redirects to reason=rate_limited when the bucket is exhausted", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    } as never);

    const response = await GET(connectRequest());
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("/settings/integrations");
    expect(location).toContain("fitbit=error");
    expect(location).toContain("reason=rate_limited");
    expect(prisma.fitbitOAuthState.create).not.toHaveBeenCalled();
  });

  it("redirects to reason=nocreds when no per-user credentials are stored", async () => {
    vi.mocked(getUserFitbitCredentials).mockResolvedValueOnce(null);

    const response = await GET(connectRequest());
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("/settings/integrations");
    expect(location).toContain("fitbit=error");
    expect(location).toContain("reason=nocreds");
    expect(prisma.fitbitOAuthState.create).not.toHaveBeenCalled();
  });
  it("redirects to reason=retired once Google has turned the Web API off", async () => {
    vi.mocked(isFitbitRetired).mockReturnValue(true);
    try {
      const response = await GET(connectRequest());
      const location = response.headers.get("location") ?? "";
      expect(location).toContain("fitbit=error");
      expect(location).toContain("reason=retired");
      expect(prisma.fitbitOAuthState.create).not.toHaveBeenCalled();
    } finally {
      vi.mocked(isFitbitRetired).mockReturnValue(false);
    }
  });
});
