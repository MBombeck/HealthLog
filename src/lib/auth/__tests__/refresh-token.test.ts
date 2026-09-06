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
  apiTokens: Array<{
    tokenHash: string;
    revoked: boolean;
    expiresAt: Date | null;
  }>;
} = { refreshTokens: [], apiTokens: [] };

let issuedCounter = 0;

vi.mock("@/lib/db", () => ({
  prisma: {
    /**
     * Stands in for the one raw statement in this module: the access-token
     * sunset, `SET expires_at = LEAST(expires_at, $1) WHERE token_hash = $2`.
     * The parameters arrive in that order. This mock reproduces the minimum,
     * nothing more — the statement itself is exercised against a real
     * PostgreSQL in `tests/integration/refresh-rotation-access-sunset.test.ts`.
     */
    $executeRaw: vi.fn(
      async (
        _sql: TemplateStringsArray,
        sunsetIso: string,
        tokenHash: string,
      ) => {
        const sunsetAt = new Date(sunsetIso);
        let count = 0;
        for (const row of dbState.apiTokens) {
          if (row.tokenHash !== tokenHash || row.revoked) continue;
          if (!row.expiresAt || row.expiresAt.getTime() > sunsetAt.getTime()) {
            row.expiresAt = sunsetAt;
          }
          count++;
        }
        return count;
      },
    ),
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
              string | { in: string[] } | undefined;
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
      const expiresAt = new Date(
        Date.now() + (opts.expiresInDays ?? 1) * 86400000,
      );
      dbState.apiTokens.push({
        tokenHash: `hash:${token}`,
        revoked: false,
        expiresAt,
      });
      return {
        token,
        expiresAt,
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
  ACCESS_TOKEN_SUNSET_MS,
  issueAccessAndRefresh,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeRefreshTokenByHash,
  revokeBearerAccessToken,
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
  // The predecessor of this test asserted the opposite — that rotation flips
  // the old access token to `revoked` on the spot. That instant revoke is the
  // defect: requests already on the wire came back 401 `revoked`, which sends
  // a client into a second rotation with the refresh token it just consumed
  // and costs it the whole family. The token still dies; it dies of expiry, a
  // few seconds later.
  it("rotates: marks old used, issues new pair, sunsets old access token", async () => {
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
    const oldAccess = dbState.apiTokens.find((a) => a.tokenHash === oldHash);
    expect(oldAccess?.revoked).toBe(false);
    expect(oldAccess?.expiresAt?.getTime()).toBeLessThanOrEqual(
      Date.now() + ACCESS_TOKEN_SUNSET_MS,
    );
    expect(oldAccess?.expiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect(dbState.refreshTokens).toHaveLength(2);
  });

  it("rejects + revokes per-device family on reuse of consumed refresh token", async () => {
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
    // the device's replacement family must be revoked too (defence in
    // depth). Per-device scope means dev-1 rows get revoked.
    const replay = await rotateRefreshToken({
      refreshToken: initial.refreshToken,
      policy: NATIVE_POLICY,
      deviceId: "dev-1",
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.reason).toBe("already_used");
    // Every dev-1 refresh row should now be revoked
    const liveDev1 = dbState.refreshTokens.filter(
      (r) => r.revokedAt === null && r.deviceId === "dev-1",
    );
    expect(liveDev1).toHaveLength(0);
  });

  it("v1.4.23 — per-device replay does NOT revoke another device's tokens", async () => {
    // Two-device legitimate scenario: an iPad and an iPhone both
    // refresh independently. A replay attempt on dev-1 must NOT sign
    // dev-2 out — that was the v1.4.22 behaviour the W4 brief
    // explicitly called out as broken.
    const dev1 = await issueAccessAndRefresh({
      userId: "u1",
      policy: NATIVE_POLICY,
      source: "login.password",
      deviceId: "dev-1",
    });
    const dev2 = await issueAccessAndRefresh({
      userId: "u1",
      policy: NATIVE_POLICY,
      source: "login.password",
      deviceId: "dev-2",
    });

    // dev-1 rotates legitimately, then someone replays its stale token.
    await rotateRefreshToken({
      refreshToken: dev1.refreshToken,
      policy: NATIVE_POLICY,
      deviceId: "dev-1",
    });
    const replay = await rotateRefreshToken({
      refreshToken: dev1.refreshToken,
      policy: NATIVE_POLICY,
      deviceId: "dev-1",
    });
    expect(replay.ok).toBe(false);

    // dev-2's refresh token must still be live.
    const dev2Row = dbState.refreshTokens.find(
      (r) => r.tokenHash === `hash:${dev2.refreshToken}`,
    );
    expect(dev2Row?.revokedAt).toBeNull();

    // dev-1's family is dead.
    const liveDev1 = dbState.refreshTokens.filter(
      (r) => r.revokedAt === null && r.deviceId === "dev-1",
    );
    expect(liveDev1).toHaveLength(0);
  });

  it("v1.4.23 — legacy null-deviceId replay still revokes ALL user tokens", async () => {
    // Tokens issued before v1.4.23 carry deviceId === null. We can't
    // safely scope the blast radius — fall back to the conservative
    // user-wide revoke so a stolen pre-1.4.23 token can't bleed across
    // every device the user owns.
    const legacy = await issueAccessAndRefresh({
      userId: "u1",
      policy: NATIVE_POLICY,
      source: "login.password",
      // deviceId omitted → null in DB row
    });
    const dev2 = await issueAccessAndRefresh({
      userId: "u1",
      policy: NATIVE_POLICY,
      source: "login.password",
      deviceId: "dev-2",
    });

    // legacy rotates once, then someone replays it.
    await rotateRefreshToken({
      refreshToken: legacy.refreshToken,
      policy: NATIVE_POLICY,
    });
    const replay = await rotateRefreshToken({
      refreshToken: legacy.refreshToken,
      policy: NATIVE_POLICY,
    });
    expect(replay.ok).toBe(false);

    // dev-2 should ALSO be revoked here — null-deviceId triggers the
    // wide blast radius (safety hatch).
    void dev2;
    const live = dbState.refreshTokens.filter((r) => r.revokedAt === null);
    expect(live).toHaveLength(0);
  });

  it("M-4 — present-but-mismatched deviceId on replay escalates to a USER-WIDE revoke", async () => {
    // Attacker steals dev-1's token and replays it under a fabricated
    // X-Device-Id. The stored row's deviceId (dev-1) must NOT confine the
    // revoke to the attacker's id — escalate to the whole user family so a
    // victim's other device (dev-2) is also revoked.
    const dev1 = await issueAccessAndRefresh({
      userId: "u1",
      policy: NATIVE_POLICY,
      source: "login.password",
      deviceId: "dev-1",
    });
    const dev2 = await issueAccessAndRefresh({
      userId: "u1",
      policy: NATIVE_POLICY,
      source: "login.password",
      deviceId: "dev-2",
    });

    // dev-1 rotates legitimately (same deviceId), then the stale token is
    // replayed under a spoofed deviceId.
    await rotateRefreshToken({
      refreshToken: dev1.refreshToken,
      policy: NATIVE_POLICY,
      deviceId: "dev-1",
    });
    const replay = await rotateRefreshToken({
      refreshToken: dev1.refreshToken,
      policy: NATIVE_POLICY,
      deviceId: "attacker-fabricated-id",
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.reason).toBe("already_used");

    void dev2;
    // Mismatch → wide revoke: NO live refresh row survives for the user.
    const live = dbState.refreshTokens.filter((r) => r.revokedAt === null);
    expect(live).toHaveLength(0);
  });

  it("M-4 — matching presented deviceId keeps the per-device scope (dev-2 survives)", async () => {
    const dev1 = await issueAccessAndRefresh({
      userId: "u1",
      policy: NATIVE_POLICY,
      source: "login.password",
      deviceId: "dev-1",
    });
    const dev2 = await issueAccessAndRefresh({
      userId: "u1",
      policy: NATIVE_POLICY,
      source: "login.password",
      deviceId: "dev-2",
    });

    await rotateRefreshToken({
      refreshToken: dev1.refreshToken,
      policy: NATIVE_POLICY,
      deviceId: "dev-1",
    });
    const replay = await rotateRefreshToken({
      refreshToken: dev1.refreshToken,
      policy: NATIVE_POLICY,
      deviceId: "dev-1",
    });
    expect(replay.ok).toBe(false);

    // dev-2 still live — matched deviceId keeps the narrow scope.
    const dev2Row = dbState.refreshTokens.find(
      (r) => r.tokenHash === `hash:${dev2.refreshToken}`,
    );
    expect(dev2Row?.revokedAt).toBeNull();
    const liveDev1 = dbState.refreshTokens.filter(
      (r) => r.revokedAt === null && r.deviceId === "dev-1",
    );
    expect(liveDev1).toHaveLength(0);
  });

  it("rejects an expired refresh token by its own secret", async () => {
    // The token presented here is the REAL one, so the row is found and the
    // expiry branch is what refuses it. Presenting an unknown string instead
    // would pass on `not_found` and prove nothing about expiry at all.
    const initial = await issueAccessAndRefresh({
      userId: "u1",
      policy: NATIVE_POLICY,
      source: "login.password",
    });
    dbState.refreshTokens[0].expiresAt = new Date(Date.now() - 1000);

    const result = await rotateRefreshToken({
      refreshToken: initial.refreshToken,
      policy: NATIVE_POLICY,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("expired");
    // An expired token must not mint a replacement pair.
    expect(dbState.refreshTokens).toHaveLength(1);
  });

  it("accepts the same token one millisecond before it expires", async () => {
    // Boundary companion: proves the expiry refusal above is driven by the
    // clock and not by the rotation path refusing everything.
    const initial = await issueAccessAndRefresh({
      userId: "u1",
      policy: NATIVE_POLICY,
      source: "login.password",
    });
    dbState.refreshTokens[0].expiresAt = new Date(Date.now() + 60_000);

    const result = await rotateRefreshToken({
      refreshToken: initial.refreshToken,
      policy: NATIVE_POLICY,
    });

    expect(result.ok).toBe(true);
  });

  it("refuses a live token presented under a different device id", async () => {
    // Device A's token replayed from device B. The token is valid and unused,
    // so only the device binding can refuse it.
    const dev1 = await issueAccessAndRefresh({
      userId: "u1",
      policy: NATIVE_POLICY,
      source: "login.password",
      deviceId: "dev-1",
    });

    const result = await rotateRefreshToken({
      refreshToken: dev1.refreshToken,
      policy: NATIVE_POLICY,
      deviceId: "dev-2",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("device_mismatch");
    // Refused, not consumed: the legitimate device can still rotate it.
    expect(dbState.refreshTokens[0].usedAt).toBeNull();
    expect(dbState.refreshTokens).toHaveLength(1);

    const legitimate = await rotateRefreshToken({
      refreshToken: dev1.refreshToken,
      policy: NATIVE_POLICY,
      deviceId: "dev-1",
    });
    expect(legitimate.ok).toBe(true);
  });

  it("still rotates when the caller sends no device id at all", async () => {
    // An older client that never sends `X-Device-Id` must not be locked out
    // by the device binding — a presented null is unattributable, not a
    // mismatch.
    const dev1 = await issueAccessAndRefresh({
      userId: "u1",
      policy: NATIVE_POLICY,
      source: "login.password",
      deviceId: "dev-1",
    });

    const result = await rotateRefreshToken({
      refreshToken: dev1.refreshToken,
      policy: NATIVE_POLICY,
    });

    expect(result.ok).toBe(true);
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

describe("revokeBearerAccessToken (M-2 logout bearer revoke)", () => {
  it("revokes the ApiToken and its paired refresh sibling", async () => {
    const bundle = await issueAccessAndRefresh({
      userId: "u1",
      policy: NATIVE_POLICY,
      source: "login.password",
      deviceId: "dev-1",
    });
    const accessHash = `hash:${bundle.accessToken}`;
    expect(
      dbState.apiTokens.find((a) => a.tokenHash === accessHash)?.revoked,
    ).toBe(false);
    const refreshRow = dbState.refreshTokens.find(
      (r) => r.accessTokenHash === accessHash,
    );
    expect(refreshRow?.revokedAt).toBeNull();

    const ok = await revokeBearerAccessToken(bundle.accessToken);
    expect(ok).toBe(true);

    expect(
      dbState.apiTokens.find((a) => a.tokenHash === accessHash)?.revoked,
    ).toBe(true);
    expect(
      dbState.refreshTokens.find((r) => r.accessTokenHash === accessHash)
        ?.revokedAt,
    ).not.toBeNull();
  });

  it("returns false when no live ApiToken matches the token", async () => {
    const ok = await revokeBearerAccessToken("hlk_unknown_token");
    expect(ok).toBe(false);
  });
});

describe("revokeRefreshTokenByHash (native OIDC handoff replay containment)", () => {
  it("revokes the refresh row + its paired access token by stored hash", async () => {
    const bundle = await issueAccessAndRefresh({
      userId: "u1",
      policy: NATIVE_POLICY,
      source: "login.oidc.native",
      deviceId: "dev-1",
    });
    const refreshHash = `hash:${bundle.refreshToken}`;
    const accessHash = `hash:${bundle.accessToken}`;

    // The handoff row only ever stored the HASH of the refresh token, never
    // the raw secret — so replay containment must revoke by hash.
    const ok = await revokeRefreshTokenByHash(refreshHash);
    expect(ok).toBe(true);

    expect(
      dbState.refreshTokens.find((r) => r.tokenHash === refreshHash)?.revokedAt,
    ).not.toBeNull();
    expect(
      dbState.apiTokens.find((a) => a.tokenHash === accessHash)?.revoked,
    ).toBe(true);
  });

  it("returns false for an unknown or already-revoked hash", async () => {
    expect(await revokeRefreshTokenByHash("hash:hlr_unknown")).toBe(false);

    const bundle = await issueAccessAndRefresh({
      userId: "u1",
      policy: NATIVE_POLICY,
      source: "login.oidc.native",
    });
    const refreshHash = `hash:${bundle.refreshToken}`;
    await revokeRefreshTokenByHash(refreshHash);
    // Second call is a no-op (idempotent containment).
    expect(await revokeRefreshTokenByHash(refreshHash)).toBe(false);
  });
});
