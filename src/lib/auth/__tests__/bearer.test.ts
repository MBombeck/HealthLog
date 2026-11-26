import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: { findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: vi.fn() }));

import { resolveBearerToken, BearerAuthError } from "../bearer";
import type { ScopeRequirement } from "../bearer";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/auth/hmac";
import {
  resetTokenLastUsedThrottle,
  stampTokenLastUsed,
  TOKEN_LAST_USED_INTERVAL_MS,
} from "../token-last-used";

const FAKE_HASH = "deadbeefcafef00d";
const RAW_TOKEN = "hlk_" + "a".repeat(64);
const FAKE_USER = { id: "user-1", role: "USER" };

/** The REST default: cookie sessions and `["*"]` tokens only. */
const WILDCARD_ONLY: ScopeRequirement = { kind: "wildcard-only" };
/** The `/mcp` posture: authenticate here, authorise downstream. */
const ANY_VALID: ScopeRequirement = { kind: "any-valid-token" };
const scope = (s: string): ScopeRequirement => ({ kind: "scope", scope: s });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hashToken).mockReturnValue(FAKE_HASH);
  vi.mocked(prisma.apiToken.update).mockResolvedValue({} as never);
  resetTokenLastUsedThrottle();
});

describe("resolveBearerToken", () => {
  it("looks the token up by HMAC hash, never the plaintext", async () => {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      permissions: ["*"],
      revoked: false,
      expiresAt: new Date(Date.now() + 86_400_000),
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(FAKE_USER as never);

    const res = await resolveBearerToken(RAW_TOKEN, WILDCARD_ONLY);

    expect(hashToken).toHaveBeenCalledWith(RAW_TOKEN);
    expect(prisma.apiToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: FAKE_HASH } }),
    );
    expect(res.user.id).toBe("user-1");
    expect(res.tokenId).toBe("token-1");
    expect(res.permissions).toEqual(["*"]);
    expect(prisma.apiToken.update).toHaveBeenCalledWith({
      where: { id: "token-1" },
      data: { lastUsedAt: expect.any(Date) },
    });

    // The rest of an app-open burst on the same token writes nothing more.
    await Promise.all(
      Array.from({ length: 29 }, () =>
        resolveBearerToken(RAW_TOKEN, WILDCARD_ONLY),
      ),
    );
    expect(prisma.apiToken.update).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown token (401)", async () => {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue(null as never);
    await expect(
      resolveBearerToken(RAW_TOKEN, WILDCARD_ONLY),
    ).rejects.toMatchObject({
      statusCode: 401,
      reason: "unknown_token",
    } satisfies Partial<BearerAuthError>);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a revoked token (401)", async () => {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-2",
      userId: "user-1",
      permissions: [],
      revoked: true,
      expiresAt: null,
    } as never);
    await expect(
      resolveBearerToken(RAW_TOKEN, WILDCARD_ONLY),
    ).rejects.toMatchObject({
      statusCode: 401,
      reason: "revoked",
    });
  });

  it("rejects an expired token (401)", async () => {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-3",
      userId: "user-1",
      permissions: [],
      revoked: false,
      expiresAt: new Date(Date.now() - 60_000),
    } as never);
    await expect(
      resolveBearerToken(RAW_TOKEN, WILDCARD_ONLY),
    ).rejects.toMatchObject({
      statusCode: 401,
      reason: "expired",
    });
  });

  it("rejects a narrow-scope token missing the required permission (403)", async () => {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-4",
      userId: "user-1",
      permissions: ["something:else"],
      revoked: false,
      expiresAt: null,
    } as never);
    await expect(
      resolveBearerToken(RAW_TOKEN, scope("health:write")),
    ).rejects.toMatchObject({
      statusCode: 403,
      reason: "insufficient_permissions",
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  // The inversion. A narrow token used to be admitted by every route that
  // named no scope — 324 of them — which is how a token minted for medication
  // intake reached the full-backup export. `wildcard-only` is now the default
  // arm, so the safe outcome is the one a route gets by doing nothing.
  it("refuses a narrow-scope token under the wildcard-only default (403)", async () => {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-5",
      userId: "user-1",
      permissions: ["medication:ingest"],
      revoked: false,
      expiresAt: null,
    } as never);
    await expect(
      resolveBearerToken(RAW_TOKEN, WILDCARD_ONLY),
    ).rejects.toMatchObject({
      statusCode: 403,
      reason: "undeclared_scope",
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("admits a narrow-scope token for the scope it lists", async () => {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-5b",
      userId: "user-1",
      permissions: ["fhir:read"],
      revoked: false,
      expiresAt: null,
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(FAKE_USER as never);
    const res = await resolveBearerToken(RAW_TOKEN, scope("fhir:read"));
    expect(res.user.id).toBe("user-1");
  });

  it("admits any valid token under the any-valid-token posture", async () => {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-5c",
      userId: "user-1",
      permissions: ["health:read"],
      revoked: false,
      expiresAt: null,
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(FAKE_USER as never);
    const res = await resolveBearerToken(RAW_TOKEN, ANY_VALID);
    expect(res.user.id).toBe("user-1");
  });

  it("admits a wildcard token under the wildcard-only default", async () => {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-5d",
      userId: "user-1",
      permissions: ["*"],
      revoked: false,
      expiresAt: null,
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(FAKE_USER as never);
    const res = await resolveBearerToken(RAW_TOKEN, WILDCARD_ONLY);
    expect(res.user.id).toBe("user-1");
  });

  it("admits a wildcard token for any required permission", async () => {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-6",
      userId: "user-1",
      permissions: ["*"],
      revoked: false,
      expiresAt: null,
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(FAKE_USER as never);
    const res = await resolveBearerToken(RAW_TOKEN, scope("health:write"));
    expect(res.user.id).toBe("user-1");
  });
});

// A native client opens with a few dozen requests on one token at once. One
// UPDATE per request queued them all on the token row's lock, each holding a
// pooled connection while it waited.
describe("lastUsedAt refresh under a burst", () => {
  it("writes again once the interval has passed, and per token", () => {
    const t0 = 1_800_000_000_000;
    stampTokenLastUsed("token-1", t0);
    stampTokenLastUsed("token-1", t0 + TOKEN_LAST_USED_INTERVAL_MS - 1);
    stampTokenLastUsed("token-2", t0 + 1);
    expect(prisma.apiToken.update).toHaveBeenCalledTimes(2);

    stampTokenLastUsed("token-1", t0 + TOKEN_LAST_USED_INTERVAL_MS);
    expect(prisma.apiToken.update).toHaveBeenCalledTimes(3);
    expect(prisma.apiToken.update).toHaveBeenLastCalledWith({
      where: { id: "token-1" },
      data: { lastUsedAt: new Date(t0 + TOKEN_LAST_USED_INTERVAL_MS) },
    });
  });

  it("never fails the request when the write cannot even be built", async () => {
    vi.mocked(prisma.apiToken.update).mockImplementation(() => {
      throw new Error("client gone");
    });
    expect(() => stampTokenLastUsed("token-1")).not.toThrow();
  });
});
