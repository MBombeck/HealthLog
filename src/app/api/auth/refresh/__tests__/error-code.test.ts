/**
 * v1.7.0 — stable machine `errorCode` on POST /api/auth/refresh.
 *
 * Native clients string-adjacent-detected refresh failure before this
 * change. A stable `errorCode` lets iOS branch terminal re-auth
 * (`auth.refresh.reuse` / `auth.refresh.revoked`) from a transient blip
 * without parsing the human-prose `error`. This pins the mapping from
 * `RotationFailureReason` to the wire `errorCode`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/rate-limit", () => ({
  checkAuthSurfaceRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 60,
    resetAt: 0,
    ip: "203.0.113.7",
  }),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/native-client", () => ({
  resolveTokenPolicy: vi.fn(() => ({
    policy: "native",
    accessTokenDays: 1,
    refreshTokenDays: 60,
    tokenLabel: "native",
  })),
}));

vi.mock("@/lib/auth/refresh-token", () => ({
  rotateRefreshToken: vi.fn(),
  revokeRefreshToken: vi.fn(),
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
import { rotateRefreshToken } from "@/lib/auth/refresh-token";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

type Envelope = { error: string; meta?: { errorCode?: string } };

beforeEach(() => {
  vi.mocked(rotateRefreshToken).mockReset();
});

describe("POST /api/auth/refresh — stable errorCode (v1.7.0)", () => {
  it("returns auth.refresh.reuse on a consumed-token replay", async () => {
    vi.mocked(rotateRefreshToken).mockResolvedValue({
      ok: false,
      reason: "already_used",
    });
    const res = await POST(makeRequest({ refreshToken: "hlr_replayed" }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as Envelope;
    expect(json.meta?.errorCode).toBe("auth.refresh.reuse");
  });

  it("returns auth.refresh.revoked when the family was revoked out-of-band", async () => {
    vi.mocked(rotateRefreshToken).mockResolvedValue({
      ok: false,
      reason: "revoked",
    });
    const res = await POST(makeRequest({ refreshToken: "hlr_revoked" }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as Envelope;
    expect(json.meta?.errorCode).toBe("auth.refresh.revoked");
  });

  it("returns auth.refresh.invalid for a not-found token", async () => {
    vi.mocked(rotateRefreshToken).mockResolvedValue({
      ok: false,
      reason: "not_found",
    });
    const res = await POST(makeRequest({ refreshToken: "hlr_unknown" }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as Envelope;
    expect(json.meta?.errorCode).toBe("auth.refresh.invalid");
  });

  it("returns auth.refresh.invalid for an expired token", async () => {
    vi.mocked(rotateRefreshToken).mockResolvedValue({
      ok: false,
      reason: "expired",
    });
    const res = await POST(makeRequest({ refreshToken: "hlr_expired" }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as Envelope;
    expect(json.meta?.errorCode).toBe("auth.refresh.invalid");
  });
});
