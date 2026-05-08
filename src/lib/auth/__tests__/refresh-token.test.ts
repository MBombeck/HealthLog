import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma + the underlying issueApiToken so we can assert flow
// without spinning up a database.
const dbState: {
  refreshTokens: Array<{
    id: string;
    userId: string;
    tokenHash: string;
    deviceId: string | null;
    accessTokenHash: string | null;
    expiresAt: Date;
    revokedAt: Date | null;
    usedAt: Date | null;
    replacedById: string | null;
    userAgent: string | null;
    ipAddress: string | null;
    createdAt: Date;
  }>;
  apiTokens: Array<{ tokenHash: string; revoked: boolean }>;
} = { refreshTokens: [], apiTokens: [] };

let issuedCounter = 0;

vi.mock("@/lib/db", () => ({
  prisma: {
    refreshToken: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `rt_${++issuedCounter}`,
          createdAt: new Date(),
          revokedAt: null,
          usedAt: null,
          replacedById: null,
          userAgent: null,
          ipAddress: null,
          deviceId: null,
          accessTokenHash: null,
          ...data,
        } as (typeof dbState.refreshTokens)[number];
        dbState.refreshTokens.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => {
        return (
          dbState.refreshTokens.find((r) => r.tokenHash === where.tokenHash) ??
          null
        );
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return dbState.refreshTokens.filter((r) =>
          Object.entries(where).every(
            ([k, v]) => (r as unknown as Record<string, unknown>)[k] === v,
          ),
        );
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          let count = 0;
          for (const row of dbState.refreshTokens) {
            const matches = Object.entries(where).every(
              ([k, v]) => (row as unknown as Record<string, unknown>)[k] === v,
            );
            if (matches) {
              Object.assign(row, data);
              count++;
            }
          }
          return { count };
        },
      ),
    },
    apiToken: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          let count = 0;
          for (const row of dbState.apiTokens) {
            const tokenHashFilter = where.tokenHash as
              | string
              | { in: string[] }
              | undefined;
            const matches =
              !tokenHashFilter ||
              (typeof tokenHashFilter === "string"
                ? row.tokenHash === tokenHashFilter
                : tokenHashFilter.in.includes(row.tokenHash));
            if (matches) {
              Object.assign(row, data);
              count++;
            }
          }
          return { count };
        },
      ),
    },
  },
}));

vi.mock("@/lib/auth/issue-token", () => ({
  issueApiToken: vi.fn(
    async (opts: { userId: string; expiresInDays?: number }) => {
      issuedCounter++;
      const token = `hlk_token_${issuedCounter}`;
      dbState.apiTokens.push({
        tokenHash: `hash:${token}`,
        revoked: false,
      });
      return {
        token,
        expiresAt: new Date(Date.now() + (opts.expiresInDays ?? 1) * 86400000),
        tokenId: `t_${issuedCounter}`,
        name: "test",
      };
    },
  ),
}));

vi.mock("@/lib/auth/hmac", () => ({
  hashToken: (raw: string) => `hash:${raw}`,
}));

import {
  issueAccessAndRefresh,
  rotateRefreshToken,
  revokeRefreshToken,
} from "../refresh-token";
import type { TokenPolicyDecision } from "../native-client";

const NATIVE_POLICY: TokenPolicyDecision = {
  policy: "native",
  accessTokenDays: 1,
  refreshTokenDays: 60,
  tokenLabel: "native",
};

beforeEach(() => {
  dbState.refreshTokens = [];
  dbState.apiTokens = [];
  issuedCounter = 0;
});

describe("issueAccessAndRefresh", () => {
  it("creates an ApiToken + RefreshToken row paired by hash", async () => {
    const bundle = await issueAccessAndRefresh({
      userId: "u1",
      policy: NATIVE_POLICY,
      source: "login.password",
    });
    expect(bundle.accessToken).toMatch(/^hlk_token_/);
    expect(bundle.refreshToken).toMatch(/^hlr_/);
    expect(dbState.refreshTokens).toHaveLength(1);
    expect(dbState.refreshTokens[0].accessTokenHash).toBe(
      `hash:${bundle.accessToken}`,
    );
  });

  it("throws if called for web policy (no refresh token)", async () => {
    await expect(
      issueAccessAndRefresh({
        userId: "u1",
        policy: { ...NATIVE_POLICY, refreshTokenDays: null, policy: "web" },
        source: "login.password",
      }),
    ).rejects.toThrow(/web policy/);
  });
});

describe("rotateRefreshToken", () => {
  it("rotates: marks old used, issues new pair, revokes old access token", async () => {
    const initial = await issueAccessAndRefresh({
      userId: "u1",
      policy: NATIVE_POLICY,
      source: "login.password",
    });
    const oldHash = `hash:${initial.accessToken}`;
    expect(
      dbState.apiTokens.find((a) => a.tokenHash === oldHash)?.revoked,
    ).toBe(false);

    const result = await rotateRefreshToken({
      refreshToken: initial.refreshToken,
      policy: NATIVE_POLICY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const oldRow = dbState.refreshTokens[0];
    expect(oldRow.usedAt).not.toBeNull();
    expect(oldRow.replacedById).not.toBeNull();
    expect(
      dbState.apiTokens.find((a) => a.tokenHash === oldHash)?.revoked,
    ).toBe(true);
    expect(dbState.refreshTokens).toHaveLength(2);
  });

  it("rejects + revokes family on reuse of consumed refresh token", async () => {
    const initial = await issueAccessAndRefresh({
      userId: "u1",
      policy: NATIVE_POLICY,
      source: "login.password",
      deviceId: "dev-1",
    });
    const first = await rotateRefreshToken({
      refreshToken: initial.refreshToken,
      policy: NATIVE_POLICY,
      deviceId: "dev-1",
    });
    expect(first.ok).toBe(true);

    // Replay the original token — must be rejected as `already_used` AND
    // the replacement family must be revoked too (defence in depth).
    const replay = await rotateRefreshToken({
      refreshToken: initial.refreshToken,
      policy: NATIVE_POLICY,
      deviceId: "dev-1",
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.reason).toBe("already_used");
    // All non-revoked refresh rows should now be revoked
    const live = dbState.refreshTokens.filter((r) => r.revokedAt === null);
    expect(live).toHaveLength(0);
  });

  it("rejects expired refresh tokens", async () => {
    await issueAccessAndRefresh({
      userId: "u1",
      policy: NATIVE_POLICY,
      source: "login.password",
    });
    // Manually expire
    dbState.refreshTokens[0].expiresAt = new Date(Date.now() - 1000);
    const result = await rotateRefreshToken({
      refreshToken: "hlr_doesnt_matter",
      policy: NATIVE_POLICY,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
  });

  it("rejects revoked refresh tokens", async () => {
    const initial = await issueAccessAndRefresh({
      userId: "u1",
      policy: NATIVE_POLICY,
      source: "login.password",
    });
    await revokeRefreshToken(initial.refreshToken);
    const result = await rotateRefreshToken({
      refreshToken: initial.refreshToken,
      policy: NATIVE_POLICY,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("revoked");
  });
});
