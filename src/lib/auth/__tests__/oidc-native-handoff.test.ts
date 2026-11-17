import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    oidcNativeHandoff: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

// Deterministic stand-in for the real HMAC — length-keyed so it never contains
// the raw code, making the "raw code is never persisted" assertion meaningful.
vi.mock("@/lib/auth/hmac", () => ({
  hashToken: vi.fn((t: string) => `H(${t.length})`),
}));

const revokeRefreshTokenByHash = vi.fn();
vi.mock("@/lib/auth/refresh-token", () => ({
  revokeRefreshTokenByHash: (h: string) => revokeRefreshTokenByHash(h),
}));

const auditLog = vi.fn();
vi.mock("@/lib/auth/audit", () => ({
  auditLog: (...a: unknown[]) => auditLog(...a),
}));

import {
  mintNativeHandoff,
  consumeNativeHandoff,
  buildNativeCallbackUrl,
  stampIssuedRefreshToken,
  NATIVE_OIDC_REDIRECT_URI,
  NATIVE_OIDC_RETURN_PATH,
  OIDC_NATIVE_HANDOFF_TTL_MS,
  nativeHttpsReturnOrigin,
} from "../oidc-native-handoff";
import { s256Challenge } from "@/lib/mcp/oauth/pkce";
import { prisma } from "@/lib/db";

// A real RFC 7636 verifier + its real S256 challenge, so the constant-time
// verify inside `consumeNativeHandoff` runs for real.
const VERIFIER = "a".repeat(43);
const CHALLENGE = s256Challenge(VERIFIER);

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ho-1",
    userId: "user-1",
    codeHash: "H(47)",
    codeChallenge: CHALLENGE,
    expiresAt: new Date(Date.now() + OIDC_NATIVE_HANDOFF_TTL_MS),
    consumedAt: null,
    issuedRefreshTokenHash: null,
    createdAt: new Date(),
    ipAddress: "1.2.3.4",
    userAgent: "HealthLog-iOS/1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mintNativeHandoff", () => {
  it("mints an hlh_ code, stores only its hash, and binds the challenge + TTL", async () => {
    vi.mocked(prisma.oidcNativeHandoff.create).mockResolvedValue({
      id: "ho-1",
    } as never);

    const before = Date.now();
    const { code, handoffId } = await mintNativeHandoff({
      userId: "user-1",
      appCodeChallenge: CHALLENGE,
      ipAddress: "1.2.3.4",
      userAgent: "HealthLog-iOS/1",
    });

    expect(code.startsWith("hlh_")).toBe(true);
    expect(handoffId).toBe("ho-1");

    const arg = vi.mocked(prisma.oidcNativeHandoff.create).mock.calls[0][0];
    // userId comes from the resolved identity; challenge bound at mint.
    expect(arg.data.userId).toBe("user-1");
    expect(arg.data.codeChallenge).toBe(CHALLENGE);
    // Only the hash is persisted — never the raw code.
    expect(arg.data.codeHash).toBe(`H(${code.length})`);
    expect(JSON.stringify(arg)).not.toContain(code);
    // 90-second TTL.
    const ttl = (arg.data.expiresAt as Date).getTime() - before;
    expect(ttl).toBeGreaterThan(OIDC_NATIVE_HANDOFF_TTL_MS - 2000);
    expect(ttl).toBeLessThanOrEqual(OIDC_NATIVE_HANDOFF_TTL_MS + 100);
  });
});

describe("buildNativeCallbackUrl", () => {
  it("targets the fixed scheme and escapes params", () => {
    const url = buildNativeCallbackUrl({
      code: "hlh_abc",
      methods: "totp,recovery",
    });
    expect(url.startsWith(`${NATIVE_OIDC_REDIRECT_URI}?`)).toBe(true);
    expect(url).toContain("code=hlh_abc");
    // Comma is percent-escaped — no unescaped client value in the Location.
    expect(url).toContain("methods=totp%2Crecovery");
  });

  it("stays on the scheme when no return is named", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://health.example.org");
    expect(buildNativeCallbackUrl({ code: "hlh_abc" })).toBe(
      `${NATIVE_OIDC_REDIRECT_URI}?code=hlh_abc`,
    );
    vi.unstubAllEnvs();
  });
});

describe("the https return", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is a fixed path, not configurable", () => {
    expect(NATIVE_OIDC_RETURN_PATH).toBe("/auth/native-return");
  });

  it("targets the instance's own origin from the operator-set app URL", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://health.example.org");
    expect(
      buildNativeCallbackUrl({ code: "hlh_abc", purgeAt: "x y" }, "https"),
    ).toBe(
      "https://health.example.org/auth/native-return?code=hlh_abc&purgeAt=x+y",
    );
  });

  it("drops any path or query on the app URL and keeps only its origin", () => {
    vi.stubEnv(
      "NEXT_PUBLIC_APP_URL",
      "https://health.example.org/sub/?next=//evil.example",
    );
    expect(nativeHttpsReturnOrigin()).toBe("https://health.example.org");
    expect(buildNativeCallbackUrl({ code: "hlh_abc" }, "https")).toBe(
      "https://health.example.org/auth/native-return?code=hlh_abc",
    );
  });

  it("is unavailable on an instance served over plain http", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://192.168.1.10:3000");
    expect(nativeHttpsReturnOrigin()).toBeNull();
    // A stored https choice the instance can no longer honour falls back to
    // the scheme rather than to an http address.
    expect(buildNativeCallbackUrl({ code: "hlh_abc" }, "https")).toBe(
      `${NATIVE_OIDC_REDIRECT_URI}?code=hlh_abc`,
    );
  });

  it("is unavailable without an app URL, or with an unparseable one", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(nativeHttpsReturnOrigin()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "not a url");
    expect(nativeHttpsReturnOrigin()).toBeNull();
  });
});

describe("consumeNativeHandoff", () => {
  it("returns not_found for an unknown code", async () => {
    vi.mocked(prisma.oidcNativeHandoff.findUnique).mockResolvedValue(
      null as never,
    );
    const res = await consumeNativeHandoff("hlh_" + "x".repeat(43), VERIFIER);
    expect(res.status).toBe("not_found");
    expect(
      vi.mocked(prisma.oidcNativeHandoff.findUnique).mock.calls[0][0],
    ).toMatchObject({ where: { codeHash: "H(47)" } });
  });

  it("replay: a consumed row revokes exactly the issued pair and audits", async () => {
    vi.mocked(prisma.oidcNativeHandoff.findUnique).mockResolvedValue(
      storedRow({
        consumedAt: new Date(),
        issuedRefreshTokenHash: "issued-refresh-hash",
      }) as never,
    );
    const res = await consumeNativeHandoff("hlh_" + "x".repeat(43), VERIFIER);
    expect(res.status).toBe("replayed");
    expect(revokeRefreshTokenByHash).toHaveBeenCalledWith(
      "issued-refresh-hash",
    );
    expect(auditLog).toHaveBeenCalledWith(
      "auth.oidc.native.handoff_replay",
      expect.objectContaining({ userId: "user-1" }),
    );
    // A consumed row is never re-consumed.
    expect(prisma.oidcNativeHandoff.updateMany).not.toHaveBeenCalled();
  });

  it("replay without an issued hash still audits but revokes nothing", async () => {
    vi.mocked(prisma.oidcNativeHandoff.findUnique).mockResolvedValue(
      storedRow({
        consumedAt: new Date(),
        issuedRefreshTokenHash: null,
      }) as never,
    );
    const res = await consumeNativeHandoff("hlh_" + "x".repeat(43), VERIFIER);
    expect(res.status).toBe("replayed");
    expect(revokeRefreshTokenByHash).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledTimes(1);
  });

  it("expired: burns the row (guarded) and never issues", async () => {
    vi.mocked(prisma.oidcNativeHandoff.findUnique).mockResolvedValue(
      storedRow({ expiresAt: new Date(Date.now() - 1000) }) as never,
    );
    vi.mocked(prisma.oidcNativeHandoff.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    const res = await consumeNativeHandoff("hlh_" + "x".repeat(43), VERIFIER);
    expect(res.status).toBe("expired");
    expect(prisma.oidcNativeHandoff.updateMany).toHaveBeenCalledWith({
      where: { id: "ho-1", consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
    expect(revokeRefreshTokenByHash).not.toHaveBeenCalled();
  });

  it("pkce_mismatch: a wrong verifier burns the code", async () => {
    vi.mocked(prisma.oidcNativeHandoff.findUnique).mockResolvedValue(
      storedRow() as never,
    );
    vi.mocked(prisma.oidcNativeHandoff.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    const res = await consumeNativeHandoff(
      "hlh_" + "x".repeat(43),
      "b".repeat(43),
    );
    expect(res.status).toBe("pkce_mismatch");
    // Burned via the guarded update — no issuance.
    expect(prisma.oidcNativeHandoff.updateMany).toHaveBeenCalledWith({
      where: { id: "ho-1", consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it("ok: a live row + correct verifier consumes atomically and returns the identity", async () => {
    vi.mocked(prisma.oidcNativeHandoff.findUnique).mockResolvedValue(
      storedRow() as never,
    );
    vi.mocked(prisma.oidcNativeHandoff.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    const res = await consumeNativeHandoff("hlh_" + "x".repeat(43), VERIFIER);
    expect(res).toEqual({ status: "ok", userId: "user-1", handoffId: "ho-1" });
    expect(prisma.oidcNativeHandoff.updateMany).toHaveBeenCalledWith({
      where: { id: "ho-1", consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it("race_lost: a lost consume returns race_lost and revokes nothing", async () => {
    vi.mocked(prisma.oidcNativeHandoff.findUnique).mockResolvedValue(
      storedRow() as never,
    );
    vi.mocked(prisma.oidcNativeHandoff.updateMany).mockResolvedValue({
      count: 0,
    } as never);
    const res = await consumeNativeHandoff("hlh_" + "x".repeat(43), VERIFIER);
    expect(res.status).toBe("race_lost");
    expect(revokeRefreshTokenByHash).not.toHaveBeenCalled();
  });
});

describe("stampIssuedRefreshToken", () => {
  it("stores the hash of the issued refresh token on the handoff row", async () => {
    vi.mocked(prisma.oidcNativeHandoff.update).mockResolvedValue({} as never);
    await stampIssuedRefreshToken("ho-1", "hlr_secret");
    expect(prisma.oidcNativeHandoff.update).toHaveBeenCalledWith({
      where: { id: "ho-1" },
      data: { issuedRefreshTokenHash: `H(${"hlr_secret".length})` },
    });
  });
});
